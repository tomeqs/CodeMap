// Copies the single-file build into the CLI so `codemap` can embed it as a resource.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../dist/index.html');
const target = resolve(here, '../../src/CodeMap.Cli/Assets/viewer.html');
const placeholder = '<script id="codemap-data" type="application/json">null</script>';

if (!readFileSync(source, 'utf8').includes(placeholder)) {
  throw new Error('Built viewer lost the data placeholder: ' + placeholder);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`viewer → ${target}`);
