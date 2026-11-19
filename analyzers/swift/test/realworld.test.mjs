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

test("a bare call of a name nothing the caller sees declares is Swift's or a framework's; a capitalized one makes that type", () => {
  // swift-nio: 1,236 `XCTAssertNoThrow(…)` and 343 `assert(…)` counted as missed calls of the map, because one test
  // target declares its own internal XCTAssertNoThrow; `semaphore.wait()` on a DispatchSemaphore(value: 0) too.
  const { map, misses } = mapWithMisses({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "P"), .testTarget(name: "PTests"), .testTarget(name: "OtherTests", dependencies: ["P"])])\n',
    'Sources/P/Waiter.swift': `import Dispatch
public final class Waiter {
  public init() {}
  public func wait() {}
  func assert(_ ok: Bool) {}
  func check() { assert(true) }
}
extension DispatchSemaphore {
  public func waitBriefly() {}
}
`,
    'Tests/PTests/Helpers.swift': 'func XCTAssertNoThrow<T>(_ expression: @autoclosure () throws -> T) {}\n',
    'Tests/OtherTests/WaiterTests.swift': `import XCTest
import Dispatch
import P
final class WaiterTests: XCTestCase {
  func testWait() {
    XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: [:]))
    assert(true)
    let semaphore = DispatchSemaphore(value: 0)
    semaphore.wait()
    semaphore.waitBriefly()
  }
}
`,
  });
  assert.ok(map.hasEdge('swift:P:Waiter.check()', 'calls', 'swift:P:Waiter.assert(_:)'), "a type's own member still wins");
  assert.ok(map.hasEdge('swift:OtherTests:WaiterTests.testWait()', 'calls', 'swift:P:extension:DispatchSemaphore.waitBriefly()'));
  assert.ok(!map.hasEdge('swift:OtherTests:WaiterTests.testWait()', 'calls', 'swift:P:Waiter.wait()'));
  assert.deepEqual(misses.filter((m) => m[1] === '*').map((m) => m[2]), []);
});

test("an Xcode target depending on one whose files a package holds, or linking a framework another project builds, depends on the package's target", () => {
  // Kingfisher: its .xcodeproj's tests depend on the project's Kingfisher framework target, whose files Package.swift
  // holds, and the demo project links Kingfisher.framework: the tests and the four demos saw none of Kingfisher.
  const { map } = mapWithMisses({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Lib", targets: [.target(name: "Lib")])\n',
    'Sources/Lib/Store.swift': 'public final class Store {\n  public init() {}\n  public func load() -> Int { 1 }\n}\n',
    'Tests/LibTests/StoreTests.swift': 'import XCTest\nimport Lib\nfinal class StoreTests: XCTestCase {\n  func testLoad() { XCTAssertEqual(Store().load(), 1) }\n}\n',
    'Lib.xcodeproj/project.pbxproj': `{ objects = {
  R = { isa = PBXProject; mainGroup = G; targets = (TL, TT); };
  G = { isa = PBXGroup; children = (F1, F2); sourceTree = "<group>"; };
  F1 = { isa = PBXFileReference; path = Sources/Lib/Store.swift; sourceTree = "<group>"; };
  F2 = { isa = PBXFileReference; path = Tests/LibTests/StoreTests.swift; sourceTree = "<group>"; };
  B1 = { isa = PBXBuildFile; fileRef = F1; };
  B2 = { isa = PBXBuildFile; fileRef = F2; };
  SL = { isa = PBXSourcesBuildPhase; files = (B1); };
  ST = { isa = PBXSourcesBuildPhase; files = (B2); };
  TL = { isa = PBXNativeTarget; name = Lib; productType = "com.apple.product-type.framework"; buildPhases = (SL); };
  D1 = { isa = PBXTargetDependency; target = TL; };
  TT = { isa = PBXNativeTarget; name = LibTests; productType = "com.apple.product-type.bundle.unit-test"; buildPhases = (ST); dependencies = (D1); };
}; rootObject = R; }`,
    'Demo/App.swift': 'import UIKit\nimport Lib\nfinal class AppController {\n  func start() -> Int { Store().load() }\n}\n',
    'Demo/Demo.xcodeproj/project.pbxproj': `{ objects = {
  R = { isa = PBXProject; mainGroup = G; targets = (TA); };
  G = { isa = PBXGroup; children = (F1, FW, UK); sourceTree = "<group>"; };
  F1 = { isa = PBXFileReference; path = App.swift; sourceTree = "<group>"; };
  FW = { isa = PBXFileReference; path = Lib.framework; sourceTree = BUILT_PRODUCTS_DIR; };
  UK = { isa = PBXFileReference; name = UIKit.framework; path = System/Library/Frameworks/UIKit.framework; sourceTree = SDKROOT; };
  B1 = { isa = PBXBuildFile; fileRef = F1; };
  BF = { isa = PBXBuildFile; fileRef = FW; };
  BU = { isa = PBXBuildFile; fileRef = UK; };
  S = { isa = PBXSourcesBuildPhase; files = (B1); };
  FP = { isa = PBXFrameworksBuildPhase; files = (BF, BU); };
  TA = { isa = PBXNativeTarget; name = Demo; productType = "com.apple.product-type.application"; buildPhases = (S, FP); };
}; rootObject = R; }`,
  });
  assert.ok(map.hasEdge('swift:project:LibTests', 'projectReference', 'swift:project:Lib'));
  assert.ok(map.hasEdge('swift:project:Demo', 'projectReference', 'swift:project:Lib'));
  assert.deepEqual(map.edgesFrom('swift:project:Demo', 'projectReference'), ['swift:project:Lib'], 'UIKit.framework is not a project of the map');
  assert.ok(map.hasEdge('swift:LibTests:StoreTests.testLoad()', 'calls', 'swift:Lib:Store.load()'));
  assert.ok(map.hasEdge('swift:Demo:AppController.start()', 'calls', 'swift:Lib:Store.load()'));
});

test('foo(x) { … } is one call of foo with its trailing closure', () => {
  // swift-composable-architecture: `let store = TestStore(initialState: …) { Feature() }` read as a call of
  // TestStore(initialState:)'s result, so `store` had no type and 782 `store.send(…)` were missed.
  const { map, misses } = mapWithMisses({
    'Store.swift': `final class Store {
  init(initialState: Int, reducer: () -> Int) {}
  func send(_ action: Int) {}
}
final class Runner {
  func run(_ x: Int) {}
  func run(_ x: Int, then: () -> Void) {}
}
func use() {
  let store = Store(initialState: 1) { 2 }
  store.send(3)
  Runner().run(1) { }
}
`,
  });
  assert.ok(map.hasEdge('swift:P:file:Store.use()', 'calls', 'swift:P:Store.init(initialState:reducer:)'));
  assert.ok(map.hasEdge('swift:P:file:Store.use()', 'calls', 'swift:P:Store.send(_:)'));
  assert.ok(map.hasEdge('swift:P:file:Store.use()', 'calls', 'swift:P:Runner.run(_:then:)'));
  assert.ok(!map.hasEdge('swift:P:file:Store.use()', 'calls', 'swift:P:Runner.run(_:)'), 'the closure is an argument of run');
  assert.deepEqual(misses.filter((m) => m[1] === '*').map((m) => m[2]), []);
});

test('a tie between overloads goes to the one not marked @_disfavoredOverload; an async twin keeps the result of the other', () => {
  // swift-nio: `pipeline.syncOperations.addHandler(handler)` has a deprecated twin marked @_disfavoredOverload (584
  // missed), and `channel.close().wait()` met close(mode:file:line:)'s `async` twin, which returns nothing (727 missed).
  const { map, misses } = mapWithMisses({
    'Pipeline.swift': `public final class Future<T> {
  public func wait() throws -> T { fatalError() }
}
public protocol Invoker {}
extension Invoker {
  public func close(mode: Int = 0, line: UInt = #line) async throws {}
}
extension Invoker {
  public func close(mode: Int = 0, line: UInt = #line) -> Future<Void> { Future() }
}
public final class Operations {
  public enum Position { case last }
  public func addHandler(_ handler: AnyObject, name: String? = nil, position: Operations.Position = .last) {}
  @available(*, deprecated)
  @_disfavoredOverload
  public func addHandler(_ handler: AnyObject, name: String? = nil, position: Int = 0) {}
}
final class Channel: Invoker {
  let operations = Operations()
  func shutdown(_ handler: AnyObject) throws {
    operations.addHandler(handler)
    try close().wait()
  }
}
`,
  });
  assert.ok(map.hasEdge('swift:P:Channel.shutdown(_:)', 'calls', 'swift:P:Operations.addHandler(_:AnyObject,name:String?,position:Operations.Position)'));
  assert.ok(map.hasEdge('swift:P:Channel.shutdown(_:)', 'calls', 'swift:P:Future.wait()'));
  assert.deepEqual(misses.filter((m) => m[1] === '*').map((m) => m[2]), []);
});

test("what another target adds to a type of the map is the type's, for the targets that see it", () => {
  // Vapor: VaporTesting's `extension Application { func testing(…) }`, called 206 times as `app.testing { … }`.
  const { map } = mapWithMisses({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "Core"), .target(name: "Testing", dependencies: ["Core"]), .testTarget(name: "CoreTests", dependencies: ["Core", "Testing"]), .target(name: "Other", dependencies: ["Core"])])\n',
    'Sources/Core/Application.swift': 'public final class Application {\n  public init() {}\n  public var name = "app"\n}\n',
    'Sources/Testing/Application+Testing.swift': 'import Core\nextension Application {\n  public func testing(_ method: Int = 0, _ body: (Application) -> Void) { body(self) }\n  public var testName: String { name }\n}\n',
    'Tests/CoreTests/AppTests.swift': 'import XCTest\nimport Core\nimport Testing\nfinal class AppTests: XCTestCase {\n  func testIt() {\n    let app = Application()\n    app.testing { _ in }\n    _ = app.testName\n  }\n}\n',
    'Sources/Other/Use.swift': 'import Core\nfunc use(_ app: Application) {\n  app.testing { _ in }\n}\n',
  });
  assert.ok(map.hasEdge('swift:CoreTests:AppTests.testIt()', 'calls', 'swift:Testing:extension:Application.testing(_:_:)'));
  assert.ok(map.hasEdge('swift:CoreTests:AppTests.testIt()', 'accesses', 'swift:Testing:extension:Application.testName'));
  assert.ok(!map.hasEdge('swift:Other:file:Use.use(_:)', 'calls', 'swift:Testing:extension:Application.testing(_:_:)'), 'Other does not see Testing');
});
