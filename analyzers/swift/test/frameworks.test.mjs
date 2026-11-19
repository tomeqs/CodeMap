import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './helpers.mjs';

const map = run('frameworks');
const tags = (id) => map.node(id).tags ?? [];

test('entry points: @main types and their main(), SwiftUI apps, app delegates, executable targets', () => {
  assert.ok(tags('swift:Server:Entry').includes('entrypoint'));
  assert.ok(tags('swift:Server:Entry.main()').includes('entrypoint'));
  assert.ok(tags('swift:Shop:ShopApp').includes('entrypoint'));
  assert.ok(tags('swift:Shop:AppDelegate').includes('entrypoint'));
  assert.ok(tags('swift:project:Server').includes('entrypoint'));
});

test('tests: XCTestCase and its test methods and setUp, Swift Testing, #Preview', () => {
  assert.ok(tags('swift:ShopTests:CartTests').includes('test'));
  assert.ok(tags('swift:ShopTests:CartTests.testAdds()').includes('test'));
  assert.ok(tags('swift:ShopTests:CartTests.setUp()').includes('test'));
  assert.ok(tags('swift:ShopTests:CartSuite').includes('test'));
  assert.ok(tags('swift:ShopTests:CartSuite.adds()').includes('test'));
  assert.ok(tags('swift:ShopTests:file:CartTests.freeStanding()').includes('test'));
  assert.ok(tags('swift:Shop:file:Views.#Preview').includes('test'));
  assert.ok(map.hasEdge('swift:Shop:file:Views.#Preview', 'instantiates', 'swift:Shop:CartView'));
});

test('SwiftUI and UIKit: components, environment objects, handlers, outlets and @objc', () => {
  assert.ok(tags('swift:Shop:CartView').includes('component'));
  assert.ok(tags('swift:Shop:CartViewController').includes('component'));
  assert.ok(map.hasEdge('swift:Shop:CartView', 'injects', 'swift:Shop:Cart'));
  // $shown is a use of shown.
  assert.ok(map.hasEdge('swift:Shop:CartView.body', 'accesses', 'swift:Shop:CartView.shown'));
  assert.ok(tags('swift:Shop:CartViewController.tap(_:)').includes('handler'));
  assert.ok(tags('swift:Shop:CartViewController.label').includes('maybe-used'));
  assert.ok(tags('swift:Shop:CartViewController.refresh()').includes('maybe-used'));
  assert.ok(map.hasEdge('swift:Shop:CartViewController.viewDidLoad()', 'calls', 'swift:Shop:CartViewController.refresh()')); // #selector
  assert.equal(map.node('swift:Shop:CartViewController.unusedHelper()').tags, undefined);
});

test('Vapor: routes with their full paths, handlers called by the code that registers them, collections, middleware, models', () => {
  const route = (id) => map.node(id).doc?.split('\n')[0];
  assert.equal(route('swift:Server:file:routes.routes(_:)'), 'GET /health'); // a closure: the function registering it
  assert.equal(route('swift:Server:file:routes.show(req:)'), 'GET /api/v1/orders/:id'); // grouped, then group { v1 in }
  assert.equal(route('swift:Server:OrdersController.index(req:)'), 'GET /orders');
  assert.equal(route('swift:Server:OrdersController.create(req:)'), 'POST /orders');
  assert.equal(route('swift:Server:OrdersController.delete(req:)'), 'DELETE /orders/:id'); // on(.DELETE, …)
  for (const id of ['swift:Server:file:routes.show(req:)', 'swift:Server:OrdersController.index(req:)']) assert.deepEqual(tags(id), ['entrypoint', 'route']);
  assert.ok(map.hasEdge('swift:Server:OrdersController.boot(routes:)', 'calls', 'swift:Server:OrdersController.index(req:)'));
  assert.ok(tags('swift:Server:OrdersController.boot(routes:)').includes('entrypoint'));
  assert.ok(tags('swift:Server:OrdersController').includes('controller'));
  assert.ok(tags('swift:Server:AuthMiddleware').includes('middleware'));
  assert.ok(tags('swift:Server:Order').includes('entity'));
});

test('closure parameters get their types from the callee: an array element, a function type parameter', async () => {
  const { scratch } = await import('./helpers.mjs');
  const { dir, dispose } = scratch({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "P", path: ".")])\n',
    'A.swift': `
struct Line { func total() -> Int { 1 } }
struct Order { var lines: [Line] = [] }
final class Loader {
  func load(completion: @escaping (Order) -> Void) {}
  func run(order: Order) {
    _ = order.lines.map { $0.total() }
    order.lines.forEach { line in _ = line.total() }
    load { loaded in _ = loaded.lines }
  }
}
`,
  });
  try {
    const fragment = run(dir);
    assert.ok(fragment.hasEdge('swift:P:Loader.run(order:)', 'calls', 'swift:P:Line.total()'));
    assert.ok(fragment.hasEdge('swift:P:Loader.run(order:)', 'calls', 'swift:P:Loader.load(completion:)'));
    assert.equal(fragment.edges.filter((e) => e.source === 'swift:P:Loader.run(order:)' && e.target === 'swift:P:Line.total()')[0].weight, 2);
    assert.ok(fragment.hasEdge('swift:P:Loader.run(order:)', 'accesses', 'swift:P:Order.lines'));
  } finally {
    dispose();
  }
});
