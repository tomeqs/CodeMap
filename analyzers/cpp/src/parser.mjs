import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * tree-sitter (WebAssembly) with the C and C++ grammars. A published CodeMap carries them in vendor/ next to src/
 * (the build copies them out of node_modules); a checkout of the repository uses node_modules (npm ci).
 */
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'vendor');

let loaded;

export async function loadParser() {
  if (loaded) return loaded;
  const vendored = existsSync(join(vendor, 'web-tree-sitter', 'tree-sitter.js'));
  let module;
  let grammar;
  if (vendored) {
    module = await import(pathToFileURL(join(vendor, 'web-tree-sitter', 'tree-sitter.js')).href);
    grammar = (name) => join(vendor, 'grammars', `${name}.wasm`);
  } else {
    module = await import('web-tree-sitter');
    const require = createRequire(import.meta.url);
    grammar = (name) => join(dirname(require.resolve(`${name}/package.json`)), `${name}.wasm`);
  }

  const { Parser, Language } = module;
  await Parser.init();
  const languages = {
    c: await Language.load(grammar('tree-sitter-c')),
    cpp: await Language.load(grammar('tree-sitter-cpp')),
  };
  const parsers = {};
  for (const [key, language] of Object.entries(languages)) {
    parsers[key] = new Parser();
    parsers[key].setLanguage(language);
  }

  loaded = {
    vendored,
    /** Parses a text with the grammar of `lang` ('c' or 'cpp'); the caller deletes the tree when done. */
    parse: (text, lang) => parsers[lang].parse(text),
  };
  return loaded;
}
