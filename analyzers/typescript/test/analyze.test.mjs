import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from '../src/load-typescript.mjs';
import { analyze } from '../src/analyze.mjs';

const ts = loadTypeScript();
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function run(name, options = {}) {
  const dir = fixture(name);
  const graph = analyze(ts, { target: dir, root: dir, options });
  const node = (id) => graph.nodes.find((n) => n.id === id) ?? assert.fail(`no node ${id}; nodes: ${graph.nodes.map((n) => n.id).join(', ')}`);
  const edge = (source, kind, target) => graph.edges.find((e) => e.source === source && e.kind === kind && e.target === target);
  const hasEdge = (source, kind, target) => assert.ok(edge(source, kind, target), `missing ${source} -${kind}-> ${target}; from it: ${graph.edges.filter((e) => e.source === source).map((e) => `${e.kind} ${e.target}`).join(', ')}`);
  return { graph, node, edge, hasEdge };
}

const B = 'ts:basic:src/';

test('files are the units, declarations and class members their members', () => {
  const { graph, node } = run('basic');
  assert.deepEqual(graph.source, { path: fixture('basic'), root: fixture('basic'), kind: 'directory', name: 'basic' });
  assert.equal(node('ts:project:basic').kind, 'project');
  assert.deepEqual(node('ts:project:basic').metrics, { files: 6, lines: 62 }); // the generated file is not counted
  assert.equal(node(`${B}orders/orders.service.ts`).kind, 'module');
  assert.equal(node(`${B}orders/orders.service.ts`).level, 'type');
  assert.equal(node(`${B}orders/orders.service.ts`).parent, 'ts:ns:basic/orders'); // src/ is left out of folder names
  assert.equal(node('ts:ns:basic/(root)').parent, 'ts:project:basic');

  const service = node(`${B}orders/orders.service.ts#OrdersService`);
  assert.deepEqual([service.kind, service.level, service.parent], ['class', 'member', `${B}orders/orders.service.ts`]);
  const place = node(`${B}orders/orders.service.ts#OrdersService.place`);
  assert.deepEqual([place.kind, place.parent, place.accessibility, place.attributes], ['method', service.id, 'public', ['log']]);
  assert.equal(place.signature, 'async place(id: OrderId, items: number[]): Promise<Order>');
  assert.deepEqual(place.modifiers, ['async']);
  assert.equal(place.metrics.complexity, 2);
  assert.equal(node(`${B}domain/order.ts#Order.total`).metrics.complexity, 4); // for, if, &&
  assert.equal(node(`${B}domain/order.ts#Order`).doc, 'An order of a customer.');

  // Parameter properties are properties; unexported declarations are private.
  assert.equal(node(`${B}orders/orders.service.ts#OrdersService.repository`).accessibility, 'private');
  assert.equal(node(`${B}domain/order.ts#unusedHelper`).accessibility, 'private');
  assert.deepEqual([node(`${B}domain/order.ts#OrderId`).kind, node(`${B}domain/order.ts#MAX_ITEMS`).kind], ['typeAlias', 'variable']);
});

test('calls, new, throw and type references resolve to the declarations, through barrels and interfaces', () => {
  const { hasEdge, edge } = run('basic');
  const place = `${B}orders/orders.service.ts#OrdersService.place`;
  hasEdge(place, 'calls', `${B}orders/orders.repository.ts#OrdersRepository.save`);
  assert.equal(edge(place, 'calls', `${B}orders/orders.repository.ts#OrdersRepository.save`).line, 13);
  hasEdge(place, 'instantiates', `${B}domain/order.ts#Order`);
  hasEdge(place, 'throws', `${B}domain/order.ts#OrderError`);
  hasEdge(place, 'returns', `${B}domain/order.ts#Order`);
  hasEdge(place, 'accepts', `${B}domain/order.ts#OrderId`);
  hasEdge(place, 'decoratedWith', `${B}orders/orders.service.ts#log`);
  hasEdge(`${B}orders/orders.service.ts#OrdersService`, 'injects', `${B}orders/orders.repository.ts#OrdersRepository`);
  assert.equal(edge(`${B}domain/order.ts#Order`, 'injects', `${B}domain/order.ts#OrderId`), undefined, 'a string alias is not a service');
  hasEdge(`${B}orders/orders.repository.ts#SqlOrdersRepository`, 'implements', `${B}orders/orders.repository.ts#OrdersRepository`);
  hasEdge(`${B}orders/orders.repository.ts#SqlOrdersRepository.save`, 'implements', `${B}orders/orders.repository.ts#OrdersRepository.save`);

  // main.ts imports the barrel, its calls reach the real declarations.
  hasEdge(`${B}main.ts`, 'imports', `${B}index.ts`);
  hasEdge(`${B}index.ts`, 'imports', `${B}orders/orders.service.ts`);
  hasEdge(`${B}main.ts#(top-level)`, 'calls', `${B}orders/orders.service.ts#OrdersService.place`);
  hasEdge(`${B}main.ts#service`, 'instantiates', `${B}orders/orders.service.ts#OrdersService`);
  // import type only describes types.
  hasEdge(`${B}orders/orders.repository.ts`, 'uses', `${B}domain/order.ts`);
  assert.equal(edge(`${B}orders/orders.repository.ts`, 'imports', `${B}domain/order.ts`), undefined);
});

test('packages, tests and generated files', () => {
  const { graph, node, hasEdge } = run('basic');
  hasEdge('ts:project:basic', 'packageReference', 'ts:npm:express');
  assert.deepEqual([node('ts:npm:express').external, node('ts:npm:express').signature], [true, '^4.19.2']);
  assert.deepEqual(node(`${B}orders/orders.service.spec.ts`).tags, ['test']);
  assert.deepEqual(node(`${B}orders/orders.service.spec.ts#test`).tags, ['test']);
  assert.ok(!graph.nodes.some((n) => n.id.includes('generated')), 'generated files are skipped');
  assert.deepEqual(graph.analysis.warnings, ['1 generated file(s) were skipped.']); // ./styles.css is not code: no warning

  const withoutTests = run('basic', { includeTests: false });
  assert.ok(!withoutTests.graph.nodes.some((n) => n.id.includes('.spec.')));
  const withGenerated = run('basic', { includeGenerated: true });
  withGenerated.node(`${B}generated.ts`);
});

test('workspace packages import each other from source, without npm install', () => {
  const { graph, hasEdge } = run('workspace');
  assert.deepEqual(graph.nodes.filter((n) => n.kind === 'project').map((n) => n.id), ['ts:project:@shop/api', 'ts:project:@shop/domain']); // the root only declares workspaces
  hasEdge('ts:@shop/api:src/app.ts', 'imports', 'ts:@shop/domain:src/index.ts');
  hasEdge('ts:@shop/api:src/app.ts#total', 'instantiates', 'ts:@shop/domain:src/index.ts#Money');
  hasEdge('ts:@shop/api:src/app.ts#total', 'calls', 'ts:@shop/domain:src/index.ts#Money.add');
  hasEdge('ts:project:@shop/api', 'projectReference', 'ts:project:@shop/domain');
  hasEdge('ts:project:@shop/api', 'packageReference', 'ts:npm:zod');
  // tsconfig paths
  hasEdge('ts:@shop/api:src/app.ts', 'imports', 'ts:@shop/api:src/util/format.ts');
  hasEdge('ts:@shop/api:src/app.ts#total', 'calls', 'ts:@shop/api:src/util/format.ts#format');
});

test('plain JavaScript: CommonJS require and exports, minified bundles left out', () => {
  const { graph, node, hasEdge } = run('js');
  hasEdge('ts:legacy:src/index.js', 'imports', 'ts:legacy:src/util.js');
  hasEdge('ts:legacy:src/index.js#main', 'calls', 'ts:legacy:src/util.js#double');
  hasEdge('ts:legacy:src/index.js#(top-level)', 'calls', 'ts:legacy:src/index.js#main');
  assert.equal(node('ts:legacy:src/util.js#double').accessibility, 'public'); // module.exports = { double }
  assert.equal(node('ts:legacy:src/util.js#unused').accessibility, 'private');
  assert.ok(!graph.nodes.some((n) => n.id.includes('.min.')));
});

test('one file, or a subfolder of a package', () => {
  const file = fixture('basic') + '/src/domain/order.ts';
  const one = analyze(ts, { target: file, root: fixture('basic'), options: {} });
  assert.deepEqual(one.nodes.filter((n) => n.kind === 'module').map((n) => n.id), [`${B}domain/order.ts`]);
  assert.equal(one.source.kind, 'file');

  const sub = analyze(ts, { target: fixture('basic') + '/src/orders', root: fixture('basic'), options: {} });
  assert.ok(sub.nodes.some((n) => n.id === `${B}orders/orders.service.ts`), 'same ids as when the whole package is analyzed');
});
