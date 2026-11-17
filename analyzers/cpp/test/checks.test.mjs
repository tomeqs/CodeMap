import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './helpers.mjs';

const map = run('checks', { options: { checks: true } });
const found = map.analysis.diagnostics.map((d) => `${d.location.file}:${d.location.line} ${d.rule}`);

test('each rule reports the lines planted for it, and nothing else', () => {
  assert.deepEqual(found, [
    'include/checks.h:5 using-namespace-in-header',
    'include/checks.h:14 missing-virtual-destructor', // Shape; not Sealed (final) nor Guarded (protected destructor)
    'include/checks.h:32 missing-virtual-destructor', // Widget
    'src/c_checks.c:6 sizeof-pointer', // sizeof(buffer) of a char*; not sizeof(local) of an array
    'src/c_checks.c:8 string-literal-comparison',
    'src/c_checks.c:9 unsafe-c-function', // strcpy
    'src/c_checks.c:12 unsafe-c-function', // sprintf
    'src/c_checks.c:17 assignment-in-condition', // C's if (c = getchar())
    'src/c_checks.c:18 unsafe-c-function', // gets
    'src/checks.cpp:7 virtual-call-in-constructor', // refresh(); not this->plain()
    'src/checks.cpp:12 delete-mismatch', // buffer_ = new int[16] in the constructor, delete in the destructor
    'src/checks.cpp:21 unreachable-code',
    'src/checks.cpp:25 assignment-in-condition', // not if ((a = b)) nor if (auto* p = &a)
    'src/checks.cpp:34 constant-condition', // if (0); not if constexpr (true) nor while (1)
    'src/checks.cpp:43 empty-statement',
    'src/checks.cpp:47 float-equality', // ratio == 0.5; not ratio == 0 nor the NaN check ratio != ratio
    'src/checks.cpp:53 self-assignment',
    'src/checks.cpp:54 self-comparison',
    'src/checks.cpp:67 implicit-fallthrough', // case 1; not after [[fallthrough]], a comment, or if/else that both return
    'src/checks.cpp:80 duplicate-case',
    'src/checks.cpp:91 throw-pointer',
    'src/checks.cpp:92 empty-catch',
    'src/checks.cpp:92 catch-by-value',
    'src/checks.cpp:96 exception-not-thrown', // not throw std::logic_error(…)
    'src/checks.cpp:100 swallowed-exception', // catch (...) with only a comment
    'src/checks.cpp:106 unnamed-lock', // not the named one below it
    'src/checks.cpp:114 return-local-address', // &local; not &kept (static)
    'src/checks.cpp:119 return-local-address', // a reference to a local
    'src/checks.cpp:123 leaked-new', // lost; not kept (deleted)
    'src/checks.cpp:128 delete-mismatch', // new int[4] … delete
    'src/checks.cpp:144 empty-catch', // CHECKS_CATCH(...) {} reads as catch; CHECKS_THROW ends case 1 (no fallthrough)
    'src/checks.cpp:164 implicit-fallthrough', // case 3: its endless loop breaks; not case 1 (loops until it returns) nor case 2 (a switch whose every case returns)
    // Not checks.cpp:176: its case ends in __attribute__((fallthrough)), GCC's spelling of [[fallthrough]].
    // Not Label's toString() and valueOf(): no unsafe C functions, though a JavaScript object has both names.
    // Not Deferred's update() in the lambda its constructor hands on: it runs later, on the whole object.
    // Not handed_on(): job is deleted in a lambda, owned is a unique_ptr's.
    'src/checks.cpp:217 catch-by-value', // ShopError, a struct; not HRESULT (a typedef of long) nor Code (an enum)
    'src/checks.cpp:222 catch-by-value', // a standard exception, const and with no name: still by value
  ]);
});

test('diagnostics have the protocol fields; test files are not checked; without --checks there are none', () => {
  for (const d of map.analysis.diagnostics) {
    assert.equal(d.source, 'codemap');
    assert.ok(['warning', 'info'].includes(d.severity), d.rule);
    assert.ok(['correctness', 'exceptions', 'resources', 'concurrency', 'dead-code'].includes(d.category), d.rule);
    assert.ok(d.column >= 1 && d.location.endLine >= d.location.line);
  }

  assert.equal(map.analysis.diagnostics.find((d) => d.rule === 'unsafe-c-function' && d.location.line === 18).severity, 'warning'); // gets
  assert.ok(!found.some((f) => f.startsWith('tests/')));
  assert.equal(run('checks').analysis.diagnostics, undefined);
});
