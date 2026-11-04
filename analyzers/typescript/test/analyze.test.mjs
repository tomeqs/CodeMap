import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  // As CodeMap asks: the root is the folder given, or the file's folder; the package.json is above it.
  const file = fixture('basic') + '/src/domain/order.ts';
  const one = analyze(ts, { target: file, root: dirname(file), options: {} });
  assert.deepEqual(one.nodes.filter((n) => n.kind === 'module').map((n) => n.id), [`${B}domain/order.ts`]);
  assert.equal(one.source.kind, 'file');

  const folder = fixture('basic') + '/src/orders';
  const sub = analyze(ts, { target: folder, root: folder, options: {} });
  assert.ok(sub.nodes.some((n) => n.id === `${B}orders/orders.service.ts`), 'same ids as when the whole package is analyzed');
  assert.deepEqual(sub.nodes.filter((n) => n.kind === 'project').map((n) => [n.id, n.fullName, n.location]), [['ts:project:basic', 'basic', undefined]]); // its package.json is not on this map

  // JavaScript belongs to its package too (without one it would be left out as a copied library).
  const js = fixture('js') + '/src/index.js';
  const script = analyze(ts, { target: js, root: dirname(js), options: {} });
  assert.deepEqual(script.nodes.filter((n) => n.kind === 'module').map((n) => n.id), ['ts:legacy:src/index.js']);
});

/** A copy of a fixture in a temporary folder (under `under`, if given), with extra files; removed after `fn`. */
function scratch(name, files, fn, under = '') {
  const base = mkdtempSync(join(tmpdir(), 'codemap-ts-'));
  const dir = join(base, under, name);
  try {
    cpSync(fixture(name), dir, { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }

    return fn(dir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('a workspace package that was built is still read from its sources', () => {
  scratch('workspace', {
    'packages/domain/dist/index.js': 'export class Money { constructor(a) { this.amount = a; } add(o) { return new Money(this.amount + o.amount); } }\n',
    'packages/domain/dist/index.d.ts': 'export declare class Money { amount: number; constructor(a: number); add(o: Money): Money; }\n',
  }, (dir) => {
    const graph = analyze(ts, { target: dir, root: dir, options: {} });
    const has = (source, kind, target) => assert.ok(graph.edges.some((e) => e.source === source && e.kind === kind && e.target === target), `missing ${source} -${kind}-> ${target}`);
    has('ts:@shop/api:src/app.ts', 'imports', 'ts:@shop/domain:src/index.ts');
    has('ts:@shop/api:src/app.ts#total', 'calls', 'ts:@shop/domain:src/index.ts#Money.add');
    assert.ok(!graph.nodes.some((n) => n.id.includes('/dist/')));
  });
});

test('main: dist/… is found in src/ also when the checkout is in a folder named build', () => {
  scratch('workspace', {
    'packages/domain/src/index.ts': 'export class Money { constructor(public amount: number) {} add(o: Money) { return new Money(this.amount + o.amount); } }\n',
  }, (dir) => {
    const graph = analyze(ts, { target: dir, root: dir, options: {} });
    const index = graph.nodes.find((n) => n.id === 'ts:@shop/domain:src/index.ts');
    assert.ok(index?.tags?.includes('entrypoint'), 'main: dist/index.js is src/index.ts');
  }, 'build/ci');
});

test('path aliases are local code, not npm packages', () => {
  scratch('workspace', {
    'packages/api/src/aliases.ts': "import { x } from '@/lib/x';\nimport { api } from '@app/generated/api';\nimport { y } from '#internal/y';\nexport const all = [x, api, y];\n",
    'packages/api/src/generated/api.ts': '// @generated by a tool\nexport const api = 1;\n',
  }, (dir) => {
    const graph = analyze(ts, { target: dir, root: dir, options: {} });
    const packages = graph.nodes.filter((n) => n.kind === 'package').map((n) => n.id);
    assert.deepEqual(packages.sort(), ['ts:npm:zod']);
  });
});

/**
 * A package `pkg` with these files in a temporary folder, analyzed as CodeMap asks; removed afterwards.
 * `links` are symbolic links to make first: { 'src/linked.ts': '../shared/real.ts' }.
 */
function inline(files, links = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codemap-ts-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{ "name": "pkg" }');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }

    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, path));

    const graph = analyze(ts, { target: dir, root: dir, options: {} });
    const node = (id) => graph.nodes.find((n) => n.id === id) ?? assert.fail(`no node ${id}; nodes: ${graph.nodes.map((n) => n.id).join(', ')}`);
    const hasEdge = (source, kind, target) => assert.ok(graph.edges.some((e) => e.source === source && e.kind === kind && e.target === target), `missing ${source} -${kind}-> ${target}; from it: ${graph.edges.filter((e) => e.source === source).map((e) => `${e.kind} ${e.target}`).join(', ')}`);
    const noEdge = (source, kind, target) => assert.ok(!graph.edges.some((e) => e.source === source && e.kind === kind && e.target === target), `unexpected ${source} -${kind}-> ${target}`);
    const unused = new Set(graph.nodes.filter((n) => !graph.edges.some((e) => e.target === n.id && e.source !== n.id)).map((n) => n.id));
    return { graph, node, hasEdge, noEdge, unused };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('functions put in an object by shorthand ({ list }) are referenced', () => {
  const { hasEdge } = inline({
    'src/handlers.ts': 'function list() { return 1; }\nfunction place() { return 2; }\nexport const handlers = { list, place };\nexport function api() { return { list }; }\n',
  });
  hasEdge('ts:pkg:src/handlers.ts#handlers', 'calls', 'ts:pkg:src/handlers.ts#list');
  hasEdge('ts:pkg:src/handlers.ts#handlers', 'calls', 'ts:pkg:src/handlers.ts#place');
  hasEdge('ts:pkg:src/handlers.ts#api', 'calls', 'ts:pkg:src/handlers.ts#list');
});

test('super() calls the constructor of a base class in a package analyzed later', () => {
  scratch('workspace', {
    'packages/domain/src/base.ts': 'export class Base {\n  constructor(public n: number) {}\n}\n',
    'packages/api/src/derived.ts': "import { Base } from '@shop/domain/base';\nexport class Derived extends Base {\n  constructor() {\n    super(1);\n  }\n}\n",
  }, (dir) => {
    const graph = analyze(ts, { target: dir, root: dir, options: {} });
    const calls = graph.edges.filter((e) => e.source === 'ts:@shop/api:src/derived.ts#Derived.constructor' && e.kind === 'calls').map((e) => e.target);
    assert.deepEqual(calls, ['ts:@shop/domain:src/base.ts#Base.constructor']); // @shop/api is analyzed before @shop/domain
  });
});

test('overloads keep the size of the implementation; signatures leave decorators out whatever their arguments', () => {
  const { node } = inline({
    'src/overloads.ts': 'export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: any) {\n  if (a) return;\n}\n',
    'src/app.component.ts': [
      'function Component(x: any) { return (t: any) => t; }',
      'function Get(path: string) { return (t: any, k: string) => {}; }',
      "@Component({ selector: 'app', template: '<b (click)=\"go()\">x</b>' })",
      'export class AppComponent {',
      "  @Get(['a', 'b'].join('/'))",
      '  list(page: number) { return page; }',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(node('ts:pkg:src/overloads.ts#f').metrics, { complexity: 2, loc: 3 });
  assert.equal(node('ts:pkg:src/app.component.ts#AppComponent').signature, 'export class AppComponent');
  assert.equal(node('ts:pkg:src/app.component.ts#AppComponent.list').signature, 'list(page: number)');
});

const P = 'ts:pkg:src/';

test('the annotation of a function-valued variable and the constraints and defaults of type parameters are used', () => {
  const { hasEdge } = inline({
    'src/a.ts': [
      'interface Props { a: number }',
      'type Constraint = string;',
      'type Fallback = "x";',
      'type FC<P> = (p: P) => number;',
      'export const Comp: FC<Props> = (p) => p.a;',
      'export function g<T extends Constraint = Fallback>(x: T): T { return x; }',
      'export class Box<T extends Props> { put(x: T) { return x; } }',
      'export type Pair<K extends Constraint> = [K, K];',
      '',
    ].join('\n'),
  });
  hasEdge(`${P}a.ts#Comp`, 'uses', `${P}a.ts#FC`);
  hasEdge(`${P}a.ts#Comp`, 'uses', `${P}a.ts#Props`);
  hasEdge(`${P}a.ts#g`, 'uses', `${P}a.ts#Constraint`);
  hasEdge(`${P}a.ts#g`, 'uses', `${P}a.ts#Fallback`);
  hasEdge(`${P}a.ts#Box`, 'uses', `${P}a.ts#Props`);
  hasEdge(`${P}a.ts#Pair`, 'uses', `${P}a.ts#Constraint`);
});

test('a require() variable is what references to it read, and require() in TypeScript imports', () => {
  const { hasEdge, noEdge } = inline({
    'src/helper.js': 'function double(x) { return x * 2; }\nmodule.exports = { double };\n',
    'src/index.js': "const helper = require('./helper');\nfunction run(xs) {\n  return xs.map(helper.double);\n}\nmodule.exports = { run };\n",
    'src/legacy.ts': "const helper = require('./helper');\nexport const twice = (n: number) => helper.double(n);\n",
  });
  hasEdge(`${P}index.js#run`, 'accesses', `${P}index.js#helper`);
  hasEdge(`${P}index.js#run`, 'calls', `${P}helper.js#double`); // helper.double still reaches the function
  noEdge(`${P}index.js#run`, 'uses', `${P}helper.js`);
  hasEdge(`${P}index.js`, 'imports', `${P}helper.js`);
  hasEdge(`${P}legacy.ts`, 'imports', `${P}helper.js`);
  hasEdge(`${P}legacy.ts#twice`, 'accesses', `${P}legacy.ts#helper`);
});

test('top-level code without calls is walked, and an exported default value is a node', () => {
  const { graph, node, hasEdge } = inline({
    'src/webpack.config.js': "const opts = { a: 1 };\nconst plugin = { name: 'p', opts };\nmodule.exports = { plugins: [plugin] };\n",
    'src/stack.ts': 'const Row = () => 1;\nconst Col = () => 2;\nexport default { Row, Col };\n',
    'src/screen.ts': "'use client';\nexport const Center = { X: 0 };\nconst Logo = 1;\nCenter.X = Logo;\n",
    'src/use.ts': "import Stack from './stack';\nexport const row = () => Stack.Row();\n",
  });
  hasEdge(`${P}webpack.config.js#(top-level)`, 'accesses', `${P}webpack.config.js#plugin`);
  hasEdge(`${P}stack.ts#default`, 'calls', `${P}stack.ts#Row`);
  hasEdge(`${P}stack.ts#default`, 'calls', `${P}stack.ts#Col`);
  hasEdge(`${P}use.ts#row`, 'accesses', `${P}stack.ts#default`);
  hasEdge(`${P}screen.ts#(top-level)`, 'accesses', `${P}screen.ts#Logo`);
  assert.equal(node(`${P}screen.ts#(top-level)`).location.line, 4); // the directive is not code
  // Assignments alone do not make a script: nothing imports these files, yet they are no entry points.
  assert.ok(!graph.nodes.some((n) => n.tags?.includes('entrypoint')));
});

test('a JSX closing tag makes no edge', () => {
  const { graph } = inline({
    'src/app.tsx': [
      'const Panel = (p: { children?: unknown }) => null;',
      'const Stack = { Screen: (p: { children?: unknown }) => null };',
      'export const App = () => (',
      '  <Panel>',
      '    <Stack.Screen>x</Stack.Screen>',
      '  </Panel>',
      ');',
      '',
    ].join('\n'),
  });
  const edges = (target) => graph.edges.filter((e) => e.source === `${P}app.tsx#App` && e.target === `${P}app.tsx#${target}`).map((e) => [e.kind, e.line ?? 0]);
  assert.deepEqual(edges('Panel'), [['instantiates', 4]]);
  assert.deepEqual(edges('Stack'), [['accesses', 0]]); // <Stack.Screen> reads Stack, from the opening tag
});

test('a constructor injects the type itself; its type arguments are only used', () => {
  const { hasEdge, noEdge } = inline({
    'src/article.ts': [
      'export class ArticleEntity { id = 0; }',
      'export class Repository<T> { find(): T[] { return []; } }',
      'export class Clock { now() { return 0; } }',
      'export class ArticleService {',
      '  constructor(private readonly articles: Repository<ArticleEntity>, private readonly tags: Array<ArticleEntity>, private readonly clock?: Clock | undefined) {}',
      '}',
      '',
    ].join('\n'),
  });
  const service = `${P}article.ts#ArticleService`;
  hasEdge(service, 'injects', `${P}article.ts#Repository`);
  hasEdge(service, 'injects', `${P}article.ts#Clock`);
  noEdge(service, 'injects', `${P}article.ts#ArticleEntity`);
  hasEdge(service, 'uses', `${P}article.ts#ArticleEntity`);
});

test('default values and decorators of the parameters of declared functions and methods are walked', () => {
  const { hasEdge } = inline({
    'src/defaults.ts': 'function compute(): number { return 1; }\nexport function withDefault(x: number = compute()) { return x; }\n',
    'src/dec.ts': [
      'function createParamDecorator(f: () => number) { return () => (t: any, k: string, i: number) => {}; }',
      'const PAGE = 20;',
      'export const CurrentUser = createParamDecorator(() => 1);',
      'export class AController {',
      '  b(@CurrentUser() user: unknown, size = PAGE) { return user; }',
      '  constructor(@CurrentUser() user: unknown) {}',
      '}',
      '',
    ].join('\n'),
  });
  hasEdge(`${P}defaults.ts#withDefault`, 'calls', `${P}defaults.ts#compute`);
  hasEdge(`${P}dec.ts#AController.b`, 'decoratedWith', `${P}dec.ts#CurrentUser`);
  hasEdge(`${P}dec.ts#AController.b`, 'accesses', `${P}dec.ts#PAGE`);
  hasEdge(`${P}dec.ts#AController.constructor`, 'decoratedWith', `${P}dec.ts#CurrentUser`);
});

test('a relative import that finds a .d.ts leads to the analyzed file next to it', () => {
  const { hasEdge } = inline({
    'config/port.d.ts': 'export declare const PORT: number;\n',
    'config/port.js': 'export const PORT = 3000;\n',
    'src/useport.ts': "import { PORT } from '../config/port.js';\nexport const where = () => PORT;\n",
  });
  hasEdge(`${P}useport.ts`, 'imports', 'ts:pkg:config/port.js');
  hasEdge(`${P}useport.ts#where`, 'accesses', 'ts:pkg:config/port.js#PORT');
});

test('a symbolically linked file is analyzed under its own path, and imports through the link reach it', { skip: process.platform === 'win32' }, () => {
  const { hasEdge, node } = inline({
    'shared/real.ts': 'export const shared = 1;\n',
    'src/uselink.ts': "import { shared } from './linked';\nexport const v = () => shared;\n",
  }, { 'src/linked.ts': '../shared/real.ts' });
  node(`${P}linked.ts`);
  hasEdge(`${P}uselink.ts`, 'imports', `${P}linked.ts`);
  hasEdge(`${P}linked.ts`, 'imports', 'ts:pkg:shared/real.ts'); // the link loads its target
  hasEdge(`${P}uselink.ts#v`, 'accesses', `${P}linked.ts#shared`);
});

test('package.json module and exports are entry points, also built into one folder per format', () => {
  const { node } = inline({
    'package.json': JSON.stringify({
      name: 'pkg', main: 'build/legacy/index.cjs', module: 'build/legacy/index.js',
      exports: { '.': { import: { types: './build/modern/index.d.ts', default: './build/modern/index.js' } }, './extra': './build/modern/extra.js', './package.json': './package.json' },
    }),
    'src/index.ts': 'export const a = 1;\n',
    'src/extra.ts': 'export const b = 2;\n',
  });
  assert.ok(node(`${P}index.ts`).tags?.includes('entrypoint')); // build/legacy/index.cjs → src/index.ts
  assert.ok(node(`${P}extra.ts`).tags?.includes('entrypoint')); // exports ./extra
});

test('configuration files and barrels are tagged', () => {
  const { node } = inline({
    'vite.config.ts': 'export default { root: "." };\n',
    '.eslintrc.cjs': 'module.exports = { root: true };\n',
    'src/index.ts': "export * from './a';\nexport { b } from './b';\nimport './c';\n",
    'src/mixed.ts': "export * from './a';\nexport const own = 1;\n",
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    'src/c.ts': 'export {};\n',
    'src/app.config.ts': 'export const appConfig = { api: "/api" };\n',
  });
  assert.equal(node(`${P}app.config.ts`).tags, undefined); // the application's code, not a tool's configuration
  assert.deepEqual(node('ts:pkg:vite.config.ts').tags, ['config']);
  assert.deepEqual(node('ts:pkg:.eslintrc.cjs').tags, ['config']);
  assert.deepEqual(node(`${P}index.ts`).tags, ['barrel']);
  assert.equal(node(`${P}mixed.ts`).tags, undefined);
  assert.equal(node(`${P}c.ts`).tags, undefined); // no re-export
});

test('single-file components are files with the imports of their scripts', () => {
  const { graph, node, hasEdge } = inline({
    'src/helper.ts': 'export const helper = () => 1;\n',
    'src/App.vue': '<template><div>{{ x }}</div></template>\n<script setup lang="ts">\nimport { helper } from \'./helper\';\nimport Panel from \'./Panel.svelte\';\nconst x = helper();\n</script>\n',
    'src/Panel.svelte': '<script>\n  import { helper } from \'./helper\';\n</script>\n<p>{helper()}</p>\n',
    'src/Page.astro': "---\nimport { helper } from './helper';\n---\n<p>{helper()}</p>\n",
    'src/main.ts': "import App from './App.vue';\nconsole.log(App);\n",
  });
  assert.equal(node(`${P}App.vue`).kind, 'module');
  hasEdge(`${P}main.ts`, 'imports', `${P}App.vue`);
  hasEdge(`${P}App.vue`, 'imports', `${P}helper.ts`);
  hasEdge(`${P}App.vue`, 'imports', `${P}Panel.svelte`);
  hasEdge(`${P}Panel.svelte`, 'imports', `${P}helper.ts`);
  hasEdge(`${P}Page.astro`, 'imports', `${P}helper.ts`);
  assert.deepEqual(graph.analysis.warnings, []); // ./App.vue is no unresolved import
});

test('SvelteKit: $lib is src/lib, $app is no npm package, and route files are entry points', () => {
  const { graph, node, hasEdge } = inline({
    'package.json': JSON.stringify({ name: 'pkg', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
    'src/lib/format.ts': 'export const format = (n: number) => String(n);\n',
    'src/routes/+page.ts': "import { format } from '$lib/format';\nimport { goto } from '$app/navigation';\nexport const load = () => ({ value: format(1), goto });\n",
    'src/routes/about/+page.svelte': "<script lang=\"ts\">\n  import Card from '$lib/Card.svelte';\n  export let data;\n</script>\n<Card>{data.value}</Card>\n",
    'src/lib/Card.svelte': '<slot />\n',
  });
  hasEdge(`${P}routes/+page.ts`, 'imports', `${P}lib/format.ts`);
  hasEdge(`${P}routes/about/+page.svelte`, 'imports', `${P}lib/Card.svelte`);
  assert.deepEqual(graph.nodes.filter((n) => n.kind === 'package').map((n) => n.id), ['ts:npm:@sveltejs/kit']);
  for (const id of [`${P}routes/+page.ts`, `${P}routes/about/+page.svelte`]) assert.deepEqual(node(id).tags, ['entrypoint', 'route']);
  assert.equal(node(`${P}lib/format.ts`).tags, undefined);
});

test('Next.js app and pages files are routes; test folders and type tests are tests', () => {
  const { node } = inline({
    'package.json': JSON.stringify({ name: 'pkg', dependencies: { next: '^15.0.0' } }),
    'app/page.tsx': 'export default function Page() { return null; }\n',
    'app/blog/[slug]/layout.tsx': 'export default function Layout() { return null; }\n',
    'app/blog/util.ts': 'export const util = 1;\n',
    'pages/api/hello.ts': 'export default function handler() {}\n',
    'test/helpers.ts': 'export const helper = 1;\n',
    'src/__fixtures__/data.ts': 'export const data = 1;\n',
    'src/types.test-d.ts': 'export type T = 1;\n',
  });
  for (const id of ['ts:pkg:app/page.tsx', 'ts:pkg:app/blog/[slug]/layout.tsx', 'ts:pkg:pages/api/hello.ts']) assert.deepEqual(node(id).tags, ['entrypoint', 'route']);
  assert.equal(node('ts:pkg:app/blog/util.ts').tags, undefined);
  for (const id of ['ts:pkg:test/helpers.ts', `${P}__fixtures__/data.ts`, `${P}types.test-d.ts`]) assert.deepEqual(node(id).tags, ['test']);
});

test('a package the workspace excludes gets its dependencies on workspace names from npm', () => {
  const { graph, hasEdge } = inline({
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*', '!packages/legacy'] }),
    'packages/a/package.json': JSON.stringify({ name: '@w/a' }),
    'packages/a/src/index.ts': 'export const a = 1;\n',
    'packages/b/package.json': JSON.stringify({ name: '@w/b', dependencies: { '@w/a': '*' } }),
    'packages/b/src/index.ts': "import { a } from '@w/a';\nexport const b = a;\n",
    'packages/legacy/package.json': JSON.stringify({ name: '@w/legacy', dependencies: { '@w/a': '1.0.0' } }),
    'packages/legacy/src/index.ts': "import { a } from '@w/a';\nexport const old = a;\n",
  });
  const edges = (from) => graph.edges.filter((e) => e.source === from).map((e) => `${e.kind} ${e.target}`).sort();
  hasEdge('ts:@w/b:src/index.ts', 'imports', 'ts:@w/a:src/index.ts');
  hasEdge('ts:project:@w/b', 'projectReference', 'ts:project:@w/a');
  assert.deepEqual(edges('ts:project:@w/legacy'), ['packageReference ts:npm:@w/a']);
  assert.ok(!graph.edges.some((e) => e.source === 'ts:@w/legacy:src/index.ts' && e.target.startsWith('ts:@w/a:')));
});

test('Nuxt: pages and server routes are routes; the app, layouts and auto-imported folders are entry points', () => {
  const { node } = inline({
    'package.json': JSON.stringify({ name: 'pkg', dependencies: { nuxt: '^4.0.0' } }),
    'app/app.vue': '<template><NuxtPage /></template>\n',
    'app/pages/index.vue': '<template><p>home</p></template>\n',
    'app/components/Counter.vue': '<template><p>1</p></template>\n',
    'server/api/todos.ts': 'export default () => [];\n',
    'server/utils/db.ts': 'export const db = 1;\n',
    'app/helpers/format.ts': 'export const format = 1;\n',
  });
  for (const id of ['ts:pkg:app/pages/index.vue', 'ts:pkg:server/api/todos.ts']) assert.deepEqual(node(id).tags, ['entrypoint', 'route']);
  for (const id of ['ts:pkg:app/app.vue', 'ts:pkg:app/components/Counter.vue', 'ts:pkg:server/utils/db.ts']) assert.deepEqual(node(id).tags, ['entrypoint']);
  assert.equal(node('ts:pkg:app/helpers/format.ts').tags, undefined);
});

test('the warning about unresolved imports names where they are', () => {
  const { graph } = inline({
    'src/a.ts': "import { x } from './missing';\nimport './styles.css';\nexport const a = x;\n",
    'src/b.ts': "import { y } from '../gone/y';\nexport const b = y;\n",
  });
  assert.deepEqual(graph.analysis.warnings, ['2 relative import(s) could not be resolved (paths only a bundler knows, or missing files): src/a.ts → ./missing, src/b.ts → ../gone/y.']);
});
