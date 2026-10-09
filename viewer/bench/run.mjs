#!/usr/bin/env node
// Benchmarks the built viewer on generated graphs:
//
//   npm run bench -- --sizes 1k,7k,20k [--renderer auto|webgl|webgpu] [--headed] [--view galaxy|layers|city|auto]
//                    [--layout gpu|worker|main] [--layout-mode grid|exact] [--save name] [--baseline bench/baseline.json | --write-baseline] [--dist other/build] [--timeout s]
//
// Headless Chromium has no GPU (SwiftShader), so GPU-bound numbers only mean something with --headed on a
// real machine; CPU-side numbers (parse, model, layout, JS per frame, idle renders) are comparable anywhere.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { graph, here, launch, open, serve, settled, sizeName } from './lib.mjs';
import { parseSize } from './generate.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const sizes = option('sizes', '1k,7k').split(',').map(parseSize);
const renderer = option('renderer', 'auto');
const view = option('view', 'galaxy');
const orbitMs = Number(option('orbit', '4000'));
const baselineFile = option('baseline', join(here, 'baseline.json'));
const timeout = Number(option('timeout', '600')) * 1000;

const server = await serve(option('dist') ? resolve(option('dist')) : undefined);
const browser = await launch({ headed: flag('headed') });
const results = [];
try {
  for (const size of sizes) {
    const data = await graph(size);
    const query = new URLSearchParams({ data, maxUnits: String(Math.max(size * 2, 7000)), bench: '1' });
    if (renderer !== 'auto') query.set('renderer', renderer);
    if (option('layout')) query.set('layout', option('layout'));
    if (option('layout-mode')) query.set('layoutMode', option('layout-mode'));
    const { page, errors } = await open(browser, `${server.url}/?${query}`);
    const started = Date.now();
    // Frames while the layout settles: what the main thread spends per frame while things move.
    await page.waitForFunction(() => window.codemap?.view?.units?.length, null, { timeout, polling: 50 });
    await page.evaluate(() => window.codemap.perf.startSampling());
    await settled(page, timeout);
    const layoutFrames = await page.evaluate(() => window.codemap.perf.stopSampling());
    if (view !== 'galaxy') {
      await page.evaluate((v) => (v === 'auto' ? window.codemap.setLevel('auto') : window.codemap.setView(v)), view);
      await page.waitForFunction(() => window.codemap.view.settled !== false && (window.codemap.view !== window.codemap.zoomView || window.codemap.zoomView.semantic), null, { timeout, polling: 100 });
    }
    await page.waitForTimeout(1500); // the camera flies to fit the settled layout

    const loadMs = Date.now() - started;
    const result = await measure(page);
    result.layoutFrames = layoutFrames;
    result.size = sizeName(size);
    result.view = view;
    result.loadMs = loadMs;
    result.errors = errors;
    results.push(result);
    print(result);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

const tidy = (value) => JSON.stringify(value, (key, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v), 2) + '\n';
const save = option('save');
if (save) {
  const dir = join(here, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${save}.json`), tidy(results));
}

if (flag('write-baseline')) writeFileSync(baselineFile, tidy(results));
else if (existsSync(baselineFile)) compare(JSON.parse(readFileSync(baselineFile, 'utf8')), results);

async function measure(page) {
  const info = await page.evaluate(() => {
    const app = window.codemap;
    return {
      units: app.view.units.length,
      links: app.view.links.length,
      renderer: app.stage.backend ?? 'webgl',
      perf: app.perf.snapshot(),
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
  });

  // Idle: nothing moves, nothing should be drawn (once the frames still on their way are done, e.g. the
  // camera flight after the layout settled: software frames are slow).
  await page.mouse.move(5, 400);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => {
    const stage = window.codemap.stage;
    return !stage.raf && !stage.ambientTimer && !stage.dirty && stage.trailingFrames === 0 && !stage.flight;
  }, null, { timeout: 60000, polling: 50 });
  const idle = await page.evaluate(async () => {
    const perf = window.codemap.perf;
    perf.startSampling();
    await new Promise((r) => setTimeout(r, 2000));
    return perf.stopSampling();
  });

  // Orbit: drag the camera around for a few seconds.
  await page.evaluate(() => window.codemap.perf.startSampling());
  const box = { x: 640, y: 400 };
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  const start = Date.now();
  for (let i = 0; Date.now() - start < orbitMs; i++) {
    await page.mouse.move(box.x + Math.cos(i / 12) * 220, box.y + Math.sin(i / 17) * 90);
    await page.waitForTimeout(16);
  }

  await page.mouse.up();
  const orbit = await page.evaluate(() => window.codemap.perf.stopSampling());

  // Interaction costs: picking under the pointer, transitive dependents of the biggest hub.
  const interaction = await page.evaluate(() => {
    const app = window.codemap;
    const view = app.view;
    let t = performance.now();
    for (let i = 0; i < 40; i++) view.pick({ clientX: 200 + ((i * 97) % 880), clientY: 120 + ((i * 53) % 560) });
    const pickMs = (performance.now() - t) / 40;
    const counts = new Map();
    for (const l of view.links) counts.set(l.target, (counts.get(l.target) ?? 0) + 1);
    const hub = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    let dependentsMs = null;
    if (hub) {
      app.select(hub);
      t = performance.now();
      app.highlightMode('dependents');
      dependentsMs = performance.now() - t;
      app.select(null);
    }

    return { pickMs, dependentsMs };
  });

  return { ...info, idle, orbit, ...interaction };
}

function print(r) {
  const t = r.perf.timings;
  const f = (v) => (v === null || v === undefined ? '–' : typeof v === 'number' ? (Math.round(v * 10) / 10).toString() : v);
  console.log(`\n${r.size} ${r.view} (${r.renderer}): ${r.units} units, ${r.links} links, heap ${f(r.heapMb)} MB`);
  console.log(`  load ${r.loadMs} ms · parse ${f(t.parse)} · model ${f(t.model)} · aggregate ${f(t.aggregate)} · build ${f(t.build)} · prewarm ${f(t.prewarm)} · settle ${f(t.settle)} ms`);
  console.log(`  while laying out: ${r.layoutFrames?.frames ?? '–'} frames · interval p50 ${f(r.layoutFrames?.interval?.p50)} ms · JS per frame p50 ${f(r.layoutFrames?.work?.p50)} / p95 ${f(r.layoutFrames?.work?.p95)} ms`);
  console.log(`  idle 2 s: ${r.idle.frames} frames, ${r.idle.renders} renders`);
  console.log(`  orbit: interval p50 ${f(r.orbit.interval?.p50)} / p95 ${f(r.orbit.interval?.p95)} ms · JS per frame p50 ${f(r.orbit.work?.p50)} / p95 ${f(r.orbit.work?.p95)} ms`);
  console.log(`  pick ${f(r.pickMs)} ms · dependents ${f(r.dependentsMs)} ms`);
  if (r.errors.length) console.log(`  errors: ${r.errors.join(' | ')}`);
}

function compare(baseline, results) {
  const rows = [];
  for (const r of results) {
    const b = baseline.find((x) => x.size === r.size && x.view === r.view);
    if (!b) continue;
    const delta = (name, a, c) => rows.push(`${r.size} ${name.padEnd(22)} ${String(Math.round(a ?? 0)).padStart(7)} → ${String(Math.round(c ?? 0)).padStart(7)}`);
    delta('settle ms', b.perf.timings.settle, r.perf.timings.settle);
    if (b.layoutFrames) delta('layout JS p95 ms', b.layoutFrames.work?.p95, r.layoutFrames?.work?.p95);
    delta('idle renders / 2 s', b.idle.renders, r.idle.renders);
    delta('orbit JS p95 ms', b.orbit.work?.p95, r.orbit.work?.p95);
    delta('orbit interval p95 ms', b.orbit.interval?.p95, r.orbit.interval?.p95);
    delta('dependents ms', b.dependentsMs, r.dependentsMs);
  }

  if (rows.length) console.log('\nCompared with the baseline:\n' + rows.join('\n'));
}
