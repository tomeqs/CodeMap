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

    // the webview starts again (reloaded after a GPU reset): it gets the graph again
    const loadsBefore = log.posted.filter((m) => m.type === 'load').length;
    panel.receive({ type: 'ready', renderer: 'webgpu', adapter: 'test GPU', layout: 'worker' });
    await until(() => log.posted.filter((m) => m.type === 'load').length === loadsBefore + 1, 5000);
    assert.deepEqual(controller.mapInfo, { renderer: 'webgpu', adapter: 'test GPU', layout: 'worker' });

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

    // the map hidden behind the code: it comes back beside it, pinned (a preview tab would be replaced), focus back on the code
    panel.visible = false;
    await log.commands.get('codemap.callFlow')();
    assert.deepEqual(panel.revealed.at(-1), { column: vscode.ViewColumn.Beside, preserveFocus: false });
    assert.deepEqual(log.executed, ['workbench.action.keepEditor']);
    assert.equal(log.opened.at(-1).file, orderFile, 'focus back on the code');
    assert.deepEqual(log.posted.at(-1), { type: 'flow', ids: ['M:Shop.Domain.Orders.Order.AddLine(Shop.Domain.Catalog.Product,System.Int32)'], sequence: true });

    // clipboard and save requests from the viewer
    panel.receive({ type: 'copy', text: 'sequenceDiagram' });
    panel.receive({ type: 'save', name: '../evil/name.mmd', content: 'sequenceDiagram' });
    await until(() => log.saved.length === 1);
    assert.deepEqual(log.clipboard, ['sequenceDiagram']);
    assert.equal(log.saved[0].file, path.join(shop, 'name.mmd'), 'only the file name is used');

    // live: saving a C# file analyzes again; a save that changed nothing the map shows leaves the map as it is…
    const loads = () => log.posted.filter((m) => m.type === 'load').length;
    const before = loads();
    saveEmitter.fire({ uri: Uri.file(orderFile) });
    saveEmitter.fire({ uri: Uri.file(path.join(shop, 'README.md')) }); // not code: ignored
    await until(() => controller.output.lines.includes('The map is up to date.'));
    assert.equal(loads(), before, 'the same graph is not loaded again');
    assert.deepEqual(log.posted.at(-1), { type: 'status', text: null });
    // …and when the graph is another one (here: the map shows an older one), it gets a "preserve" update
    controller.docKey = 'an older graph';
    saveEmitter.fire({ uri: Uri.file(orderFile) });
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

test('C# and TypeScript in one workspace: the whole folder comes first', async () => {
  const web = path.join(shop, 'web');
  const files = [solution, path.join(web, 'package.json'), path.join(web, 'src', 'app.ts'), path.join(web, 'node_modules', 'x', 'index.js')];
  const { vscode, log } = createMock({ workspaceRoot: shop, files });
  const restore = installMock(vscode);
  try {
    const { CodeMapController } = require('../../src/extension');
    const controller = new CodeMapController(fakeContext(extensionPath));
    assert.equal(await controller.pickTarget(), shop); // the mock picks the first item
    assert.match(log.quickPicks[0][0].label, /folder/);
    assert.match(log.quickPicks[0][0].description, /C# and TypeScript/);
    assert.deepEqual(log.quickPicks[0].slice(1).map((i) => i.label), ['Shop.sln']);
  } finally {
    restore();
  }
});

test('TypeScript alone: the folder, without asking', async () => {
  const files = [path.join(shop, 'package.json'), path.join(shop, 'src', 'main.ts')];
  const { vscode, log } = createMock({ workspaceRoot: shop, files });
  const restore = installMock(vscode);
  try {
    const { CodeMapController } = require('../../src/extension');
    assert.equal(await new CodeMapController(fakeContext(extensionPath)).pickTarget(), shop);
    assert.equal(log.quickPicks.length, 0);
  } finally {
    restore();
  }
});

test('a package.json without TypeScript or JavaScript next to it does not make a solution mixed', async () => {
  const files = [solution, path.join(shop, 'package.json'), path.join(shop, 'types', 'env.d.ts'), path.join(shop, 'dist', 'app.js')];
  const { vscode, log } = createMock({ workspaceRoot: shop, files });
  const restore = installMock(vscode);
  try {
    const { CodeMapController } = require('../../src/extension');
    assert.equal(await new CodeMapController(fakeContext(extensionPath)).pickTarget(), solution);
    assert.equal(log.quickPicks.length, 0);
  } finally {
    restore();
  }
});

test('live updates follow C# and TypeScript / JavaScript sources and their project files', () => {
  const { isSourceFile } = require('../../src/extension');
  // paths inside the analyzed folder: wherever that folder is (~/bin/repo too), only its own folders count
  for (const file of ['A.cs', 'src/A.csproj', 'Directory.Build.props', 'X.slnx', 'web/src/app.ts', 'web/App.tsx', 'a.mjs', 'a.cjs', 'bin-tools/src/a.ts',
    'web/package.json', 'web/tsconfig.json', 'web/tsconfig.app.json', 'web\\jsconfig.json']) {
    assert.ok(isSourceFile(file), file);
  }

  for (const file of ['web/types.d.ts', 'web/vendor.min.js', 'web/node_modules/x/index.js', 'node_modules/x/index.js', 'web/dist/main.js', 'A/bin/Debug/x.cs',
    'A\\obj\\x.cs', 'web/package-lock.json', 'web/angular.json', 'README.md', 'web/styles.css']) {
    assert.ok(!isSourceFile(file), file);
  }
});

test('live updates follow Python sources and project files, not environments or caches', () => {
  const { isSourceFile } = require('../../src/extension');
  for (const file of ['app/main.py', 'pyproject.toml', 'api/setup.cfg', 'Pipfile', 'requirements.txt', 'requirements-dev.txt', 'apps\\api\\deps.py']) {
    assert.ok(isSourceFile(file), file);
  }

  for (const file of ['app/__pycache__/main.py', '.venv/lib/x.py', 'venv/lib/site.py', 'lib/site-packages/x.py', 'pkg.egg-info/x.py', '.tox/py/x.py', 'poetry.lock', 'setup.py.orig']) {
    assert.ok(!isSourceFile(file), file);
  }
});

// ------------------------------------------------------------------ with a stand-in analyzer

/** The extension with an analyzer that returns what the test says (and counts how many run at once). */
function withAnalyzer({ root, settings = {}, python } = {}) {
  const mock = createMock({ workspaceRoot: root, settings: { gitHistory: false, ...settings }, files: [] });
  const restore = installMock(mock.vscode);
  const fakeExtension = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ext-'));
  fs.mkdirSync(path.join(fakeExtension, 'media'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'viewer.html'), path.join(fakeExtension, 'media', 'viewer.html'));
  const runs = { count: 0, active: 0, most: 0, next: [], wait: null };
  const analyzer = require('../../src/analyzer');
  analyzer.resolveAnalyzer = () => ({ label: 'test analyzer' });
  analyzer.runAnalyzer = async (_analyzer, target) => {
    runs.count++;
    runs.most = Math.max(runs.most, ++runs.active);
    try {
      if (runs.wait) await runs.wait;
      const doc = runs.next.shift() ?? runs.doc;
      return { ...doc, generatedAt: new Date(Date.now() + runs.count).toISOString(), source: { path: target, root, name: 'test', ...doc?.source } };
    } finally {
      runs.active--;
    }
  };
  const { CodeMapController } = require('../../src/extension');
  const context = fakeContext(fakeExtension);
  const { controller } = require('../../src/extension').activate(context);
  if (python) controller.python = python;
  const done = () => {
    restore();
    fs.rmSync(fakeExtension, { recursive: true, force: true });
  };
  return { ...mock, controller, context, runs, done, CodeMapController };
}

const graph = (...files) => ({ format: 'codemap', nodes: files.map((file, i) => ({ id: `n${i}`, location: { file, line: 1 } })), edges: [] });

test('one analysis at a time, also while the Python interpreter is still being found', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ws-'));
  // The first look-up takes a while (the Python extension is starting); later ones answer at once.
  let found;
  const python = { current: () => (found ? Promise.resolve('/usr/bin/python3') : new Promise((resolve) => (found = resolve))), onDidChange: () => ({ dispose() {} }) };
  const { controller, context, runs, log, done } = withAnalyzer({ root, python });
  try {
    await context.workspaceState.update('codemap.target', root);
    controller.createPanel(1);
    log.panels[0].receive({ type: 'ready' });
    runs.doc = graph('a.py');
    const first = controller.analyze();
    const second = controller.analyze({ preserve: true }); // a save or Refresh while the interpreter is looked up
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runs.count, 0, 'still looking for the interpreter');
    found('/usr/bin/python3');
    await Promise.all([first, second]);
    await until(() => runs.count === 2 && !controller.running, 5000); // the second one waited for the first
    assert.equal(runs.most, 1, 'never two analyzers at once');
    assert.equal(log.posted.filter((m) => m.type === 'load').length, 1, 'and its (same) graph is not loaded twice');
  } finally {
    done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a graph that arrives before the map is ready keeps its place before what was asked of the map', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ws-'));
  const { controller, log, done } = withAnalyzer({ root });
  try {
    controller.createPanel(1);
    controller.send({ type: 'load', doc: { n: 1 } }); // the cached map
    controller.send({ type: 'status', text: 'Updating the map…' });
    controller.send({ type: 'reveal', id: 'T:A' }); // Show in Code Map, before the webview has started
    controller.send({ type: 'load', doc: { n: 2 } }); // the fresh analysis
    assert.deepEqual(controller.queue.map((m) => m.type), ['load', 'status', 'reveal']);
    assert.equal(controller.queue[0].doc.n, 2, 'the newest graph, where the first one was');
    assert.equal(log.posted.length, 0);
  } finally {
    done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live updates follow folders and renames, and a save during the first analysis', { timeout: 30000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ws-')));
  const write = (file, text = '') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('src/orders/order.py', 'class Order: ...\n');
  write('docs/notes.md', 'notes\n');
  write('node_modules/x/index.js', '');
  fs.mkdirSync(path.join(root, 'empty'));
  const { controller, context, runs, log, renameEmitter, saveEmitter, done } = withAnalyzer({ root });
  try {
    await context.workspaceState.update('codemap.target', root);
    controller.createPanel(1);
    log.panels[0].receive({ type: 'ready' });

    // A save while the first analysis runs (it may have read the file already): another analysis follows.
    let release;
    runs.wait = new Promise((resolve) => (release = resolve));
    runs.doc = graph('src/orders/order.py', 'src/billing/invoice.py');
    const first = controller.analyze();
    await until(() => runs.active === 1, 5000);
    saveEmitter.fire({ uri: Uri.file(path.join(root, 'docs/notes.md')) }); // not code
    assert.equal(controller.pending, false);
    saveEmitter.fire({ uri: Uri.file(path.join(root, 'src/orders/order.py')) });
    assert.equal(controller.pending, true);
    runs.wait = null;
    release();
    await first;
    await until(() => runs.count === 2 && !controller.running, 5000);

    // Folders: one with sources in it, or one the map has code from (deleted or moved away).
    const holds = (relative) => controller.holdsSources(relative, path.join(root, relative));
    assert.equal(holds('src/orders'), true, 'a folder with a source file');
    assert.equal(holds('src'), true, 'through its subfolders');
    assert.equal(holds('empty'), false, 'an empty folder');
    assert.equal(holds('docs'), false, 'a folder without code');
    assert.equal(holds('node_modules'), false, 'dependencies');
    assert.equal(holds('node_modules/x'), false);
    assert.equal(holds('src/billing'), true, 'gone, and the map has code from it');
    assert.equal(holds('src/bill'), false, 'gone, and only the start of a name the map knows');
    assert.equal(holds('docs/notes.md'), false, 'a file that is not code');

    // A folder renamed in the explorer: one event, for the folder.
    const before = runs.count;
    fs.renameSync(path.join(root, 'src/orders'), path.join(root, 'src/ordering'));
    renameEmitter.fire({ files: [{ oldUri: Uri.file(path.join(root, 'src/orders')), newUri: Uri.file(path.join(root, 'src/ordering')) }] });
    await until(() => runs.count === before + 1, 5000);

    // Closing the map drops the save that was waiting.
    saveEmitter.fire({ uri: Uri.file(path.join(root, 'src/ordering/order.py')) });
    log.panels[0].dispose();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(runs.count, before + 1, 'no analysis after the panel is gone');
    assert.equal(context.subscriptions.filter((s) => s.panel).length, 0);
  } finally {
    done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
