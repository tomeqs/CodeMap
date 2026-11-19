#!/usr/bin/env node
// Rebuilds grammar/tree-sitter-swift.wasm from the upstream grammar (see grammar/README.md).
//
//   npm run build-grammar
//
// Needs git, network access, and emcc 4.0.4 on the PATH (emsdk: `./emsdk install 4.0.4 && ./emsdk activate 4.0.4`),
// or docker / podman, which tree-sitter-cli then uses instead. The result should be byte for byte the committed file;
// the script prints both SHA-256 sums.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/alex-pinkus/tree-sitter-swift';
const COMMIT = 'fef1236022ccde2d2bc5c32d4db8947c87a7f848';
const CLI = 'tree-sitter-cli@0.25.10';

const here = dirname(fileURLToPath(import.meta.url));
const grammar = join(here, '..', 'grammar');
const output = join(grammar, 'tree-sitter-swift.wasm');
const work = mkdtempSync(join(tmpdir(), 'tree-sitter-swift-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '(none)');

try {
  const before = sha(output);
  run('git', ['clone', '--quiet', '--filter=blob:none', REPOSITORY, work]);
  run('git', ['checkout', '--quiet', COMMIT], work);

  // web-tree-sitter gives a grammar's scanner no stderr and no exit(): the scanner's out-of-memory branch (calloc of
  // four bytes) traps instead.
  const scanner = join(work, 'src', 'scanner.c');
  const text = readFileSync(scanner, 'utf8');
  const exit = /( *)fprintf\(stderr, "tree-sitter-swift: out of memory allocating scanner state\\n"\);\n *exit\(1\);\n/;
  if (!exit.test(text)) throw new Error('The scanner patch does not apply: look at src/scanner.c of the new commit.');
  writeFileSync(scanner, text.replace(exit, '$1__builtin_trap();\n'));

  run('npx', ['--yes', CLI, 'generate'], work);
  run('npx', ['--yes', CLI, 'build', '--wasm', '--output', output, '.'], work);
  copyFileSync(join(work, 'LICENSE'), join(grammar, 'LICENSE'));
  console.log(`tree-sitter-swift.wasm\n  before: ${before}\n  now:    ${sha(output)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
