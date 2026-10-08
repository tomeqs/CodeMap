'use strict';

// The extension end to end against a mocked VS Code API and the real bundled analyzer
// (run `npm run prepare-assets` first). Uses the Shop sample from the repository.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createMock, fakeContext, installMock, Uri } = require('./vscode-mock');

const extensionPath = path.resolve(__dirname, '..', '..');
const shop = path.resolve(extensionPath, '..', 'samples', 'Shop');
const solution = path.join(shop, 'Shop.sln');
const bundled = fs.existsSync(path.join(extensionPath, 'analyzer', 'codemap.dll')) && fs.existsSync(path.join(extensionPath, 'media', 'viewer.html'));

const until = async (condition, ms = 120000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('opens the map, jumps between code and map, refreshes on save', { skip: !bundled && 'run npm run prepare-assets first', timeout: 300000 }, async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-storage-'));
  const { vscode, log, saveEmitter } = createMock({ workspaceRoot: shop, settings: { gitHistory: false }, files: [solution] });
  const restore = installMock(vscode);
  try {
    const extension = require('../../src/extension');
    const context = fakeContext(extensionPath, storage);
    const { controller } = extension.activate(context);
    const manifest = require('../../package.json');
    for (const { command } of manifest.contributes.commands) assert.ok(log.commands.has(command), `${command} is registered`);

    // open: the only solution in the workspace is picked, the webview gets the CSP'd viewer
    const opening = log.commands.get('codemap.open')();
    await until(() => log.panels.length === 1);
    const panel = log.panels[0];
    assert.match(panel.webview.html, /Content-Security-Policy/);
    assert.equal(panel.options.enableScripts, true);
    panel.receive({ type: 'ready' }); // the viewer says hello
    await opening;
    const load = log.posted.find((m) => m.type === 'load');
    assert.ok(load, 'graph sent to the webview');
    assert.equal(load.doc.source.path, solution);
    assert.ok(load.doc.nodes.some((n) => n.id === 'T:Shop.Domain.Orders.Order'));
    await until(() => fs.existsSync(path.join(storage, 'map.codemap.json')), 5000); // cached for the next start (written in the background)

    // map → code
    panel.receive({ type: 'openFile', file: 'src/Shop.Domain/Orders/Order.cs', line: 25 });
    await until(() => log.opened.length === 1);
    assert.equal(log.opened[0].file, path.join(shop, 'src', 'Shop.Domain', 'Orders', 'Order.cs'));
    assert.equal(log.opened[0].options.selection.start.line, 24);
    panel.receive({ type: 'openFile', file: '../../etc/passwd', line: 1 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(log.opened.length, 1, 'paths outside the solution are refused');

    // code → map: the cursor in Order.AddLine
    const orderFile = path.join(shop, 'src', 'Shop.Domain', 'Orders', 'Order.cs');
    const addLine = fs.readFileSync(orderFile, 'utf8').split('\n').findIndex((l) => l.includes('public void AddLine'));
    vscode.window.activeTextEditor = { document: { uri: Uri.file(orderFile) }, selection: { active: { line: addLine + 1 } } };
    await log.commands.get('codemap.revealInMap')();
    assert.deepEqual(log.posted.at(-1), { type: 'reveal', id: 'M:Shop.Domain.Orders.Order.AddLine(Shop.Domain.Catalog.Product,System.Int32)' });

    await log.commands.get('codemap.callFlow')();
    assert.deepEqual(log.posted.at(-1), { type: 'flow', ids: ['M:Shop.Domain.Orders.Order.AddLine(Shop.Domain.Catalog.Product,System.Int32)'], sequence: true });

    // clipboard and save requests from the viewer
    panel.receive({ type: 'copy', text: 'sequenceDiagram' });
    panel.receive({ type: 'save', name: '../evil/name.mmd', content: 'sequenceDiagram' });
    await until(() => log.saved.length === 1);
    assert.deepEqual(log.clipboard, ['sequenceDiagram']);
    assert.equal(log.saved[0].file, path.join(shop, 'name.mmd'), 'only the file name is used');

    // live: saving a C# file analyzes again and sends a "preserve" update
    const loads = () => log.posted.filter((m) => m.type === 'load').length;
    const before = loads();
    saveEmitter.fire({ uri: Uri.file(orderFile) });
    saveEmitter.fire({ uri: Uri.file(path.join(shop, 'README.md')) }); // not code: ignored
    await until(() => loads() === before + 1);
    assert.equal(log.posted.filter((m) => m.type === 'load').at(-1).preserve, true);

    // the webview cannot show the map (no WebGL): the error says so, and the map opens in the browser instead
    panel.receive({ type: 'fatal', message: 'The 3D map needs WebGL 2, which is not available here.', webgl: true });
    await until(() => log.errors.some((e) => e.includes('WebGL 2')));
    await log.commands.get('codemap.openInBrowser')();
    assert.equal(log.external.length, 1);
    const html = fs.readFileSync(log.external[0], 'utf8');
    assert.match(html, /<title>CodeMap · Shop<\/title>/);
    assert.ok(html.includes('"T:Shop.Domain.Orders.Order"'), 'the graph is inside the page');

    // closing the panel stops everything
    panel.dispose();
    assert.equal(controller.panel, null);
  } finally {
    restore();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('a failing analyzer shows the error instead of a map', { timeout: 60000 }, async () => {
  const { vscode, log } = createMock({ workspaceRoot: shop, settings: { analyzerPath: '/nonexistent/codemap' }, files: [solution] });
  const restore = installMock(vscode);
  const fakeExtension = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ext-'));
  fs.mkdirSync(path.join(fakeExtension, 'media'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'viewer.html'), path.join(fakeExtension, 'media', 'viewer.html'));
  try {
    const { activate } = require('../../src/extension');
    activate(fakeContext(fakeExtension));
    const opening = log.commands.get('codemap.open')();
    await until(() => log.panels.length === 1);
    log.panels[0].receive({ type: 'ready' });
    await opening;
    assert.ok(log.posted.some((m) => m.type === 'error' && /could not start/.test(m.message)));
    assert.match(log.errors[0], /CodeMap: CodeMap could not start "\/nonexistent\/codemap"/);
  } finally {
    restore();
    fs.rmSync(fakeExtension, { recursive: true, force: true });
  }
});

test('asks which solution when there are several', async () => {
  const other = path.join(shop, 'Other.sln');
  const { vscode, log } = createMock({ workspaceRoot: shop, files: [path.join(shop, 'deep', 'nested', 'X.sln'), solution, other] });
  const restore = installMock(vscode);
  try {
    const { CodeMapController } = require('../../src/extension');
    const controller = new CodeMapController(fakeContext(extensionPath));
    const target = await controller.pickTarget();
    assert.equal(target, other); // the mock picks the first item: shallowest first, then by name
    assert.deepEqual(log.quickPicks[0].slice(0, 3).map((i) => i.label), ['Other.sln', 'Shop.sln', 'X.sln']);
    assert.match(log.quickPicks[0].at(-1).label, /folder/);
  } finally {
    restore();
  }
});
