import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from '../src/load-typescript.mjs';
import { analyze } from '../src/analyze.mjs';

const ts = loadTypeScript();
const dir = fileURLToPath(new URL('./fixtures/checks', import.meta.url));
const graph = analyze(ts, { target: dir, root: dir, options: { checks: true } });
const diagnostics = graph.analysis.diagnostics;
const lines = (rule) => diagnostics.filter((d) => d.rule === rule).map((d) => d.location.line);

test('checks are off unless asked for', () => {
  assert.equal(analyze(ts, { target: dir, root: dir }).analysis.diagnostics, undefined);
  assert.ok(diagnostics.length > 0);
  for (const d of diagnostics) {
    assert.equal(d.location.file, 'src/checks.ts');
    assert.ok(d.location.line > 0 && d.column > 0);
    assert.ok(['error', 'warning', 'info'].includes(d.severity));
    assert.ok(['compiler', 'codemap'].includes(d.source));
  }
});

test('lost errors: empty catch blocks without a comment, and caught errors nobody looks at', () => {
  assert.deepEqual(lines('empty-catch'), [6]);
  assert.deepEqual(lines('swallowed-exception'), [10]);
});

test('promises: floating, used as conditions, in forEach and async executors', () => {
  assert.deepEqual(lines('floating-promise'), [6, 7, 14]); // not voided, caught or awaited ones
  assert.deepEqual(lines('misused-promise-condition'), [18, 19]);
  assert.deepEqual(lines('foreach-async'), [20]);
  assert.deepEqual(lines('async-promise-executor'), [22]);
});

test('logic: unreachable code, self assignment and comparison, duplicate cases, constant conditions, loose equality', () => {
  assert.deepEqual(lines('unreachable-code'), [28]);
  assert.deepEqual(lines('self-assignment'), [32]);
  assert.deepEqual(lines('self-comparison'), [33]); // x !== x is the NaN check
  assert.deepEqual(lines('duplicate-case'), [38]);
  assert.deepEqual(lines('constant-condition'), [41]); // while (true) loops on purpose
  assert.deepEqual(lines('loose-equality'), [43]); // == null is the null-or-undefined check
});

test('compiler diagnostics: impossible comparisons, null dereferences with strict, unused with noUnused', () => {
  assert.ok(lines('TS2367').includes(46), JSON.stringify(diagnostics.filter((d) => d.source === 'compiler')));
  assert.ok(lines('TS18047').includes(47) || lines('TS2531').includes(47));
  assert.ok(lines('TS6133').includes(50));
  assert.ok(lines('TS2801').includes(18));
});
