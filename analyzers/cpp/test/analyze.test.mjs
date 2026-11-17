import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { fixtures, run, scratch } from './helpers.mjs';

const P = 'cpp:project:';
const DOMAIN = 'cpp:shop_domain:';

test('CMake targets and a Makefile folder are projects, with their references and libraries', () => {
  const map = run('mini');
  const projects = map.nodes.filter((n) => n.kind === 'project').map((n) => n.id);
  assert.deepEqual(projects, [`${P}legacy`, `${P}shop_cli`, `${P}shop_domain`, `${P}shop_tests`]);
  assert.ok(map.hasEdge(`${P}shop_cli`, 'projectReference', `${P}shop_domain`));
  assert.ok(map.hasEdge(`${P}shop_tests`, 'projectReference', `${P}shop_domain`));
  assert.ok(map.hasEdge(`${P}shop_cli`, 'packageReference', 'cpp:lib:fmt::fmt'));
  assert.equal(map.node('cpp:lib:fmt::fmt').external, true);
  assert.deepEqual(map.node(`${P}shop_tests`).tags, ['test-project']);
  assert.deepEqual(map.node(`${P}shop_cli`).tags, ['entrypoint']);
  assert.equal(map.node(`${P}shop_domain`).signature, 'CMake · library');
  assert.deepEqual(map.node(`${P}shop_domain`).location, { file: 'CMakeLists.txt', line: 5, endLine: 5 });
  assert.deepEqual(map.node(`${P}legacy`).metrics, { files: 2, lines: 30 });
  assert.deepEqual(map.analysis.warnings, []);
});

test('namespaces are C++ namespaces; code outside any is grouped by folder', () => {
  const map = run('mini');
  assert.equal(map.node(`${DOMAIN}shop::Order`).parent, 'cpp:ns:shop_domain/shop');
  assert.equal(map.node('cpp:ns:shop_domain/shop').name, 'shop');
  assert.equal(map.node('cpp:ns:shop_cli/app/').name, 'app/');
  assert.equal(map.node('cpp:ns:legacy/(global)').kind, 'namespace');
});

test('a class declared in a header and defined in a source file is one node, with its members', () => {
  const map = run('mini');
  const order = map.node(`${DOMAIN}shop::Order`);
  assert.equal(order.kind, 'class');
  assert.deepEqual(order.location, { file: 'include/shop/order.h', line: 7, endLine: 24 });
  assert.deepEqual(order.extraLocations, [{ file: 'src/order.cpp', line: 12, endLine: 36 }]);
  assert.equal(order.metrics.loc, 18 + 1 + 3 + 5 + 7 + 3); // the class and its out-of-line definitions

  const addLine = map.node(`${DOMAIN}shop::Order::addLine(const Product&,int)`);
  assert.equal(addLine.kind, 'method');
  assert.deepEqual(addLine.location, { file: 'src/order.cpp', line: 14, endLine: 16 });
  assert.deepEqual(addLine.extraLocations, [{ file: 'include/shop/order.h', line: 11, endLine: 11 }]);
  assert.equal(addLine.doc, 'Adds a line of a product.');
  assert.deepEqual(addLine.metrics, { loc: 3, complexity: 1, parameters: 2 });
  // The overload by arity, defined after `using namespace shop;`.
  const discounted = map.node(`${DOMAIN}shop::Order::addLine(const Product&,int,double)`);
  assert.deepEqual(discounted.metrics, { loc: 5, complexity: 3, parameters: 3 });
  assert.equal(map.node(`${DOMAIN}shop::Order::total()`).modifiers.join(), 'const');
  assert.equal(map.node(`${DOMAIN}shop::Order::Order(int)`).kind, 'constructor');
  assert.equal(map.node(`${DOMAIN}shop::Order::create()`).modifiers.join(), 'static');
  assert.equal(map.node(`${DOMAIN}shop::Order::id_`).accessibility, 'private');
  assert.equal(map.node(`${DOMAIN}shop::Order::Line`).parent, `${DOMAIN}shop::Order`);
});

test('a file-local helper of a class source file is a private static member of the class, not a holder of its own', () => {
  const map = run('mini');
  const helper = map.node(`${DOMAIN}shop::Order::clampQuantity(int)`);
  assert.equal(helper.accessibility, 'private');
  assert.deepEqual(helper.modifiers, ['static']);
  assert.ok(!map.nodes.some((n) => n.id.includes('file:src/order')));
});

test('free functions live in a holder per namespace and header/source pair', () => {
  const map = run('mini');
  const holder = map.node(`${DOMAIN}file:include/shop/money#shop`);
  assert.equal(holder.kind, 'module');
  assert.equal(holder.level, 'type');
  assert.equal(holder.name, 'money');
  assert.equal(holder.parent, 'cpp:ns:shop_domain/shop');
  assert.equal(holder.signature, 'money.h + money.cpp');
  const round = map.node(`${DOMAIN}file:include/shop/money#shop::roundCents(double)`);
  assert.equal(round.kind, 'function');
  assert.deepEqual(round.location, { file: 'src/money.cpp', line: 5, endLine: 7 });
  assert.deepEqual(round.extraLocations, [{ file: 'include/shop/money.h', line: 5, endLine: 5 }]);
});

test('a class of pure virtual methods and no data is an interface', () => {
  const map = run('mini');
  const gateway = map.node(`${DOMAIN}shop::PaymentGateway`);
  assert.equal(gateway.kind, 'interface');
  assert.deepEqual(map.node(`${DOMAIN}shop::PaymentGateway::charge(long)`).modifiers, ['abstract', 'virtual']);
});

test('C: a struct, its typedef, and a file-local function', () => {
  const map = run('mini');
  assert.equal(map.node('cpp:legacy:ledger').kind, 'struct');
  assert.equal(map.node('cpp:legacy:file:legacy/ledger#(global)::ledger_t').kind, 'typeAlias');
  const add = map.node('cpp:legacy:file:legacy/ledger#(global)::ledger_add(ledger_t*,long)');
  assert.deepEqual(add.extraLocations, [{ file: 'legacy/ledger.h', line: 13, endLine: 13 }]); // declared inside extern "C"
  assert.equal(map.node('cpp:legacy:file:legacy/ledger#(global)::clamp(long)').accessibility, 'private');
});

test('C: a function returning a function pointer is a function; a function pointer is a variable', () => {
  // SQLite's ftsCompareFunction was missing, so the comparers it returns looked unused.
  const { dir, dispose } = scratch({
    'hash.c': [
      'static int binCompare(const void* a, int n) { return n; }',
      'static int (*compareFor(int key))(const void*, int) { return &binCompare; }',
      'int (*current)(const void*, int);',
    ].join('\n'),
  });
  try {
    const map = run(dir);
    const name = dir.split(/[\\/]/).pop();
    const fn = map.node(`cpp:${name}:file:hash#(global)::compareFor(int)`);
    assert.equal(fn.kind, 'function');
    assert.ok(map.hasEdge(fn.id, 'uses', `cpp:${name}:file:hash#(global)::binCompare(const void*,int)`));
    assert.equal(map.node(`cpp:${name}:file:hash#(global)::current`).kind, 'variable');
  } finally {
    dispose();
  }
});

test('a class in an anonymous namespace gets its methods defined out of line in the same file', () => {
  // leveldb's DBIter: 41 definitions were left off the map, so its private methods looked unused.
  const { dir, dispose } = scratch({
    'iter.cc': [
      'namespace db {',
      'namespace {',
      'class Iter {',
      ' public:',
      '  void Next();',
      ' private:',
      '  void FindNext();',
      '};',
      'void Iter::Next() { FindNext(); }',
      'void Iter::FindNext() {}',
      '}  // namespace',
      '}  // namespace db',
    ].join('\n'),
  });
  try {
    const map = run(dir);
    const name = dir.split(/[\\/]/).pop();
    const iter = `cpp:${name}:db::Iter@iter.cc`;
    assert.deepEqual(map.node(`${iter}::FindNext()`).location, { file: 'iter.cc', line: 10, endLine: 10 });
    assert.ok(map.hasEdge(`${iter}::Next()`, 'calls', `${iter}::FindNext()`));
  } finally {
    dispose();
  }
});

test('conversion operators are methods: defined in the class, or declared there and defined out of it', () => {
  // gmock's `template <typename F> operator Action<F>() const { return Action<F>(new MonomorphicImpl<F>(…)); }`.
  const { dir, dispose } = scratch({
    'flag.h': 'class Impl {};\nclass Flag {\n public:\n  operator Impl*() const { return new Impl(); }\n  explicit operator bool() const;\n  bool ok() const;\n};',
    'flag.cpp': '#include "flag.h"\nFlag::operator bool() const { return ok(); }\nbool Flag::ok() const { return true; }',
  });
  try {
    const map = run(dir);
    const name = dir.split(/[\\/]/).pop();
    const flag = `cpp:${name}:Flag`;
    assert.ok(map.hasEdge(`${flag}::operator Impl*()`, 'instantiates', `cpp:${name}:Impl`));
    assert.deepEqual(map.node(`${flag}::operator bool()`).location, { file: 'flag.cpp', line: 2, endLine: 2 });
    assert.ok(map.hasEdge(`${flag}::operator bool()`, 'calls', `${flag}::ok()`));
  } finally {
    dispose();
  }
});

test('the name of a parameter pack is not part of the function id', () => {
  // spdlog's create(std::string,SinkArgs&&...sink_args) changed id whenever the pack was renamed.
  const { dir, dispose } = scratch({ 'log.h': 'template <typename... Args>\nvoid log(const char* fmt, Args&&... args) {}' });
  try {
    const map = run(dir);
    const name = dir.split(/[\\/]/).pop();
    assert.equal(map.node(`cpp:${name}:file:log#(global)::log(const char*,Args&&...)`).kind, 'function');
  } finally {
    dispose();
  }
});

test('ids do not depend on the folder analyzed', () => {
  const whole = run('mini');
  const part = run(join(fixtures, 'mini', 'src'), { root: join(fixtures, 'mini') });
  const ids = part.nodes.map((n) => n.id);
  assert.ok(ids.includes(`${DOMAIN}shop::Order::addLine(const Product&,int)`), ids.join('\n'));
  assert.ok(ids.includes(`${DOMAIN}file:include/shop/money#shop::add(long,long)`));
  for (const id of ids) assert.ok(whole.has(id), id);
});

test('a Visual Studio solution maps its own projects', () => {
  const map = run(join(fixtures, 'msbuild', 'Game.sln'));
  assert.deepEqual(map.nodes.filter((n) => n.kind === 'project').map((n) => n.id), [`${P}Engine`, `${P}Game`]);
  assert.ok(map.hasEdge(`${P}Game`, 'projectReference', `${P}Engine`));
  assert.deepEqual(map.node(`${P}Game`).tags, ['entrypoint']);
  assert.equal(map.node(`${P}Engine`).signature, 'Visual Studio · StaticLibrary');
  assert.deepEqual(map.node('cpp:Engine:Renderer::draw(int)').extraLocations, [{ file: 'Engine/Renderer.h', line: 5, endLine: 5 }]);
  assert.equal(map.source.kind, 'solution');
});

test('Unreal modules are projects; engine modules are libraries; reflection macros are attributes', () => {
  const map = run('unreal');
  assert.deepEqual(map.nodes.filter((n) => n.kind === 'project').map((n) => n.id), [`${P}ShopCore`, `${P}ShopGame`]);
  assert.ok(map.hasEdge(`${P}ShopGame`, 'projectReference', `${P}ShopCore`));
  assert.ok(map.hasEdge(`${P}ShopGame`, 'packageReference', 'cpp:lib:Engine'));
  const actor = map.node('cpp:ShopGame:AShopActor');
  assert.deepEqual(actor.attributes, ['UCLASS(Blueprintable)']);
  assert.equal(actor.doc, 'A shop placed in the level.');
  assert.equal(actor.baseType, 'AActor');
  assert.deepEqual(map.node('cpp:ShopGame:AShopActor::Stock').attributes, ['UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shop")']);
  assert.deepEqual(map.node('cpp:ShopGame:AShopActor::Restock(int32)').attributes, ['UFUNCTION(BlueprintCallable, Category = "Shop")']);
  assert.deepEqual(map.node('cpp:ShopGame:AShopActor::BeginPlay()').modifiers, ['override', 'virtual']);
  assert.equal(map.node('cpp:ns:ShopCore/(global)').kind, 'namespace'); // Public/ and Private/ are like include/ and src/
});

test('loose sources make a project named after the folder', () => {
  const map = run('loose');
  assert.deepEqual(map.nodes.filter((n) => n.kind === 'project').map((n) => [n.id, n.signature]), [[`${P}loose`, 'no build file']]);
  assert.ok(map.has('cpp:loose:file:hello#(global)::main()'));
});

test('tests can be left out; generated files are skipped', () => {
  const { dir, dispose } = scratch({ 'moc_order.cpp': '// Generated by the Qt moc\nint x;\n', 'ui_main.h': 'class Ui_Main {};\n' }, 'mini');
  try {
    const map = run(dir, { options: { includeTests: false } });
    assert.ok(!map.nodes.some((n) => n.id.startsWith('cpp:shop_tests')));
    assert.deepEqual(map.analysis.warnings, ['2 generated file(s) were skipped.', '1 test file(s) were left out.']);
  } finally {
    dispose();
  }
});

test('build trees, vendored code and dot folders are not read', () => {
  const { dir, dispose } = scratch({
    'build/CMakeCache.txt': '',
    'build/gen.cpp': 'int generated() { return 1; }',
    'out-of-tree/CMakeCache.txt': '',
    'out-of-tree/x.cpp': 'int x() { return 1; }',
    'third_party/lib/lib.cpp': 'int lib() { return 1; }',
    'deps/jemalloc/je.c': 'int je() { return 1; }', // redis vendors its libraries in deps/
    '.cache/y.cpp': 'int y() { return 1; }',
  }, 'loose');
  try {
    const map = run(dir);
    assert.deepEqual(map.nodes.filter((n) => n.kind === 'function').map((n) => n.name).sort(), ['main', 'square']);
  } finally {
    dispose();
  }
});
