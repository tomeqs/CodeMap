import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './helpers.mjs';

const map = run('frameworks');
const tags = (id) => map.node(id).tags ?? [];
const edge = (source, kind, target) => assert.ok(map.hasEdge(source, kind, target), `no ${kind} ${source} → ${target}; ${kind} from it: ${map.edgesFrom(source, kind).join(', ') || 'none'}`);
const Q = 'cpp:cart:';
const TESTS = 'cpp:cart_tests:file:tests/';
const U = 'cpp:Shop:';

test('main is an entry point, with its holder; a program target too', () => {
  assert.deepEqual(tags(`${Q}file:qt/main#qt/::main(int,char*[])`), ['entrypoint']);
  assert.deepEqual(tags(`${Q}file:qt/main#qt/`), ['entrypoint']);
  assert.deepEqual(tags('cpp:project:cart'), ['entrypoint']);
});

test('GoogleTest, Catch2, doctest and Boost.Test tests are test functions; a fixture test runs as its fixture', () => {
  for (const id of [
    `${TESTS}gtest_test#tests/::Counter.StartsAtZero()`,
    `${TESTS}gtest_test#tests/::CounterTest.Counts()`,
    `${TESTS}catch_test#tests/::counter resets()`,
    `${TESTS}catch_test#tests/::counter counts()`,
    `${TESTS}boost_test#tests/::counts_up()`,
  ]) {
    assert.equal(map.node(id).kind, 'function', id);
    assert.ok(tags(id).includes('test'), id);
  }

  const counts = `${TESTS}gtest_test#tests/::CounterTest.Counts()`;
  edge(counts, 'uses', 'cpp:cart_tests:CounterTest');
  edge(counts, 'calls', 'cpp:cart_tests:CounterTest::start()'); // the fixture's own member
  edge(counts, 'accesses', 'cpp:cart_tests:CounterTest::counter');
  edge(`${TESTS}catch_test#tests/::counter resets()`, 'calls', `${Q}Counter::reset()`); // inside a SECTION
  assert.deepEqual(tags('cpp:project:cart_tests'), ['test-project']);
  // The fixture's header is the test project's (only its sources include it), its SetUp defined in a test file.
  assert.deepEqual(map.node('cpp:cart_tests:CounterTest::SetUp()').location, { file: 'tests/gtest_test.cpp', line: 4, endLine: 4 });
});

test('Qt Test: the private slots of a QTEST_MAIN class are tests', () => {
  assert.ok(tags('cpp:cart_tests:TestCart').includes('test'));
  assert.ok(tags('cpp:cart_tests:TestCart::refreshes()').includes('test'));
});

test('Qt: signals, slots and connect (member pointers or SIGNAL/SLOT), properties, QML-invokable members, widgets', () => {
  assert.deepEqual(map.node(`${Q}Counter::valueChanged(int)`).modifiers, ['signal']);
  assert.deepEqual(tags(`${Q}CartWidget::refresh()`), ['handler']);
  assert.deepEqual(tags(`${Q}CartWidget::onCounted(int)`), ['handler']);
  edge(`${Q}Counter::setValue(int)`, 'calls', `${Q}Counter::valueChanged(int)`); // emit
  edge(`${Q}CartWidget::CartWidget(QWidget*)`, 'subscribes', `${Q}Counter::valueChanged(int)`);
  edge(`${Q}CartWidget::CartWidget(QWidget*)`, 'uses', `${Q}CartWidget::onCounted(int)`);
  edge(`${Q}CartWidget::CartWidget(QWidget*)`, 'uses', `${Q}CartWidget::refresh()`); // SIGNAL(valueChanged(int)) → SLOT(refresh())
  // The signal's class does not depend on its receivers: a connection is not a cycle.
  assert.deepEqual(map.edgesFrom(`${Q}Counter::valueChanged(int)`), []);

  const property = map.node(`${Q}Counter::value`);
  assert.equal(property.kind, 'property');
  edge(`${Q}Counter::value`, 'calls', `${Q}Counter::value()`);
  edge(`${Q}Counter::value`, 'calls', `${Q}Counter::setValue(int)`);
  edge(`${Q}Counter::value`, 'uses', `${Q}Counter::valueChanged(int)`);
  assert.deepEqual(tags(`${Q}Counter::reset()`), ['maybe-used']);
  assert.deepEqual(tags(`${Q}CartWidget`), ['component']);
});

test('Unreal: Blueprint and network functions and game modes are entry points; _Implementation is the body; UINTERFACE', () => {
  assert.deepEqual(tags(`${U}AShopGameMode`), ['entrypoint']);
  assert.deepEqual(tags(`${U}AShopGameMode::OpenShop()`), ['entrypoint']);
  assert.deepEqual(map.node(`${U}AShopGameMode::OnSale(int32)`).location, { file: 'Source/Shop/ShopGameMode.cpp', line: 5, endLine: 5 });
  assert.deepEqual(tags(`${U}AShopGameMode::ServerBuy(int32)`), ['entrypoint']);
  edge(`${U}AShopGameMode::ServerBuy(int32)`, 'calls', `${U}AShopGameMode::Buy(int32)`); // from ServerBuy_Implementation
  assert.deepEqual(tags(`${U}AShopGameMode::ServerBuy_Validate(int32)`), ['entrypoint']);
  assert.equal(map.node(`${U}IShopper`).kind, 'interface');
  edge(`${U}AShopGameMode`, 'implements', `${U}IShopper`);
  edge(`${U}AShopGameMode::Buy(int32)`, 'implements', `${U}IShopper::Buy(int32)`);
  assert.ok(map.node(`${U}AShopGameMode::Restock()`).accessibility === 'private' && map.hasEdge(`${U}AShopGameMode::OpenShop()`, 'calls', `${U}AShopGameMode::Restock()`));
});
