#!/usr/bin/env node
// Smoke tests of the built viewer in headless Chromium: every view draws something, picking and search
// work, no errors – once per renderer.
//
//   npm run test:smoke [-- --renderers webgl,webgpu] [--headed] [--only 'name part'] [--dist other/build]
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { graph, launch, open, serve, settled } from './lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const renderers = option('renderers', 'auto').split(',');
const only = option('only'); // run just the tests whose name contains this

const server = await serve(option('dist') ? resolve(option('dist')) : undefined);
const browser = await launch({ headed: args.includes('--headed') });
let failed = 0;
const test = async (name, fn) => {
  if (only && !name.includes(only) && !/loads and lays out/.test(name)) return;
  const start = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${Date.now() - start} ms)`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n    ${String(error.stack ?? error).split('\n').slice(0, 6).join('\n    ')}`);
  }
};

try {
  const big = await graph(2000);
  for (const renderer of renderers) {
    console.log(`\nrenderer: ${renderer}`);
    const query = (data) => {
      const q = new URLSearchParams({ data, bench: '1' });
      if (renderer !== 'auto') q.set('renderer', renderer);
      return `${server.url}/?${q}`;
    };

    const { page, errors } = await open(browser, query('/sample.codemap.json'));
    await test('the sample loads and lays out', async () => {
      await settled(page, 60000);
      const info = await page.evaluate(() => ({ units: window.codemap.view.units.length, hud: document.getElementById('hud').textContent }));
      assert.ok(info.units > 10, `units: ${info.units}`);
      assert.match(info.hud, /types · \d+ links/);
    });

    if (renderer !== 'auto') {
      await test(`the ${renderer} backend is in use`, async () => {
        const backend = await page.evaluate(() => window.codemap.stage.backend);
        assert.equal(backend, renderer);
      });
    }

    for (const view of ['galaxy', 'city', 'layers', 'di', 'flow', 'auto']) {
      await test(`${view} view draws`, async () => {
        await page.evaluate((v) => (v === 'auto' ? window.codemap.setLevel('auto') : window.codemap.setView(v)), view);
        await page.waitForFunction(() => {
          const app = window.codemap;
          return app.view.units.length && app.view.settled !== false && (app.view !== app.zoomView || app.zoomView.semantic);
        }, null, { timeout: 60000, polling: 100 });
        await page.waitForTimeout(300);
        assert.ok(await litPixels(page) > 400, 'the canvas shows the map');
      });
    }

    await test('clicking a node selects it', async () => {
      await page.evaluate(() => window.codemap.setView('galaxy'));
      await page.waitForFunction(() => window.codemap.view === window.codemap.galaxy && window.codemap.galaxy.settled, null, { timeout: 60000 });
      await page.waitForTimeout(1300); // the camera flies to fit
      const target = await page.evaluate(() => {
        // The unit farthest from its neighbours on screen (and clear of the panels): nothing else is under it.
        const app = window.codemap;
        app.select(null);
        const rect = app.stage.canvas.getBoundingClientRect();
        const points = app.view.units.map((u) => ({ id: u.id, p: app.stage.project(app.view.positionOf(u.id)) })).filter((x) => x.p);
        const inside = points.filter(({ p }) => p.x > 320 && p.x < rect.width - 380 && p.y > 90 && p.y < rect.height - 130);
        let best = null;
        for (const a of inside) {
          let clearance = Infinity;
          for (const b of points) if (b !== a) clearance = Math.min(clearance, Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y));
          if (!best || clearance > best.clearance) best = { ...a, clearance };
        }

        return { id: best.id, x: rect.left + best.p.x, y: rect.top + best.p.y };
      });
      await page.mouse.click(target.x, target.y);
      const selected = await page.evaluate(() => window.codemap.selection?.nodeId);
      assert.equal(selected, target.id);
    });

    await test('selecting a node dims the others (the change reaches the GPU without further frames)', async () => {
      const brightness = async (point) => {
        const shot = await page.screenshot({ clip: { x: point.x - 3, y: point.y - 3, width: 6, height: 6 } });
        return page.evaluate(async (base64) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = new OffscreenCanvas(image.width, image.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          const data = ctx.getImageData(0, 0, image.width, image.height).data;
          let max = 0;
          for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i] + data[i + 1] + data[i + 2]);
          return max;
        }, shot.toString('base64'));
      };
      const other = await page.evaluate(() => {
        const app = window.codemap;
        const units = [...app.view.units].sort((a, b) => b.r - a.r);
        app.select(units[0].id);
        const h = app.view.highlight;
        const u = units.find((x) => !h.nodes.has(x.id) && app.stage.project(app.view.positionOf(x.id)));
        app.select(null);
        const p = app.stage.project(app.view.positionOf(u.id));
        const rect = app.stage.canvas.getBoundingClientRect();
        return { id: u.id, selected: units[0].id, x: Math.round(rect.left + p.x), y: Math.round(rect.top + p.y) };
      });
      // Only the canvas counts: hide the HTML labels drawn over it.
      await page.evaluate(() => (document.getElementById('labels').style.visibility = 'hidden'));
      await page.waitForTimeout(400);
      const before = await brightness(other);
      // As if the user had been away: no ambient frames (pulsing halo) that would hide a missing frame.
      await page.evaluate((id) => {
        window.codemap.stage.lastInput = -1e9;
        window.codemap.select(id);
      }, other.selected);
      await page.waitForTimeout(400);
      const after = await brightness(other);
      await page.evaluate(() => {
        window.codemap.select(null);
        document.getElementById('labels').style.visibility = '';
      });
      assert.ok(after < before * 0.7, `brightness of an unrelated node: ${before} before, ${after} after selecting`);
    });

    await test('an idle map draws nothing', async () => {
      await page.evaluate(() => window.codemap.select(null));
      await page.mouse.move(2, 300);
      await page.waitForTimeout(1500); // the last frames of the camera damping
      const sample = await page.evaluate(async () => {
        const perf = window.codemap.perf;
        perf.startSampling();
        await new Promise((r) => setTimeout(r, 1500));
        return perf.stopSampling();
      });
      assert.equal(sample.renders, 0, `frames drawn while idle: ${sample.renders}`);
    });

    await test('loading graphs again does not leak GPU memory', async () => {
      const counts = await page.evaluate(async () => {
        const app = window.codemap;
        const doc = await (await fetch('/sample.codemap.json')).json();
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const result = [];
        for (let i = 0; i < 4; i++) {
          app.load(structuredClone(doc));
          await frame();
          const { geometries, textures } = app.stage.renderer.info.memory;
          result.push(geometries + textures);
        }

        return result;
      });
      assert.ok(counts[3] <= counts[1], `geometries + textures after each load: ${counts.join(', ')}`);
    });

    await test('search reveals a member', async () => {
      await page.fill('#search', 'AddLine');
      await page.waitForSelector('#search-results .item');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.codemap.selection?.nodeId?.includes('AddLine'), null, { timeout: 10000 });
    });

    await test('the worker and the main thread compute the same layout', async () => {
      const result = await page.evaluate(async () => {
        const app = window.codemap;
        const { MainThreadLayout, WorkerLayout } = window.codemapLayout;
        const spec = () => app.galaxy.layoutSpec(app.state, 0);
        const main = new MainThreadLayout(spec(), { prewarmMs: 0 });
        while (!main.settled) main.step(1000);
        const worker = new WorkerLayout(spec());
        const start = performance.now();
        while (!worker.settled && performance.now() - start < 30000) {
          await new Promise((r) => setTimeout(r, 20));
          worker.step();
        }

        let differences = 0;
        for (let i = 0; i < main.positions.length; i++) if (main.positions[i] !== worker.positions[i]) differences++;
        return { settled: worker.settled, ticks: [main.ticks, worker.ticks], differences, count: main.positions.length };
      });
      assert.ok(result.settled, 'the worker layout settled');
      assert.equal(result.ticks[0], result.ticks[1], 'same number of ticks');
      assert.equal(result.differences, 0, `positions that differ: ${result.differences} of ${result.count}`);
    });

    await test('no errors on the page', async () => {
      assert.deepEqual(errors, []);
    });
    await page.close();

    const large = await open(browser, query(big));
    await test('a generated graph with 2000 types is laid out in a worker', async () => {
      // The worker does not wait for frames: even without a GPU (slow frames) the layout settles quickly.
      await settled(large.page, 60000);
      const info = await large.page.evaluate(() => ({ units: window.codemap.view.units.length, layout: window.codemap.view.layout.kind }));
      assert.ok(info.units >= 2000, `units: ${info.units}`);
      assert.equal(info.layout, 'worker');
      assert.ok(await litPixels(large.page) > 400, 'the canvas shows the map');
      assert.deepEqual(large.errors, []);
    });
    await large.page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

if (failed) {
  console.log(`\n${failed} smoke test(s) failed.`);
  process.exit(1);
}

console.log('\nSmoke tests passed.');

/** Pixels of the canvas that are clearly brighter than the background. */
async function litPixels(page) {
  const shot = await page.locator('#stage canvas').screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 120) lit++;
    return lit;
  }, shot.toString('base64'));
}
