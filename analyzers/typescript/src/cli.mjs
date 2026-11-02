#!/usr/bin/env node
// CodeMap language plugin, protocol 1: reads the request (JSON) on stdin, writes the raw graph to
// request.output, reports progress on stderr. See docs/plugins.md.
import { readFileSync } from 'node:fs';
import { loadTypeScript } from './load-typescript.mjs';
import { analyze } from './analyze.mjs';
import { writeFragment } from './writer.mjs';

const PROTOCOL = 1;

try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  if (request.protocol !== PROTOCOL) throw new Error(`Protocol ${request.protocol} is not supported; this plugin speaks protocol ${PROTOCOL}.`);
  if (request.command !== 'analyze') throw new Error(`Unknown command '${request.command}'.`);
  if (!request.target || !request.output) throw new Error('The request needs a target and an output.');

  const started = Date.now();
  const ts = loadTypeScript();
  console.error(`TypeScript ${ts.version}`);
  const fragment = analyze(ts, request, (message) => console.error(message));
  writeFragment(request.output, fragment);
  console.error(`${fragment.nodes.length} nodes, ${fragment.edges.length} edges in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
