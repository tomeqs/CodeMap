import assert from 'node:assert/strict';
import test from 'node:test';
import { basename } from 'node:path';
import { run, scratch } from './helpers.mjs';

const T = 'cpp:pay:pay::';
const C = 'cpp:pay:file:src/callbacks#(global)::';
const map = run('resolve');
const edge = (source, kind, target) => assert.ok(map.hasEdge(source, kind, target), `no ${kind} ${source} → ${target}; ${kind} edges from it: ${map.edgesFrom(source, kind).join(', ') || 'none'}`);
const noEdge = (source, kind, target) => assert.ok(!map.hasEdge(source, kind, target), `unexpected ${kind} ${source} → ${target}`);

test('bases: inherits a class, implements an interface; a pure virtual is implemented, a virtual overridden', () => {
  edge(`${T}CardGateway`, 'implements', `${T}Gateway`);
  edge(`${T}CardGateway`, 'inherits', `${T}Audited`);
  edge(`${T}CardGateway::charge(long)`, 'implements', `${T}Gateway::charge(long)`);
  edge(`${T}CardGateway::name()`, 'implements', `${T}Gateway::name()`);
  edge(`${T}CardGateway::audit(int)`, 'overrides', `${T}Audited::audit(int)`);
  assert.equal(map.node(`${T}Gateway`).kind, 'interface');
  assert.equal(map.node(`${T}Gateway`).doc, 'Charges money somewhere.');
});

test('calls: own and base methods, overloads by argument count and literal types, a qualified base call', () => {
  const charge = `${T}CardGateway::charge(long)`;
  edge(charge, 'calls', `${T}Audited::note(const char*)`);
  edge(charge, 'calls', `${T}Audited::note(double)`);
  edge(charge, 'calls', `${T}Audited::note(int,int)`);
  edge(charge, 'calls', `${T}CardGateway::audit(int)`);
  edge(`${T}CardGateway::audit(int)`, 'calls', `${T}Audited::audit(int)`);
  const line = map.edges.find((e) => e.source === charge && e.target === `${T}Audited::note(double)`).line;
  assert.equal(line, 12);
});

test('receivers typed from declarations: smart pointers, members of members, auto from a call, containers', () => {
  const pay = `${T}PaymentService::pay(long)`;
  edge(pay, 'calls', `${T}Gateway::charge(long)`); // gateway_ is a unique_ptr<Gateway>
  edge(pay, 'accesses', `${T}detail::Ledger::total`); // ledger_->total
  edge(pay, 'calls', `${T}PaymentService::last()`);
  edge(pay, 'calls', `${T}Receipt::amount()`); // auto receipt = last(); and a range-for over history()
  edge(pay, 'calls', `${T}CardGateway::name()`); // auto card = std::make_unique<CardGateway>()
  edge(pay, 'instantiates', `${T}CardGateway`);
  edge(pay, 'instantiates', `${T}Receipt`); // Receipt{}
  edge(pay, 'uses', `${T}detail::Ledger::State`); // detail::Ledger::State::Closed
  edge(pay, 'catches', `${T}PaymentError`);
  edge(`${T}CardGateway::charge(long)`, 'throws', `${T}PaymentError`);
  noEdge(`${T}CardGateway::charge(long)`, 'instantiates', `${T}PaymentError`);
});

test('signatures: holds through smart pointers and containers, accepts, returns, injects from the class', () => {
  edge(`${T}PaymentService::gateway_`, 'holds', `${T}Gateway`);
  edge(`${T}PaymentService::receipts_`, 'holds', `${T}Receipt`);
  edge(`${T}PaymentService::ledger_`, 'holds', `${T}detail::Ledger`);
  edge(`${T}PaymentService::history()`, 'returns', `${T}Receipt`);
  edge(`${T}PaymentService::PaymentService(std::unique_ptr<Gateway>,detail::Ledger*)`, 'accepts', `${T}Gateway`);
  edge(`${T}PaymentService`, 'injects', `${T}Gateway`);
  edge(`${T}PaymentService`, 'injects', `${T}detail::Ledger`);
});

test('C: functions named in a table of callbacks are used; a call through a pointer field reads it', () => {
  edge(`${C}table`, 'uses', `${C}on_open(int)`);
  edge(`${C}table`, 'uses', `${C}on_close(int)`);
  edge(`${C}table`, 'holds', 'cpp:pay:handlers');
  edge(`${C}dispatch(int)`, 'accesses', `${C}table`);
  edge(`${C}dispatch(int)`, 'accesses', 'cpp:pay:handlers::open');
});

test('no guessing: a call on something of unknown type gives no edge', () => {
  const { dir, dispose } = scratch({
    'a.cpp': [
      'struct Order { void pay(); };',
      'struct Invoice { void pay(); };',
      'void Order::pay() {}',
      'void Invoice::pay() {}',
      'template <typename T> void settle(T& thing) { thing.pay(); }',
      'void run(Order& order) { order.pay(); auto x = make(); x.pay(); }',
    ].join('\n'),
  });
  try {
    const m = run(dir);
    const name = basename(dir);
    const runId = `cpp:${name}:file:a#(global)::run(Order&)`;
    assert.deepEqual(m.edgesFrom(runId, 'calls'), [`cpp:${name}:Order::pay()`]);
    assert.deepEqual(m.edgesFrom(`cpp:${name}:file:a#(global)::settle(T&)`, 'calls'), []);
  } finally {
    dispose();
  }
});

test('a private member named by a call or read on something of unknown type is maybe-used, not dead', () => {
  // nlohmann/json: most calls in template code go through a type parameter; 500 private methods looked unused.
  const { dir, dispose } = scratch({
    'a.cpp': [
      'class Codec {',
      '  template <typename T> friend void encode(T& codec);',
      '  void write_header() {}',
      '  int m_size = 0;',
      '  void dead() {}',
      'public:',
      '  void run() {}',
      '};',
      'template <typename T> void encode(T& codec) { codec.write_header(); codec.m_size++; }',
    ].join('\n'),
  });
  try {
    const m = run(dir);
    const name = basename(dir);
    assert.ok(m.node(`cpp:${name}:Codec::write_header()`).tags?.includes('maybe-used'));
    assert.ok(m.node(`cpp:${name}:Codec::m_size`).tags?.includes('maybe-used'));
    assert.ok(!m.node(`cpp:${name}:Codec::dead()`).tags?.includes('maybe-used'));
    assert.ok(!m.node(`cpp:${name}:Codec::run()`).tags?.includes('maybe-used')); // public: never a candidate anyway
  } finally {
    dispose();
  }
});

test('names are looked up through namespaces, using declarations and directives, and across projects', () => {
  const m = run('mini');
  assert.ok(m.hasEdge('cpp:shop_domain:shop::Order::total()', 'calls', 'cpp:shop_domain:file:include/shop/money#shop::add(long,long)'));
  assert.ok(m.hasEdge('cpp:shop_cli:file:app/main#app/::main(int,char**)', 'calls', 'cpp:shop_domain:shop::Order::create()'));
  assert.ok(m.hasEdge('cpp:shop_cli:file:app/main#app/::main(int,char**)', 'calls', 'cpp:shop_domain:shop::Order::total()'));
  assert.ok(m.hasEdge('cpp:legacy:file:legacy/ledger#(global)::ledger_add(ledger_t*,long)', 'accesses', 'cpp:legacy:ledger::balance'));
  assert.ok(m.hasEdge('cpp:legacy:file:legacy/ledger#(global)::ledger_t', 'uses', 'cpp:legacy:ledger'));
});
