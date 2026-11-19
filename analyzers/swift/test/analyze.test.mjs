import assert from 'node:assert/strict';
import test from 'node:test';
import { run, scratch } from './helpers.mjs';

const map = run('package');

test('targets, their folders, and the dependencies between them and on packages', () => {
  assert.deepEqual(map.nodes.filter((n) => n.kind === 'project').map((n) => n.id), ['swift:project:Domain', 'swift:project:Shop', 'swift:project:Shop iOS', 'swift:project:ShopTests', 'swift:project:package', 'swift:project:shop-cli']);
  const shop = map.node('swift:project:Shop');
  assert.deepEqual(shop.location, { file: 'Package.swift', line: 12, endLine: 12 });
  assert.equal(shop.signature, '.target');
  assert.deepEqual(map.node('swift:project:ShopTests').tags, ['test-project']);
  assert.deepEqual(map.node('swift:project:shop-cli').tags, ['entrypoint']);
  assert.ok(map.hasEdge('swift:project:Shop', 'projectReference', 'swift:project:Domain'));
  assert.ok(map.hasEdge('swift:project:Shop', 'packageReference', 'swift:pkg:swift-log'));
  assert.equal(map.node('swift:pkg:swift-log').external, true);
  // Folders within a target are its namespaces; the files at its top are in the target's own.
  assert.equal(map.node('swift:Domain:Order').parent, 'swift:ns:Domain/');
  assert.equal(map.node('swift:ns:Domain/').name, 'Domain');
  assert.equal(map.node('swift:Domain:OrderRepository').parent, 'swift:ns:Domain/Orders');
  assert.equal(map.node('swift:ns:Domain/Orders').fullName, 'Domain/Orders');
});

test('types: kinds, access, modifiers, nesting, documentation, enum cases', () => {
  const order = map.node('swift:Domain:Order');
  assert.equal(order.kind, 'struct');
  assert.equal(order.accessibility, 'public');
  assert.equal(order.doc, 'An order of a customer.');
  assert.equal(order.signature, 'public struct Order: Identifiable, Hashable');
  assert.equal(map.node('swift:Domain:Order.Line').parent, 'swift:Domain:Order');
  assert.equal(map.node('swift:Domain:Order.Status').metrics.enumMembers, 3);
  assert.equal(map.node('swift:Domain:OrderRepository').kind, 'interface');
  // open is public, and stays a modifier; fileprivate is private.
  const checkout = map.node('swift:Shop:Checkout');
  assert.equal(checkout.accessibility, 'public');
  assert.ok(checkout.modifiers.includes('open'));
  assert.deepEqual(checkout.attributes, ['MainActor']);
  assert.equal(map.node('swift:Domain:Cache').accessibility, 'private');
  assert.equal(map.node('swift:Domain:Order.audit()').accessibility, 'private');
  assert.ok(map.node('swift:Domain:Order.audit()').modifiers.includes('fileprivate'));
  assert.equal(map.node('swift:Shop:CheckoutDelegate').accessibility, 'internal');
  assert.equal(map.node('swift:Shop iOS:AppDelegate').baseType, 'UIResponder');
  assert.equal(map.node('swift:Shop:TouchCheckout').baseType, 'Checkout');
});

test('an extension of a type of the target is that type: its members, its file as another place', () => {
  const order = map.node('swift:Domain:Order');
  assert.deepEqual(order.extraLocations, [{ file: 'Sources/Domain/Order+Totals.swift', line: 1, endLine: 4 }]);
  assert.equal(map.node('swift:Domain:Order.description').parent, 'swift:Domain:Order');
  assert.equal(map.node('swift:Domain:Order.description').location.file, 'Sources/Domain/Order+Totals.swift');
  assert.equal(map.node('swift:Domain:Order.count').kind, 'property');
  assert.equal(order.metrics.loc, 35);
});

test('an extension of a type from outside is an extension node of the target and folder', () => {
  const string = map.node('swift:Domain:extension:String');
  assert.equal(string.kind, 'extension');
  assert.equal(string.level, 'type');
  assert.equal(string.fullName, 'extension String');
  assert.equal(string.parent, 'swift:ns:Domain/');
  assert.equal(map.node('swift:Domain:extension:String.trimmed()').kind, 'method');
});

test('members: ids with argument labels, the types only when two share their labels', () => {
  assert.ok(map.has('swift:Domain:Order.add(_:quantity:)'));
  assert.ok(map.has('swift:Domain:Order.add(line:at:)'));
  assert.ok(map.has('swift:Domain:Order.add(_:Line)'));
  assert.ok(map.has('swift:Domain:Order.add(_:[Line])'));
  assert.ok(map.has('swift:Domain:Order.init(id:)'));
  assert.ok(map.has('swift:Shop:Checkout.deinit()'));
  assert.ok(map.has('swift:Domain:OrderRepository.save(_:)'));
  const add = map.node('swift:Domain:Order.add(_:quantity:)');
  assert.equal(add.doc, 'Adds a line; a quantity of zero is ignored.');
  assert.deepEqual(add.metrics, { loc: 5, complexity: 3, parameters: 2 });
  assert.deepEqual(add.modifiers, ['mutating']);
  assert.equal(add.fullName, 'Order.add(_:quantity:)');
  assert.deepEqual(map.node('swift:Shop:Checkout.pay(_:)').modifiers, ['async', 'open', 'throws']);
  assert.equal(map.node('swift:Shop:Checkout.pay(_:)').metrics.complexity, 4); // guard + 2 cases
});

test('stored properties are fields, computed ones properties; let is readonly, private(set) a modifier', () => {
  assert.equal(map.node('swift:Domain:Order.id').kind, 'field');
  assert.deepEqual(map.node('swift:Domain:Order.id').modifiers, ['readonly']);
  assert.deepEqual(map.node('swift:Domain:Order.lines').modifiers, ['private(set)']);
  assert.equal(map.node('swift:Domain:Order.lines').accessibility, 'public');
  assert.deepEqual(map.node('swift:Domain:Order.created').modifiers, ['static']);
  assert.deepEqual(map.node('swift:Shop:Checkout.delegate').modifiers, ['weak']);
  assert.equal(map.node('swift:Domain:OrderRepository.name').kind, 'property');
  assert.deepEqual(map.node('swift:Domain:OrderRepository.Failure').modifiers, ['associatedtype']);
});

test('free functions and globals in a holder per file; main.swift top-level code is an entry point', () => {
  const holder = map.node('swift:Shop:file:Checkout');
  assert.equal(holder.kind, 'module');
  assert.equal(holder.level, 'type');
  assert.equal(map.node('swift:Shop:file:Checkout.defaultCurrency').kind, 'variable');
  assert.ok(map.has('swift:Shop:file:Checkout.formatPrice(_:Double)'));
  assert.ok(map.has('swift:Shop:file:Checkout.formatPrice(_:Int)'));
  const main = map.node('swift:shop-cli:file:main.main');
  assert.deepEqual(main.tags, ['entrypoint']);
  assert.deepEqual(main.location, { file: 'Sources/shop-cli/main.swift', line: 4, endLine: 6 });
  assert.equal(main.metrics.complexity, 2);
  assert.deepEqual(map.node('swift:shop-cli:file:main').tags, ['entrypoint']);
});

test('both branches of an #if are read; one type in both is one node with two places', () => {
  const touch = map.node('swift:Shop:TouchCheckout');
  assert.equal(touch.location.line, 33);
  assert.deepEqual(touch.extraLocations.map((l) => l.line), [35]);
});

test('tests are tagged and can be left out; generated files are skipped', () => {
  assert.deepEqual(map.node('swift:ShopTests:CheckoutTests').tags, ['test']);
  assert.ok(map.analysis.warnings.includes('1 generated file(s) were skipped.'));
  assert.ok(!map.has('swift:package:L10n'));
  const without = run('package', { options: { includeTests: false } });
  assert.ok(!without.has('swift:ShopTests:CheckoutTests'));
  assert.ok(without.analysis.warnings.includes('1 test file(s) were left out.'));
});

test('an .xcodeproj alone: its targets, the map named after it', () => {
  const xcode = run('package/Shop.xcodeproj');
  assert.deepEqual(xcode.nodes.filter((n) => n.kind === 'project').map((n) => n.id), ['swift:project:Shop iOS']);
  assert.ok(xcode.has('swift:Shop iOS:Order'));
  assert.deepEqual({ kind: xcode.source.kind, name: xcode.source.name }, { kind: 'project', name: 'Shop' });
  const pkg = run('package/Package.swift');
  assert.equal(pkg.source.name, 'package');
});

test('a SwiftUI app: @main and the attributes of its types', () => {
  const app = run('xcode');
  assert.deepEqual(app.node('swift:Store:StoreApp').attributes, ['main']);
  assert.equal(app.node('swift:Store:StoreApp.body').kind, 'property');
  assert.equal(app.node('swift:Store:CartView').parent, 'swift:ns:Store/Features/Cart');
});

test('a file the grammar cannot follow is still mapped as far as it reads, and two private types of one name are two', () => {
  const { dir, dispose } = scratch({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "P", path: ".")])\n',
    'A.swift': 'private struct Helper { func a() {} }\n',
    'B.swift': 'private struct Helper { func b() {} }\nstruct Fine { func ok() {} }\nlet x = "\\(1)/*"\n',
  });
  try {
    const fragment = run(dir);
    assert.ok(fragment.has('swift:P:Helper'));
    assert.ok(fragment.has('swift:P:Helper@B.swift'));
    assert.ok(fragment.has('swift:P:Fine.ok()'));
  } finally {
    dispose();
  }
});
