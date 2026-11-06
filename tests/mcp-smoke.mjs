// Smoke test of `codemap mcp` as an agent uses it: the protocol on stdio, an analysis of samples/Shop, findings, a
// proposal and a picture of the map. Used by CI (the built CLI) and the release (each published executable).
//
//   node tests/mcp-smoke.mjs <command> [arguments before "mcp"…]
//   node tests/mcp-smoke.mjs dotnet src/CodeMap.Cli/bin/Release/net8.0/codemap.dll
//   node tests/mcp-smoke.mjs ./publish/codemap
//
// A picture needs Chrome, Edge or Chromium: without one, or when it cannot draw, render_map only warns.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [command, ...before] = process.argv.slice(2);
if (!command) {
  console.error('usage: node tests/mcp-smoke.mjs <command> [arguments before "mcp"…]');
  process.exit(2);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shop = path.join(repo, 'samples', 'Shop');
// The browser for render_map runs on a throw-away profile, codemap-browser-* in the temp folder, deleted once it is closed.
const browserProfiles = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('codemap-browser-'));
const profilesBefore = new Set(browserProfiles());
const server = spawn(command, [...before, 'mcp', '--root', shop, '--no-watch'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const stderr = [];
server.stderr.on('data', (data) => stderr.push(String(data)));

const waiting = new Map();
let nextId = 1;
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`stdout is not the protocol: ${line.slice(0, 200)}`);
    }

    if (message.id != null && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  }
});
server.on('exit', (code) => waiting.size && fail(`codemap mcp stopped (exit code ${code}) with ${waiting.size} request(s) unanswered.`));

const write = (message) => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
function request(method, params, seconds = 300) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method}: no answer in ${seconds} s`)), seconds * 1000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    write({ id, method, params });
  });
}

// Where it is, for a run that never ends: CI shows the last step instead of an hour of silence.
let now = 'starting codemap mcp';
let lastPassed = 'nothing yet';
setTimeout(() => fail(`still running after 10 minutes, at: ${now} (last passed: ${lastPassed})`), 10 * 60 * 1000).unref();

async function call(name, args = {}) {
  now = `${name} ${JSON.stringify(args)}`;
  const result = await request('tools/call', { name, arguments: args });
  const text = result.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
  if (result.isError) throw new Error(`${name}: ${text}`);
  return { result, json: JSON.parse(text) };
}

function check(condition, what) {
  if (!condition) throw new Error(what);
  console.log(`  ✓ ${what}`);
  lastPassed = what;
}

function fail(message) {
  console.error(`✗ ${message}\n--- stderr ---\n${stderr.join('').slice(-4000)}`);
  server.kill();
  process.exit(1);
}

try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codemap-smoke', version: '0' } }, 60);
  check(init.serverInfo?.name === 'codemap', `initialize: ${init.serverInfo?.name} ${init.serverInfo?.version}, protocol ${init.protocolVersion}`);
  write({ method: 'notifications/initialized' });

  const { tools } = await request('tools/list', {});
  const names = tools.map((t) => t.name);
  for (const name of ['analyze', 'overview', 'list_findings', 'propose_refactorings', 'simulate', 'compare', 'diagram', 'render_map']) {
    if (!names.includes(name)) throw new Error(`tools/list has no ${name}: ${names.join(', ')}`);
  }
  check(true, `tools/list: ${names.length} tools`);

  // An analysis still running after waitSeconds answers status "running": ask again, as an agent would.
  let analyzed = (await call('analyze', { path: path.join(shop, 'Shop.sln'), waitSeconds: 120 })).json;
  for (let again = 0; analyzed.status === 'running' && again < 2; again++) analyzed = (await call('analyze', { waitSeconds: 120 })).json;
  if (analyzed.status !== 'done') throw new Error(`analyze: still ${analyzed.status} after 6 minutes: ${JSON.stringify(analyzed.progress ?? analyzed)}`);
  check(analyzed.stats?.types > 20, `analyze: ${analyzed.stats?.types} types in ${analyzed.map?.seconds} s`);
  check(typeof analyzed.health?.score === 'number', `health score ${analyzed.health?.score} (${analyzed.health?.grade})`);

  const findings = (await call('list_findings', { limit: 5 })).json;
  check(Array.isArray(findings.items) && findings.items.length > 0, `list_findings: ${findings.total} findings, first ${findings.items?.map((f) => f.rule).join(', ')}`);

  const proposals = (await call('propose_refactorings', { limit: 2 })).json;
  check(Array.isArray(proposals.proposals), `propose_refactorings: ${proposals.proposals?.map((p) => p.kind).join(', ') || 'none'}`);

  const diagram = (await call('diagram', { kind: 'dependencies' })).json;
  check(/^(flowchart|graph)/m.test(diagram.mermaid ?? ''), 'diagram: Mermaid');

  try {
    const { result, json } = await call('render_map', { width: 800, height: 500 });
    const image = result.content.find((c) => c.type === 'image');
    const png = image && Buffer.from(image.data, 'base64');
    check(png?.subarray(1, 4).toString() === 'PNG' && png.length > 10000, `render_map: ${png?.length} bytes, ${json.shows?.units} units (${json.shows?.renderer})`);
  } catch (error) {
    // A picture needs a browser and graphics the runner may not have: worth a warning, not a failed release.
    console.log(`::warning::render_map: ${error.message.split('\n')[0]}`);
  }

  // Stop it as a client does: SIGTERM where there are signals, the end of its input on Windows (CODEMAP_SMOKE_STOP=eof
  // or sigterm picks one). It has to exit by itself, and close the browser it started for render_map (whose profile
  // folder goes with it).
  const byEof = (process.env.CODEMAP_SMOKE_STOP ?? (process.platform === 'win32' ? 'eof' : 'sigterm')) === 'eof';
  const how = byEof ? 'the end of its input' : 'SIGTERM';
  now = `stopping it with ${how}`;
  const exited = new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal })));
  if (byEof) server.stdin.end();
  else server.kill('SIGTERM');
  const stopped = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 30000))]);
  if (!stopped) throw new Error(`codemap mcp did not stop within 30 s of ${how}`);
  check(stopped.code === 0, `stops on ${how} (exit code ${stopped.code}${stopped.signal ? `, ${stopped.signal}` : ''})`);
  const left = browserProfiles().filter((p) => !profilesBefore.has(p));
  check(left.length === 0, `no browser left behind${left.length ? `: ${left.join(', ')}` : ''}`);

  console.log('codemap mcp smoke test passed.');
  process.exit(0);
} catch (error) {
  fail(error.message);
}
