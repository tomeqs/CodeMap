'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { analyzerArgs, analyzerEnv, resolveAnalyzer, runAnalyzer } = require('../../src/analyzer');
const { flowRootsFor, nodeAt, relativeToRoot, resolveInRoot } = require('../../src/locate');
const { standaloneHtml, webviewHtml } = require('../../src/html');

const doc = {
  nodes: [
    { id: 'namespace:App/App', kind: 'namespace' },
    { id: 'T:App.Order', kind: 'class', parent: 'namespace:App/App', location: { file: 'src/Order.cs', line: 3, endLine: 40 }, extraLocations: [{ file: 'src/Order.Part.cs', line: 1, endLine: 9 }] },
    { id: 'M:App.Order.Place', kind: 'method', parent: 'T:App.Order', location: { file: 'src/Order.cs', line: 10, endLine: 18 } },
    { id: 'F:App.Order._lines', kind: 'field', parent: 'T:App.Order', location: { file: 'src/Order.cs', line: 5, endLine: 5 } },
    { id: 'T:System.String', kind: 'class', external: true, location: { file: 'src/Order.cs', line: 1, endLine: 100 } },
  ],
};

test('nodeAt picks the innermost declaration, partial files included', () => {
  assert.equal(nodeAt(doc, 'src/Order.cs', 12).id, 'M:App.Order.Place');
  assert.equal(nodeAt(doc, 'src/Order.cs', 20).id, 'T:App.Order');
  assert.equal(nodeAt(doc, 'src/Order.cs', 5).id, 'F:App.Order._lines');
  assert.equal(nodeAt(doc, 'src/Order.Part.cs', 4).id, 'T:App.Order');
  assert.equal(nodeAt(doc, 'src/Order.cs', 2), null); // only the external type spans it
  assert.equal(nodeAt(doc, 'SRC/order.cs', 12, { ignoreCase: true }).id, 'M:App.Order.Place');
  assert.equal(nodeAt(doc, 'SRC/order.cs', 12, { ignoreCase: false }), null);
});

test('flow roots: the method, else the type around the cursor', () => {
  assert.deepEqual(flowRootsFor(doc, doc.nodes[2]), ['M:App.Order.Place']);
  assert.deepEqual(flowRootsFor(doc, doc.nodes[3]), ['T:App.Order']); // a field: its class
  assert.deepEqual(flowRootsFor(doc, doc.nodes[1]), ['T:App.Order']);
  assert.deepEqual(flowRootsFor(doc, doc.nodes[0]), []);
});

test('paths relative to the analyzed root, on POSIX and Windows', () => {
  assert.equal(relativeToRoot('/repo', '/repo/src/A.cs', 'linux'), 'src/A.cs');
  assert.equal(relativeToRoot('/repo', '/other/A.cs', 'linux'), null);
  assert.equal(relativeToRoot('C:\\repo', 'C:\\repo\\src\\A.cs', 'win32'), 'src/A.cs');
  assert.equal(relativeToRoot('C:\\repo', 'D:\\repo\\src\\A.cs', 'win32'), null);
  assert.equal(relativeToRoot(undefined, '/repo/A.cs', 'linux'), null);
});

test('files to open must stay inside the analyzed root', () => {
  assert.equal(resolveInRoot('/repo', 'src/A.cs', 'linux'), '/repo/src/A.cs');
  assert.equal(resolveInRoot('/repo', '../etc/passwd', 'linux'), null);
  assert.equal(resolveInRoot('/repo', '/etc/passwd', 'linux'), null);
  assert.equal(resolveInRoot('C:\\repo', 'src/A.cs', 'win32'), 'C:\\repo\\src\\A.cs');
});

test('webview HTML gets a strict CSP and a nonce on the viewer script only', () => {
  const viewer = '<!doctype html><html><head><title>x</title><script type="module" crossorigin>run()</script></head>'
    + '<body><script id="codemap-data" type="application/json">null</script></body></html>';
  const html = webviewHtml(viewer, { cspSource: 'vscode-webview://abc', scriptNonce: 'N0nce' });
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; [^"]*script-src 'nonce-N0nce'"/);
  assert.match(html, /<script type="module" nonce="N0nce">run\(\)<\/script>/);
  assert.match(html, /worker-src blob:;/, 'the layout worker may start');
  assert.doesNotMatch(html, /codemap-renderer/, 'automatic renderer: no override');
  assert.match(webviewHtml(viewer, { cspSource: 'x', renderer: 'webgl' }), /<meta name="codemap-renderer" content="webgl" \/>/);
  assert.doesNotMatch(webviewHtml(viewer, { cspSource: 'x', renderer: '"><script>' }), /codemap-renderer/);
  assert.doesNotMatch(html, /connect-src|unsafe-eval/);
  assert.throws(() => webviewHtml('<html><body>no viewer</body></html>', { cspSource: 'x' }));
});

test('standalone HTML embeds the graph safely', () => {
  const viewer = '<html><head><title>CodeMap</title></head><body><script id="codemap-data" type="application/json">null</script></body></html>';
  const doc = { source: { name: 'Shop<b>' }, nodes: [{ id: 'T:A', doc: 'ends with </script><script>alert(1)</script>' }, { id: 'T:B', doc: 'renders <!--<script> tags' }] };
  const html = standaloneHtml(viewer, doc);
  assert.ok(!html.slice(html.indexOf('application/json">') + 18, html.lastIndexOf('</script>')).includes('<'), 'no markup inside the data script');
  assert.match(html, /<title>CodeMap · Shopb<\/title>/);
  assert.equal(html.match(/<\/script>/g).length, 1, 'no early end of the data script');
  const json = html.slice(html.indexOf('application/json">') + 18, html.lastIndexOf('</script>'));
  assert.deepEqual(JSON.parse(json), doc);
  assert.throws(() => standaloneHtml('<html></html>', doc));
});

test('analyzer resolution: settings, bundled copy, then PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ext-'));
  assert.deepEqual(resolveAnalyzer({ extensionPath: dir, analyzerPath: '', dotnetPath: '' }).command, 'codemap');
  fs.mkdirSync(path.join(dir, 'analyzer'));
  fs.writeFileSync(path.join(dir, 'analyzer', 'codemap.dll'), '');
  const bundled = resolveAnalyzer({ extensionPath: dir, dotnetPath: '/opt/dotnet/dotnet' });
  assert.equal(bundled.command, '/opt/dotnet/dotnet');
  assert.deepEqual(bundled.args, [path.join(dir, 'analyzer', 'codemap.dll')]);
  assert.equal(resolveAnalyzer({ extensionPath: dir, analyzerPath: 'C:\\tools\\codemap.exe' }).command, 'C:\\tools\\codemap.exe');
  assert.deepEqual(resolveAnalyzer({ extensionPath: dir, analyzerPath: '/x/codemap.dll' }).args, ['/x/codemap.dll']);
  fs.rmSync(dir, { recursive: true });
});

test('call flow roots of TypeScript declarations: functions, routes, class members, else their class or file', () => {
  const ts = {
    nodes: [
      { id: 'ts:ns:api/src', kind: 'namespace' },
      { id: 'ts:api:src/orders.ts', kind: 'module', level: 'type', parent: 'ts:ns:api/src' },
      { id: 'ts:api:src/orders.ts#OrdersService', kind: 'class', level: 'member', parent: 'ts:api:src/orders.ts' },
      { id: 'ts:api:src/orders.ts#OrdersService.place', kind: 'method', level: 'member', parent: 'ts:api:src/orders.ts#OrdersService' },
      { id: 'ts:api:src/orders.ts#OrdersService.repo', kind: 'field', level: 'member', parent: 'ts:api:src/orders.ts#OrdersService' },
      { id: 'ts:api:src/orders.ts#total', kind: 'function', level: 'member', parent: 'ts:api:src/orders.ts' },
      { id: 'ts:api:src/orders.ts#route:GET /orders', kind: 'function', level: 'member', parent: 'ts:api:src/orders.ts', tags: ['route'] },
      { id: 'ts:api:src/orders.ts#LIMIT', kind: 'variable', level: 'member', parent: 'ts:api:src/orders.ts' },
      { id: 'ts:api:src/orders.ts#Order', kind: 'typeAlias', level: 'member', parent: 'ts:api:src/orders.ts' },
    ],
  };
  const roots = (i) => flowRootsFor(ts, ts.nodes[i]);
  assert.deepEqual(roots(3), ['ts:api:src/orders.ts#OrdersService.place']);
  assert.deepEqual(roots(5), ['ts:api:src/orders.ts#total']);
  assert.deepEqual(roots(6), ['ts:api:src/orders.ts#route:GET /orders']);
  assert.deepEqual(roots(2), ['ts:api:src/orders.ts#OrdersService']);
  assert.deepEqual(roots(4), ['ts:api:src/orders.ts#OrdersService']); // a field: its class
  assert.deepEqual(roots(7), ['ts:api:src/orders.ts']); // a constant: its file
  assert.deepEqual(roots(8), ['ts:api:src/orders.ts']);
  assert.deepEqual(roots(1), ['ts:api:src/orders.ts']); // a file: its entry points
  assert.deepEqual(roots(0), []);
});

test('TypeScript runs on codemap.nodePath, CODEMAP_NODE or the Node.js inside VS Code', () => {
  const vscodeNode = { execPath: '/apps/Code Helper', electron: true };
  const inside = analyzerEnv({}, { PATH: '/bin' }, vscodeNode);
  assert.equal(inside.CODEMAP_NODE, '/apps/Code Helper');
  assert.equal(inside.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(inside.DOTNET_NOLOGO, '1');
  assert.equal(inside.PATH, '/bin');

  const configured = analyzerEnv({ nodePath: '/usr/local/bin/node' }, { CODEMAP_NODE: '/old/node' }, vscodeNode);
  assert.equal(configured.CODEMAP_NODE, '/usr/local/bin/node');
  assert.equal(configured.ELECTRON_RUN_AS_NODE, undefined);

  assert.equal(analyzerEnv({}, { CODEMAP_NODE: '/opt/node' }, vscodeNode).CODEMAP_NODE, '/opt/node');
  assert.equal(analyzerEnv({}, {}, { execPath: '/usr/bin/node', electron: false }).ELECTRON_RUN_AS_NODE, undefined);
});

test('analyzer arguments follow the settings', () => {
  assert.deepEqual(analyzerArgs('/r/App.sln', '/out'), ['/r/App.sln', '-o', '/out', '-f', 'json', '--name', 'map']);
  assert.deepEqual(analyzerArgs('/r', '/out', { includeTests: false, includeExternal: true, gitHistory: false }).slice(7), ['--no-tests', '--external', '--no-git']);
});

// A fake analyzer (node script) checks how runAnalyzer talks to the process.
function fakeAnalyzer(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-fake-'));
  const script = path.join(dir, 'fake.js');
  fs.writeFileSync(script, `const args = process.argv.slice(2); const out = args[args.indexOf('-o') + 1];\n${body}`);
  return { command: process.execPath, args: [script], label: 'fake', needsDotnet: false };
}

test('runAnalyzer streams progress and returns the graph', async () => {
  const analyzer = fakeAnalyzer(`
    console.log('Found 2 project(s)'); console.error('warning: something');
    require('fs').writeFileSync(require('path').join(out, 'map.codemap.json'), JSON.stringify({ format: 'codemap', nodes: [], edges: [], args }));`);
  const lines = [];
  const graph = await runAnalyzer(analyzer, '/repo/App.sln', { gitHistory: false }, { onLine: (l) => lines.push(l) });
  assert.equal(graph.format, 'codemap');
  assert.deepEqual(graph.args.slice(0, 1), ['/repo/App.sln']);
  assert.ok(graph.args.includes('--no-git'));
  assert.deepEqual(lines.sort(), ['Found 2 project(s)', 'warning: something']);
});

test('runAnalyzer reports failures with the end of the output', async () => {
  const analyzer = fakeAnalyzer(`console.error('You must install .NET to run this application.'); process.exit(3);`);
  await assert.rejects(runAnalyzer(analyzer, '/repo', {}), /exit code 3[\s\S]*You must install \.NET/);
});

test('runAnalyzer explains a missing dotnet', async () => {
  const analyzer = { command: '/nonexistent/dotnet', args: ['x.dll'], label: 'bundled', needsDotnet: true };
  await assert.rejects(runAnalyzer(analyzer, '/repo', {}), /needs the \.NET SDK 8/);
});

test('runAnalyzer can be cancelled', async () => {
  const analyzer = fakeAnalyzer(`setTimeout(() => {}, 60000);`);
  const controller = new AbortController();
  const run = runAnalyzer(analyzer, '/repo', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(run, (error) => error.cancelled === true);
});
