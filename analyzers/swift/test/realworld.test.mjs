import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run, scratch } from './helpers.mjs';

// What mapping real repositories (Alamofire, Kingfisher, Vapor, swift-nio, swift-composable-architecture, Ice Cubes,
// Wikipedia iOS, swift-argument-parser, SwiftHub) showed, each as the smallest code that shows it.

const PACKAGE = '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "P", path: ".")])\n';

/** Maps the files as one target P, with the unresolved calls written out; returns the map and those lines. */
function mapWithMisses(files) {
  const { dir, dispose } = scratch({ 'Package.swift': PACKAGE, ...files });
  const file = join(dir, 'unresolved.txt');
  const before = process.env.CODEMAP_SWIFT_UNRESOLVED;
  process.env.CODEMAP_SWIFT_UNRESOLVED = file;
  try {
    const map = run(dir);
    const misses = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t'));
    return { map, misses };
  } finally {
    if (before === undefined) delete process.env.CODEMAP_SWIFT_UNRESOLVED;
    else process.env.CODEMAP_SWIFT_UNRESOLVED = before;
    dispose();
  }
}

test('calling a closure held in a property or a global reads it, and is no missed call of the map', () => {
  // Wikipedia iOS: 970 `completion(…)` calls counted as misses of the map's code, because a property was named so.
  const { map, misses } = mapWithMisses({
    'Loader.swift': `let onError: (Error) -> Void = { _ in }
final class Loader {
  var completion: ((Int) -> Void)?
  let onDone: () -> Void = {}
  func fire() {
    completion?(3)
    self.completion?(4)
    onDone()
  }
  func fail(_ error: Error) { onError(error) }
}
final class Caller {
  func run(_ loader: Loader) { loader.completion?(1) }
}
`,
  });
  assert.ok(map.hasEdge('swift:P:Loader.fire()', 'accesses', 'swift:P:Loader.completion'));
  assert.ok(map.hasEdge('swift:P:Loader.fire()', 'accesses', 'swift:P:Loader.onDone'));
  assert.ok(map.hasEdge('swift:P:Caller.run(_:)', 'accesses', 'swift:P:Loader.completion'));
  assert.ok(map.hasEdge('swift:P:Loader.fail(_:)', 'accesses', 'swift:P:file:Loader.onError'));
  assert.deepEqual(misses.filter((m) => m[1] === '*').map((m) => m[2]), [], 'none of them is a missed call of the map');
});

test('the unresolved calls are listed with where they are', () => {
  const { misses } = mapWithMisses({
    'A.swift': 'final class A {\n  func a() {}\n}\nfunc use(_ x: Any) {\n  (x as AnyObject).a()\n  (x as AnyObject).a()\n}\n',
  });
  const a = misses.find((m) => m[2] === 'a');
  assert.deepEqual(a.slice(0, 2), ['2', '*']);
  assert.equal(a[3], 'A.swift:5 A.swift:6');
});

test("a call on an array or a dictionary is Array's, or what the map's extensions of collections add", () => {
  // Wikipedia iOS: 836 `views.append(…)` on `var views: [View]` counted as missed calls of the map, which declares an
  // `append` elsewhere: an array receiver was dropped.
  const { map, misses } = mapWithMisses({
    'Model.swift': `struct Item { let n: Int }
extension Collection {
  func element(at index: Index) -> Element? { indices.contains(index) ? self[index] : nil }
}
extension Array where Element == Item {
  func total() -> Int { reduce(0) { $0 + $1.n } }
}
extension Dictionary {
  func keyList() -> [Key] { Array(keys) }
}
struct Box { func append(_ x: Int) {} }
final class Model {
  var items: [Item] = [] { didSet {} }
  var byName: [String: Item] = [:]
  func run() -> Int {
    var local: [Item] = []
    local.append(Item(n: 1))
    items.append(Item(n: 2))
    _ = items.element(at: 0)
    _ = byName.keyList()
    return local.total()
  }
}
`,
  });
  assert.ok(map.hasEdge('swift:P:Model.run()', 'calls', 'swift:P:extension:Collection.element(at:)'));
  assert.ok(map.hasEdge('swift:P:Model.run()', 'calls', 'swift:P:extension:Array.total()'));
  assert.ok(map.hasEdge('swift:P:Model.run()', 'calls', 'swift:P:extension:Dictionary.keyList()'));
  assert.ok(!map.hasEdge('swift:P:Model.run()', 'calls', 'swift:P:Box.append(_:)'));
  assert.deepEqual(misses.filter((m) => m[1] === '*').map((m) => m[2]), [], "append on an array is Array's, not a missed call of the map");
});

test("an outside type's shared instance (UIApplication.shared, Calendar.current) reaches what the map adds to it", () => {
  const { map, misses } = mapWithMisses({
    'App.swift': `import UIKit
extension UIApplication {
  func topController() -> UIViewController? { nil }
}
struct Day { let date: Date }
final class Router {
  func show() {
    _ = UIApplication.shared.topController()
    _ = Calendar.current.date(byAdding: .day, value: 1, to: Date())
  }
}
`,
  });
  assert.ok(map.hasEdge('swift:P:Router.show()', 'calls', 'swift:P:extension:UIApplication.topController()'));
  assert.deepEqual(misses.filter((m) => m[1] === '*').map((m) => m[2]), [], "Calendar's date(byAdding:…) is not the map's `date`");
});

test('a generic type called with its type arguments (Backend<String>(…)) is an initializer call, and types what it makes', () => {
  // Kingfisher's tests: `let storage = try! DiskStorage.Backend<String>(config:)`, then `storage.store(…)` 68 times.
  const { map, misses } = mapWithMisses({
    'Storage.swift': `enum Storage {
  final class Backend<T> {
    init(config: Int) {}
    func store(value: T, forKey key: String) {}
  }
}
struct Item { func touch() {} }
final class Subject<T> { init() {} }
func use() throws {
  _ = Subject<Item>()
  let storage = try! Storage.Backend<String>(config: 1)
  storage.store(value: "1", forKey: "1")
  let items = Array<Item>(repeating: Item(), count: 2)
  items.first?.touch()
}
`,
  });
  assert.ok(map.hasEdge('swift:P:file:Storage.use()', 'instantiates', 'swift:P:Storage.Backend'));
  assert.ok(map.hasEdge('swift:P:file:Storage.use()', 'calls', 'swift:P:Storage.Backend.init(config:)'));
  assert.ok(map.hasEdge('swift:P:file:Storage.use()', 'calls', 'swift:P:Storage.Backend.store(value:forKey:)'));
  assert.ok(map.hasEdge('swift:P:file:Storage.use()', 'calls', 'swift:P:Item.touch()'));
  assert.ok(map.hasEdge('swift:P:file:Storage.use()', 'uses', 'swift:P:Item'), 'a type argument is a use');
  assert.ok(map.hasEdge('swift:P:file:Storage.use()', 'instantiates', 'swift:P:Subject'));
  assert.deepEqual(misses.filter((m) => m[1] === '*').map((m) => m[2]), []);
});

test("a documentation catalog's tutorial code (*.docc) is not on the map", () => {
  // swift-composable-architecture keeps 475 Swift files of tutorial steps in its .docc catalogs, each a near copy of
  // the same code; no target compiles them.
  const { map } = mapWithMisses({
    'Sources/P/Feature.swift': 'struct Feature { func run() {} }\n',
    'Sources/P/Documentation.docc/Tutorials/Step-01.swift': 'struct Feature { func run() {} }\nstruct TutorialOnly {}\n',
  });
  assert.ok(map.has('swift:P:Feature'));
  assert.ok(!map.has('swift:P:TutorialOnly'));
  assert.deepEqual(map.node('swift:P:Feature').extraLocations ?? [], []);
});
