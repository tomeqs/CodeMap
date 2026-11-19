import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './helpers.mjs';

const map = run('resolve');
const S = 'swift:Services:';
const D = 'swift:Domain:';
const edge = (source, kind, target) => assert.ok(map.hasEdge(source, kind, target), `no ${source} -${kind}-> ${target}; from it: ${map.edges.filter((e) => e.source === source).map((e) => `${e.kind} ${e.target}`).join(', ')}`);
const noEdge = (source, kind, target) => assert.ok(!map.hasEdge(source, kind, target), `unexpected ${source} -${kind}-> ${target}`);

test('inheritance, conformance (of types and of members) and overrides', () => {
  edge(`${S}OrderService`, 'inherits', `${S}BaseService`);
  edge(`${S}StripeGateway`, 'implements', `${S}PaymentGateway`);
  edge(`${S}StripeGateway.charge(_:)`, 'implements', `${S}PaymentGateway.charge(_:)`);
  edge(`${D}Receipt`, 'implements', `${D}Priced`);
  edge(`${D}Receipt.amount`, 'implements', `${D}Priced.amount`);
  edge(`${S}OrderService.log(_:)`, 'overrides', `${S}BaseService.log(_:)`);
});

test('what declarations name: holds, accepts, returns, injects, constraints, property wrappers', () => {
  edge(`${S}OrderService.gateway`, 'holds', `${S}PaymentGateway`);
  edge(`${D}Order.lines`, 'holds', `${D}Order.Line`); // [Line] in the type's own scope
  edge(`${S}OrderService.last`, 'holds', `${D}Order`); // Order? of another target
  edge(`${S}OrderService.place(_:)`, 'accepts', `${D}Order`);
  edge(`${S}OrderService.place(_:)`, 'returns', `${D}Receipt`);
  edge(`${S}OrderService`, 'injects', `${S}PaymentGateway`);
  edge(`${S}OrderService.sorted(_:)`, 'uses', `${D}Priced`); // <T: Priced>
  edge(`${S}OrderService.retries`, 'decoratedWith', `${D}Clamped`);
});

test('calls through parameters, locals, try, optional binding, for loops and chains', () => {
  const place = `${S}OrderService.place(_:)`;
  edge(place, 'calls', `${D}Order.validated()`); // try order.validated()
  edge(place, 'calls', `${D}Order.Line.total()`); // for line in checked.lines { line.total() }
  edge(place, 'calls', `${D}Order.line(at:)`); // if let first = order.line(at: 0)
  edge(place, 'accesses', `${D}Order.Line.price`); // first.price
  edge(place, 'calls', `${S}PaymentGateway.charge(_:)`); // through the protocol the property holds
  edge(place, 'accesses', `${S}OrderService.gateway`);
  edge(place, 'accesses', `${D}Receipt.amount`);
  edge(`${S}OrderService.retry()`, 'calls', `${D}Order.Line.total()`); // Order.empty.lines.first?.total()
  edge(`${S}OrderService.retry()`, 'accesses', `${D}Order.note`); // last?.note
});

test('overloads: by labels, the most derived member, and the types of the arguments', () => {
  // log(…) is the override, not BaseService's; format(_:) by what is passed.
  edge(`${S}OrderService.retry()`, 'calls', `${S}OrderService.log(_:)`);
  noEdge(`${S}OrderService.retry()`, 'calls', `${S}BaseService.log(_:)`);
  edge(`${S}OrderService.place(_:)`, 'calls', `${S}OrderService.format(_:Int)`); // receipt.amount: Int
  edge(`${S}OrderService.retry()`, 'calls', `${S}OrderService.format(_:String)`); // a string literal
  noEdge(`${S}OrderService.retry()`, 'calls', `${S}OrderService.format(_:Int)`);
});

test('initializers, static members, super and self', () => {
  edge(`${S}StripeGateway.charge(_:)`, 'calls', `${D}Receipt.init(amount:)`);
  edge(`${S}StripeGateway.charge(_:)`, 'instantiates', `${D}Receipt`);
  edge(`${S}OrderService.place(_:)`, 'calls', `${D}Order.make(lines:)`);
  edge(`${S}OrderService.place(_:)`, 'uses', `${D}Order`); // a static member is a use of the type
  edge(`${S}OrderService.init(gateway:)`, 'calls', `${S}BaseService.init()`); // super.init()
  noEdge(`${S}OrderService.init(gateway:)`, 'instantiates', `${S}BaseService`);
  edge(`${S}OrderService.log(_:)`, 'calls', `${S}BaseService.log(_:)`); // super.log
  edge(`${D}Order.make(lines:)`, 'instantiates', `${D}Order`);
});

test('implicit members: of a declared type, of a parameter, in an array argument', () => {
  edge(`${S}OrderService.retry()`, 'instantiates', `${D}Order`); // let empty: Order = .init()
  edge(`${S}OrderService.quick()`, 'uses', `${S}Channel`); // via: .standard
  edge(`${S}OrderService.quick()`, 'instantiates', `${D}Order.Line`); // make(lines: [.init(price: 1)])
});

test('errors, casts, selectors and extensions of types from outside', () => {
  edge(`${D}Order.validated()`, 'throws', `${D}OrderError`);
  edge(`${S}OrderService.place(_:)`, 'throws', `${D}OrderError`); // throw OrderError.declined(reason:)
  edge(`${S}OrderService.retry()`, 'catches', `${D}OrderError`);
  edge(`${S}OrderService.place(_:)`, 'uses', `${S}StripeGateway`); // as? StripeGateway
  edge(`${S}OrderService.place(_:)`, 'calls', `${S}StripeGateway.refresh()`); // #selector
  edge(`${S}OrderService.log(_:)`, 'calls', `${D}extension:String.slug()`); // message.slug()
  edge(`${S}OrderService.retry()`, 'calls', `${D}extension:String.slug()`); // last?.note?.slug()
});

test('a name used on something of unknown type keeps private members of that name from being reported unused', () => {
  const { dir, dispose } = scratchPackage({
    'A.swift': 'final class A {\n  private func refresh() {}\n  private func unused() {}\n  func run(_ x: Unknown) { x.refresh() }\n}\n',
  });
  try {
    const fragment = run(dir);
    assert.deepEqual(fragment.node('swift:P:A.refresh()').tags, ['maybe-used']);
    assert.equal(fragment.node('swift:P:A.unused()').tags, undefined);
  } finally {
    dispose();
  }
});

import { scratch } from './helpers.mjs';

function scratchPackage(files) {
  return scratch({ 'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "P", path: ".")])\n', ...files });
}

test('from the self-review: subscripts, variadics, defaults, recursion, case patterns, scopes, labels, implicit members', () => {
  const { dir, dispose } = scratchPackage({
    'Box.swift': `
struct Line { func total() -> Int { 1 } }
enum Kind { case outlet, other }
enum Failure: Error { case bad(String) }
protocol Printable { func describe() -> String }
extension Int: Printable { func describe() -> String { "" } }

final class Box {
  private var lines: [Line] = []
  var outlet = 0
  var cnt = 0
  let made: Line = .init()

  func first() -> Int { lines[0].total() }
  func sum(of values: Int...) -> Int { 0 }
  func total() -> Int { sum(of: 1, 2, 3) }
  func f(a: Int = 0, b: String) {}
  func f(a: Int = 0, b: Int) {}
  func callF() { f(b: "x") }
  func fact(_ n: Int) -> Int { n <= 1 ? 1 : n * fact(n - 1) }
  func pick(_ k: Kind) -> Int {
    switch k {
    case .outlet: return outlet
    case .other: return 0
    }
  }
  func shadow() -> Int {
    let a = [1].map { cnt in cnt + 1 }
    return cnt + a.count
  }
  func esc(\`default\` v: Int) {}
  func callEsc() { esc(default: 1) }
  func boom() throws { throw Failure.bad("x") }
}
`,
  });
  try {
    const fragment = run(dir);
    const has = (source, kind, target) => assert.ok(fragment.hasEdge(`swift:P:${source}`, kind, `swift:P:${target}`), `no ${source} -${kind}-> ${target}; from it: ${fragment.edgesFrom(`swift:P:${source}`).join(', ')}`);
    has('Box.first()', 'accesses', 'Box.lines'); // lines[0] through implicit self
    has('Box.total()', 'calls', 'Box.sum(of:)'); // a labelled variadic
    has('Box.callF()', 'calls', 'Box.f(a:String,b:String)'.replace('a:String', 'a:Int')); // the argument against the parameter it goes to
    has('Box.fact(_:)', 'calls', 'Box.fact(_:)'); // recursion
    has('Box.pick(_:)', 'accesses', 'Box.outlet'); // `case .outlet:` is not a local
    has('Box.shadow()', 'accesses', 'Box.cnt'); // a closure's parameter is its own
    has('Box.callEsc()', 'calls', 'Box.esc(default:)'); // a label in backticks
    has('Box.made', 'instantiates', 'Line'); // let made: Line = .init()
    has('extension:Int.describe()', 'implements', 'Printable.describe()'); // an extension of a type from outside
    const uses = fragment.edges.filter((e) => e.source === 'swift:P:Box.boom()' && e.kind === 'uses' && e.target === 'swift:P:Failure');
    assert.deepEqual(uses.map((e) => e.weight), [1]); // one use, not two
    has('Box.boom()', 'throws', 'Failure');
  } finally {
    dispose();
  }
});
