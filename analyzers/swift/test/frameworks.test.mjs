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
  // A collection registered under a group: api.register(collection: OrdersController()).
  assert.equal(route('swift:Server:OrdersController.index(req:)'), 'GET /api/orders');
  assert.equal(route('swift:Server:OrdersController.create(req:)'), 'POST /api/orders');
  assert.equal(route('swift:Server:OrdersController.delete(req:)'), 'DELETE /api/orders/:id'); // on(.DELETE, …)
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

test('from the self-review: what is not a route, handlers of other types, environment types, runtime attributes, closures', async () => {
  const { scratch } = await import('./helpers.mjs');
  const { dir, dispose } = scratch({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "P", path: "Sources"), .testTarget(name: "PTests", path: "Tests")])\n',
    'Sources/Api.swift': `import Vapor

struct TodoController {
  func index(req: Request) async throws -> String { "" }
}

struct Api {
  func index(req: Request) async throws -> String { "" }
  func upload(req: Request) async throws -> String { "" }
  func notify(req: Request) async throws {
    _ = try await req.client.post("https://hooks.example.com/x") { r in }
  }
  func register(app: Application) {
    let c = TodoController()
    app.get("todos", use: c.index)
    app.on(.POST, "upload", body: .stream, use: upload)
  }
}
`,
    'Sources/Lib.swift': `import SwiftUI
import CoreData

print("not an entry point")

@Observable final class Store {}
struct S: View {
  @Environment(Store.self) private var store
  var body: some View { EmptyView() }
}

@_cdecl("swift_entry") private func entry() {}

final class Results: NSFetchedResultsController<NSManagedObject> {}

struct Line { func total() -> Int { 1 } }
final class Sorter {
  func with(_ f: (_ line: Line) -> Void) {}
  func run(lines: [Line]) {
    with { l in _ = l.total() }
    _ = lines.sorted { a, b in a.total() < b.total() }
  }
}
`,
    'Tests/HelperTests.swift': `import XCTest
final class HelperTests: XCTestCase {
  func testRuns() {}
  private func testFixture(named name: String) -> Int { 0 }
}
`,
  });
  try {
    const fragment = run(dir);
    const tagsOf = (id) => fragment.node(id).tags ?? [];
    assert.equal(fragment.node('swift:P:Api.notify(req:)').tags, undefined); // req.client.post(…) is a request, not a route
    assert.equal(fragment.node('swift:P:TodoController.index(req:)').doc, 'GET /todos'); // use: c.index, of c's type
    assert.equal(fragment.node('swift:P:Api.index(req:)').tags, undefined);
    assert.equal(fragment.node('swift:P:Api.upload(req:)').doc, 'POST /upload'); // body: .stream is no path part
    assert.equal(fragment.edges.filter((e) => e.source === 'swift:P:Api.register(app:)' && e.target === 'swift:P:Api.upload(req:)')[0]?.weight, 1);
    assert.ok(!tagsOf('swift:P:file:Lib.main').includes('entrypoint')); // top-level code of a library file
    assert.ok(fragment.hasEdge('swift:P:S', 'injects', 'swift:P:Store')); // @Environment(Store.self)
    assert.ok(tagsOf('swift:P:file:Lib.entry()').includes('maybe-used')); // @_cdecl
    assert.ok(!tagsOf('swift:P:Results').includes('component'));
    assert.ok(fragment.hasEdge('swift:P:Sorter.run(lines:)', 'calls', 'swift:P:Line.total()'));
    assert.equal(fragment.edges.find((e) => e.source === 'swift:P:Sorter.run(lines:)' && e.target === 'swift:P:Line.total()').weight, 3); // l, a and b
    assert.ok(tagsOf('swift:PTests:HelperTests.testRuns()').includes('test'));
  } finally {
    dispose();
  }
});
