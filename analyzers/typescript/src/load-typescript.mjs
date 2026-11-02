import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * The TypeScript compiler: the copy shipped with CodeMap (plugins/typescript/vendor, next to its lib.*.d.ts),
 * else the plugin's own dependency (a checkout with npm install). Never the analyzed project's: its version
 * would change what the analysis sees.
 */
export function loadTypeScript() {
  const require = createRequire(import.meta.url);
  const vendored = fileURLToPath(new URL('../vendor/typescript/lib/typescript.js', import.meta.url));
  if (existsSync(vendored)) return require(vendored); // vendor/typescript/package.json keeps it CommonJS
  try {
    return require('typescript');
  } catch {
    throw new Error('The TypeScript compiler is missing: run npm install in analyzers/typescript (or reinstall CodeMap).');
  }
}
