// A made-up language for CodeMap's tests: every *.stub file is a unit. The request comes back in a node's doc;
// fail.stub makes it fail, slow.stub makes it hang; a few things that do not belong are thrown in for the
// validator to drop.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const request = JSON.parse(readFileSync(0, 'utf8'));
const files = statSync(request.target).isFile() ? [request.target] : readdirSync(request.target, { recursive: true }).map((f) => join(request.target, f)).filter((f) => f.endsWith('.stub'));
if (files.some((f) => basename(f) === 'fail.stub')) {
  console.error('boom: fail.stub says so');
  process.exit(3);
}

if (files.some((f) => basename(f) === 'slow.stub')) await new Promise((resolve) => setTimeout(resolve, 120000));
console.error(`stub: ${files.length} file(s)`);

const nodes = [
  { id: 'stub:project', kind: 'project', name: 'box', project: 'stub:project', doc: JSON.stringify(request) },
  { id: 'stub:shelf', kind: 'namespace', name: 'shelf', parent: 'stub:project', project: 'stub:project' },
  ...files.map((f) => ({
    id: `stub:${basename(f)}`, kind: 'item', level: 'type', name: basename(f), parent: 'stub:shelf', project: 'stub:project',
    location: { file: relative(request.root, f).split('\\').join('/'), line: 1, endLine: 3 }, metrics: { loc: 3 },
  })),
  { id: 'stub:part', kind: 'part', level: 'member', name: 'part', parent: `stub:${basename(files[0])}`, project: 'stub:project', accessibility: 'private' },
  { id: 'other:intruder', kind: 'item', level: 'type', name: 'intruder' },
  { id: 'stub:outside', kind: 'item', level: 'sideways', name: 'outside', parent: 'stub:missing', location: { file: '../elsewhere.stub', line: 1 } },
];
const edges = [
  ...files.slice(1).map((f) => ({ source: `stub:${basename(f)}`, target: `stub:${basename(files[0])}`, kind: 'links', weight: 2 })),
  { source: 'stub:part', target: 'stub:nowhere', kind: 'calls', weight: 1 },
];
writeFileSync(request.output, JSON.stringify({
  format: 'codemap', version: '1.1',
  source: { path: request.target, root: request.root, kind: 'directory', name: 'stub' },
  nodes, edges,
  analysis: { warnings: ['stub warning'] },
}));
