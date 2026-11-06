// The viewer's call flows of a map, as text: the reference the C# port (CodeMap.Insights.CallFlow) is checked against.
// node tests/CodeMap.Tests/Golden/flows.mjs <map.codemap.json>  (needs npm ci in viewer/)
import { readFileSync } from 'node:fs';
import { CodeModel } from '../../../viewer/src/data/model.js';
import { buildCallFlow, findEntryPoints, toMermaid } from '../../../viewer/src/data/flow.js';

const model = new CodeModel(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const out = [];
for (const entry of findEntryPoints(model)) {
  out.push(`## ${entry.node.id} (${entry.role}, reach ${entry.reach}): ${entry.methods.map((m) => m.id).join(', ')}`);
  const flow = buildCallFlow(model, [entry.node.id]);
  out.push(`methods ${flow.stats.methods}, types ${flow.stats.types}, depth ${flow.stats.depth}, truncated ${flow.stats.truncated}`);
  for (const root of flow.tree) out.push(toMermaid(root));
}
process.stdout.write(out.join('\n') + '\n');
