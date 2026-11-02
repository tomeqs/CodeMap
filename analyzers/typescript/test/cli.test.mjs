import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/basic', import.meta.url));

function run(request) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(request), encoding: 'utf8' });
}

test('protocol 1: request on stdin, graph in the output file, progress on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codemap-ts-'));
  try {
    const output = join(dir, 'fragment.json');
    const result = run({ protocol: 1, command: 'analyze', root: fixture, target: fixture, output, options: { includeTests: true } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\d+ nodes, \d+ edges/);
    const doc = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(doc.format, 'codemap');
    assert.equal(doc.version, '1.1');
    assert.ok(doc.nodes.every((n) => n.id.startsWith('ts:')));
    assert.ok(doc.edges.length > 10);
    assert.ok(!doc.nodes.some((n) => 'hasCode' in n), 'no bookkeeping fields');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a request it does not understand fails with a message', () => {
  const result = run({ protocol: 99, command: 'analyze', target: fixture, output: '/nowhere' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Protocol 99 is not supported/);
});
