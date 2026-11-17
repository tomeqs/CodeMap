import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.mjs';
import { loadParser } from '../src/parser.mjs';

export const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const parser = await loadParser();

/** Maps a fixture (or any folder or file) in process and returns lookups that fail with a readable message. */
export function run(target, { root, options = {} } = {}) {
  const path = target.startsWith('/') ? target : join(fixtures, target);
  const fragment = analyze(parser, { target: path, root: root ?? (/\.\w+$/.test(path) ? dirname(path) : path), options }, () => {});
  const byId = new Map(fragment.nodes.map((n) => [n.id, n]));
  return {
    ...fragment,
    node(id) {
      const found = byId.get(id);
      assert.ok(found, `no node ${id}; nodes: ${[...byId.keys()].filter((k) => k.includes(id.split(':').pop().split('::')[0])).join(', ') || [...byId.keys()].join(', ')}`);
      return found;
    },
    has: (id) => byId.has(id),
    hasEdge: (source, kind, target) => fragment.edges.some((e) => e.source === source && e.kind === kind && e.target === target),
    edgesFrom: (source, kind) => fragment.edges.filter((e) => e.source === source && (!kind || e.kind === kind)).map((e) => e.target),
  };
}

/** A temporary folder with the given files (path → text), optionally starting from a fixture. */
export function scratch(files, fixture = null) {
  const dir = mkdtempSync(join(tmpdir(), 'codemap-cpp-'));
  if (fixture) cpSync(join(fixtures, fixture), dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
