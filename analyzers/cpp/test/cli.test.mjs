import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtures } from './helpers.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('the protocol: a request on stdin, the fragment in the output file, progress on stderr', () => {
  const out = mkdtempSync(join(tmpdir(), 'codemap-cpp-cli-'));
  try {
    const output = join(out, 'fragment.json');
    const request = { protocol: 1, command: 'analyze', root: join(fixtures, 'mini'), target: join(fixtures, 'mini'), output, codemapVersion: '0.0.0', options: { includeTests: true } };
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(request), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\d+ nodes, \d+ edges in/);
    const fragment = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(fragment.format, 'codemap');
    assert.equal(fragment.version, '1.1');
    assert.ok(fragment.nodes.length > 20);
    for (const node of fragment.nodes) {
      assert.ok(node.id.startsWith('cpp:'), node.id);
      for (const key of ['bases', 'declaredType', 'returnType', 'paramTypes']) assert.ok(!(key in node), `${key} in ${node.id}`);
      if (node.parent !== undefined) assert.equal(typeof node.parent, 'string', node.id);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('an unknown protocol is an error', () => {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify({ protocol: 2, command: 'analyze' }), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Protocol 2 is not supported/);
});
