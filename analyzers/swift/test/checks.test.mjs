import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './helpers.mjs';

const map = run('checks', { options: { checks: true } });
const found = map.analysis.diagnostics.filter((d) => d.location.file.endsWith('Checks.swift')).map((d) => `${d.location.line} ${d.rule}`);

test('each Swift rule finds its case, at its line', () => {
  for (const expected of [
    '8 implicitly-unwrapped-property',
    '13 strong-self-in-stored-closure', // lazy var handler = { self.refresh() }
    '18 strong-self-in-stored-closure', // self.onChange = { self.refresh() }
    '25 self-assignment',
    '26 self-comparison',
    '27 constant-condition',
    '28 force-try',
    '29 force-cast',
    '30 swallowed-error', // try? save()
    '31 swallowed-error', // _ = try? save()
    '33 float-equality', // value == 0.1
    '35 main-sync-deadlock',
    '38 empty-catch',
    '47 unreachable-code', // after return
    '53 fatal-error-placeholder',
    '66 implicitly-unwrapped-property', // in a struct too
  ]) assert.ok(found.includes(expected), `${expected} not in ${found.join(', ')}`);
});

test('and stays quiet on correct code', () => {
  for (const quiet of [
    '9 implicitly-unwrapped-property', // @IBOutlet
    '19 strong-self-in-stored-closure', // [weak self]
    '20 strong-self-in-stored-closure', // a local closure, not stored in the object
    '32 swallowed-error', // let saved = try? save(): the result is kept
    '34 float-equality', // ratio == 1: a whole number
    '41 empty-catch', // a catch with a comment saying why
    '57 main-sync-deadlock', // checked with Thread.isMainThread first
    '61 fatal-error-placeholder', // Xcode's init(coder:)
    '71 unreachable-code', // return before #else
  ]) assert.ok(!found.includes(quiet), `${quiet} reported`);
  assert.equal(found.length, 16, found.join(', '));
});

test('tests are not checked, and nothing is reported without --checks', () => {
  assert.ok(map.analysis.diagnostics.every((d) => !d.location.file.startsWith('Tests/')));
  assert.equal(run('checks').analysis.diagnostics, undefined);
  for (const d of map.analysis.diagnostics) {
    assert.equal(d.source, 'codemap');
    assert.ok(['info', 'warning'].includes(d.severity));
    assert.ok(d.category);
  }
});

test('from the self-review: methods named abort, real messages, locals of observers, guard, extensions, captures, nested types, negatives', () => {
  const review = map.analysis.diagnostics.filter((d) => d.location.file.endsWith('Review.swift')).map((d) => `${d.location.line} ${d.rule}`);
  assert.deepEqual(review.sort(), [
    '21 constant-condition', // guard false
    '24 float-equality', // v == -0.5
    '27 implicitly-unwrapped-property', // a class declared in a function
    '39 strong-self-in-stored-closure', // in an extension of a class
    '40 strong-self-in-stored-closure', // [weak delegate] still keeps self
  ].sort());
  const guard = map.analysis.diagnostics.find((d) => d.location.file.endsWith('Review.swift') && d.rule === 'constant-condition');
  assert.match(guard.message, /the else block always runs/);
});
