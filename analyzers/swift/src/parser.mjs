import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * tree-sitter (WebAssembly) with the Swift grammar. The grammar is built from source and kept in grammar/ (see its
 * README). A published CodeMap carries web-tree-sitter in vendor/ next to src/ (the build copies it out of
 * node_modules); a checkout of the repository uses node_modules (npm ci).
 */
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'vendor');

let loaded;

export async function loadParser() {
  if (loaded) return loaded;
  const vendored = existsSync(join(vendor, 'web-tree-sitter', 'tree-sitter.js'));
  const module = vendored ? await import(pathToFileURL(join(vendor, 'web-tree-sitter', 'tree-sitter.js')).href) : await import('web-tree-sitter');
  const { Parser, Language } = module;
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(join(here, '..', 'grammar', 'tree-sitter-swift.wasm')));
  loaded = {
    vendored,
    /** Parses a text; the caller deletes the tree when done. */
    parse: (text) => parser.parse(withoutDiagnostics(text)),
  };
  return loaded;
}

/**
 * The text as the grammar can read it, every character in its place. Two things it cannot read are blanked out,
 * neither of which means anything to the map:
 * - `#warning("…")` and `#error("…")`, messages for the compiler, inside a type's body: Vapor's
 *   `extension SocketAddress { #warning(…) init?(…) }` lost the extension and made its initializer top-level code;
 * - a comment opener (slash, star) in a one-line string after an interpolation (Vapor's `"\(start)-\(end)/…"`), read
 *   as the start of a comment that the next closer, in a doc comment 15 lines on, ended.
 */
export function withoutDiagnostics(text) {
  let out = text;
  if (out.includes('#warning') || out.includes('#error')) out = out.replace(/#(warning|error)\s*\(\s*"(?:[^"\\\n]|\\.)*"\s*\)/g, blank);
  if (out.includes('/*')) {
    out = out.replace(/"(?:[^"\\\n]|\\.)*"/g, (literal) => (literal.includes('\\(') && literal.includes('/*') ? literal.replace(/\/\*/g, '/ ') : literal));
  }

  return out;
}

const blank = (m) => m.replace(/[^\n]/g, ' ');
