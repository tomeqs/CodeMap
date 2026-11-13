#!/usr/bin/env node
// Smoke tests of the built viewer in headless Chromium: every view draws something, picking and search
// work, no errors – once per renderer.
//
//   npm run test:smoke [-- --renderers webgl,webgpu] [--headed] [--only 'name part'] [--dist other/build]
//                      [--samples dir]  with shop-ts.codemap.json, shop-py.codemap.json and samples.codemap.json, the
//                                       analyzer's maps of samples/shop-ts, samples/shop-py and of samples/ (C#,
//                                       TypeScript and Python in one map); CI passes it
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CHROMIUM_ARGS, fixture, graph, launch, open, serve, settled } from './lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const renderers = option('renderers', 'auto').split(',');
const only = option('only'); // run just the tests whose name contains this
const samples = option('samples');

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

    await test('the automation API (codemap mcp render_map) waits for a still map, says what it shows and highlights', async () => {
      const info = await page.evaluate(async () => {
        const app = window.codemap;
        const idle = await app.idle({ timeout: 30000 });
        const described = app.describe();
        const ids = app.view.units.slice(0, 3).map((u) => u.node.id);
        app.highlight(ids, 'three units');
        const after = app.describe();
        app.select(null);
        return { idle, described, after, ids };
      });
      assert.equal(info.idle, true);
      assert.equal(info.described.view, 'galaxy');
      assert.ok(info.described.units > 10, `units: ${info.described.units}`);
      assert.equal(info.described.renderer, await page.evaluate(() => window.codemap.stage.backend));
      assert.ok(info.described.hud.some((l) => /\d+ links/.test(l)), info.described.hud.join(' | '));
      assert.ok(info.described.legend.length > 0, 'the legend has lines');
      assert.equal(info.after.selection, info.ids[0]);
      assert.ok(info.after.hud.some((l) => l.includes('three units')), info.after.hud.join(' | '));
    });

    for (const view of ['galaxy', 'city', 'layers', 'di', 'flow', 'matrix', 'auto']) {
      await test(`${view} view draws`, async () => {
        await page.evaluate((v) => (v === 'auto' ? window.codemap.setLevel('auto') : window.codemap.setView(v)), view);
        await page.waitForFunction(() => {
          const app = window.codemap;
          return app.view.units.length && app.view.settled !== false && (app.view !== app.zoomView || app.zoomView.semantic);
        }, null, { timeout: 60000, polling: 100 });
        await page.waitForTimeout(300);
        assert.ok(await litPixels(page) > 400, 'the canvas shows the map');
        // Shaders read positions by store index: every unit needs its own.
        const indices = await page.evaluate(() => {
          const units = window.codemap.view.units;
          return { count: units.length, distinct: new Set(units.map((u) => u.index).filter(Number.isInteger)).size };
        });
        assert.equal(indices.distinct, indices.count, 'every unit has its own place in the position store');
      });
    }

    await test('the matrix: dependencies below the diagonal, the ones against the layers above it, cycles as blocks', async () => {
      const info = await page.evaluate(() => {
        const app = window.codemap;
        app.setView('matrix');
        app.setLevel('namespace');
        const m = app.matrix.layout;
        const inBlock = (c) => m.blocks.some((b) => c.row >= b.from && c.row <= b.to && c.col >= b.from && c.col <= b.to);
        // A block is a real cycle: from its first unit every other one is reachable inside it.
        const connected = m.blocks.every((b) => {
          const reached = new Set([b.from]);
          for (let grew = true; grew;) {
            grew = false;
            for (const c of m.cells) if (inBlock(c) && reached.has(c.row) && !reached.has(c.col) && c.row >= b.from && c.row <= b.to) reached.add(c.col), (grew = true);
          }
          return reached.size === b.to - b.from + 1;
        });
        const levels = m.levels;
        return {
          units: app.matrix.units.length,
          cells: m.cells.length,
          outsideBlocksAbove: m.cells.filter((c) => c.col > c.row && !inBlock(c)).length,
          upward: m.cells.filter((c) => c.upward).map((c) => ({ above: c.col > c.row, inBlock: inBlock(c) })),
          blocks: m.blocks.length,
          connected,
          bandsCover: levels[0]?.from === 0 && levels.at(-1)?.to === m.order.length - 1 && levels.every((l, i) => i === 0 || l.from === levels[i - 1].to + 1),
          hud: document.getElementById('hud').textContent,
          buttons: [...document.querySelectorAll('#level-toggle button')].filter((b) => !b.disabled).map((b) => b.dataset.level),
        };
      });
      assert.ok(info.units > 5 && info.cells > 10, `units ${info.units}, cells ${info.cells}`);
      assert.equal(info.outsideBlocksAbove, 0, 'between blocks, every dependency is below the diagonal');
      assert.ok(info.upward.length > 0 && info.upward.every((u) => u.above && u.inBlock), `upward: ${JSON.stringify(info.upward)}`);
      assert.ok(info.blocks > 0 && info.connected, 'the Shop sample has cycles, each one block');
      assert.ok(info.bandsCover, 'the layer bands cover the diagonal without gaps');
      assert.match(info.hud, /\d+ layers · \d+ against the layers \(red\) · \d+ cycles?/);
      assert.deepEqual(info.buttons, ['project', 'namespace', 'type', 'member']);
      const projects = await page.evaluate(() => (window.codemap.setLevel('project'), window.codemap.matrix.units.length));
      assert.equal(projects, await page.evaluate(() => window.codemap.model.projects.length));
      await page.evaluate(() => window.codemap.setLevel('namespace'));
    });

    await test('the matrix: a click on a dependency selects it, a click on a unit lights up its row and column', async () => {
      await page.waitForTimeout(2300); // the columns rise
      const at = (selectCell) =>
        page.evaluate((cellWanted) => {
          const app = window.codemap;
          const v = app.matrix;
          const rect = app.stage.canvas.getBoundingClientRect();
          // The tallest column can't hide behind another one; nothing stands in front of the last row's tile.
          const cell = [...v.cells].sort((a, b) => b.height - a.height)[0];
          const unit = v.units[v.units.length - 1];
          const Vector = v.positionOf(unit.id).constructor;
          const point = cellWanted ? new Vector(cell.x, cell.height * 0.8, cell.z) : v.positionOf(unit.id);
          const p = app.stage.project(point);
          return { x: rect.left + p.x, y: rect.top + p.y + (cellWanted ? 0 : 3), source: cell.source, target: cell.target, unit: unit.id };
        }, selectCell);

      // The tile first: a selection opens the details panel, which covers the near right corner of the grid.
      const tile = await at(false);
      await page.mouse.click(tile.x, tile.y);
      const selected = await page.evaluate(() => ({ id: window.codemap.selection?.nodeId, primary: window.codemap.matrix.highlight?.primary, guides: window.codemap.matrix.guides.count }));
      assert.deepEqual(selected, { id: tile.unit, primary: tile.unit, guides: 2 });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.codemap.matrix.highlight), null);

      const cell = await at(true);
      await page.mouse.click(cell.x, cell.y);
      const picked = await page.evaluate(() => ({ selection: window.codemap.selection, hud: document.getElementById('hud').textContent }));
      assert.equal(picked.selection?.nodeId, cell.source);
      assert.equal(picked.selection?.pathTo, cell.target);
      assert.match(picked.hud, /→ .*: \d+ \w+/);
      await page.keyboard.press('Escape');
      // back to the plain galaxy of types for the tests that follow
      await page.evaluate(() => (window.codemap.setView('galaxy'), window.codemap.setLevel('type')));
    });

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
      // The unrelated node measured: the biggest one on screen (a small one is barely brighter than what is
      // behind it), not under a panel (the screenshot would show the panel), and clear of everything that stays
      // bright when the selection is made: the selected node's halo, the highlighted nodes with their glow, and
      // the highlighted links. All in screen pixels: where the camera is depends on the tests before and on the
      // layout, which varies from run to run.
      const other = await page.evaluate(() => {
        const app = window.codemap;
        const units = [...app.view.units].sort((a, b) => b.r - a.r);
        app.select(units[0].id);
        const h = app.view.highlight;
        const byId = new Map(units.map((u) => [u.id, u]));
        // The camera's up direction in the world (positionOf gives a fresh Vector3: three is not on window).
        const up = app.view.positionOf(units[0].id).set(0, 1, 0).applyQuaternion(app.stage.camera.quaternion);
        const screen = (u) => {
          const position = app.view.positionOf(u.id);
          const p = app.stage.project(position);
          const edge = p && app.stage.project(position.clone().addScaledVector(up, u.r));
          return p && edge && { x: p.x, y: p.y, r: Math.hypot(edge.x - p.x, edge.y - p.y) };
        };
        const toSegment = (p, a, b) => {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
          return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        };
        const selected = screen(units[0]);
        const lit = [...h.nodes].map((id) => byId.get(id)).filter(Boolean).map(screen).filter(Boolean);
        const links = [...h.links].map((i) => app.view.links[i]).map((l) => [screen(l.s), screen(l.t)]).filter(([a, b]) => a && b);
        const MARGIN = 12; // soft edges and bloom around what is drawn
        const rect = app.stage.canvas.getBoundingClientRect();
        // The canvas is what shows at the centre and the corners of the measured box (the labels get hidden).
        const visible = (p) => [[0, 0], [-3, -3], [3, -3], [-3, 3], [3, 3]].every(([dx, dy]) =>
          document.elementsFromPoint(rect.left + p.x + dx, rect.top + p.y + dy).find((e) => !e.closest('#labels')) === app.stage.canvas);
        // Biggest on screen, not in the world: a big node far from the camera is a few dim pixels, about as bright
        // as the glow around it, and its dimming would not show.
        const candidates = units
          .filter((x) => !h.nodes.has(x.id))
          .map((x) => ({ unit: x, p: screen(x) }))
          .filter(({ p }) => p && p.r >= 3)
          .sort((a, b) => b.p.r - a.p.r);
        const found = candidates.find(({ p }) => {
          if (!visible(p)) return false;
          if (selected && Math.hypot(p.x - selected.x, p.y - selected.y) < Math.max(80, selected.r * 2.5 + MARGIN)) return false; // halo: 1.8 r
          if (lit.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < q.r * 2.5 + MARGIN)) return false;
          return links.every(([a, b]) => toSegment(p, a, b) > MARGIN);
        });
        app.select(null);
        if (!found) return null;
        const { unit: u, p } = found;
        return { id: u.id, selected: units[0].id, x: Math.round(rect.left + p.x), y: Math.round(rect.top + p.y) };
      });
      assert.ok(other, 'an unrelated node on screen, clear of the panels, the selection and its links');
      // Only the node counts: hide the HTML labels drawn over the canvas, and the sky behind it (a star in the
      // measured pixels, or a nebula as bright as a dimmed node, would hide the change).
      await page.evaluate(() => {
        document.getElementById('labels').style.visibility = 'hidden';
        window.codemap.stage.sky.visible = false;
        window.codemap.stage.invalidate();
      });
      await drained(page);
      const before = await brightness(other);
      // As if the user had been away: no ambient frames (pulsing halo) that would hide a missing frame.
      await page.evaluate((id) => {
        window.codemap.stage.lastInput = -1e9;
        window.codemap.select(id);
      }, other.selected);
      // Every frame the stage wanted to draw is drawn (software frames can be slow), then nothing more.
      await drained(page);
      const after = await brightness(other);
      await page.evaluate(() => {
        window.codemap.select(null);
        document.getElementById('labels').style.visibility = '';
        window.codemap.stage.sky.visible = true;
        window.codemap.stage.invalidate();
      });
      assert.ok(after < before * 0.7, `brightness of an unrelated node (${other.id}, selected ${other.selected}): ${before} before, ${after} after selecting`);
    });

    await test('a hover right after a recolour keeps the full colour upload', async () => {
      // three uploads only the update ranges when there are any: a hover range must not cut a pending full upload.
      const ranges = await page.evaluate(() => {
        const view = window.codemap.view;
        view.recolor();
        view.setHovered(view.units[1].id);
        const pending = view.units[0].mesh.geometry.attributes.aColor.updateRanges.length;
        view.setHovered(null);
        return pending;
      });
      assert.equal(ranges, 0, 'the whole colour buffer is still due for upload');
    });

    await test('links in focus flow (moving dashes), also with the particles off', async () => {
      const result = await page.evaluate(async () => {
        const app = window.codemap;
        app.setState({ particles: 0 }, 'options');
        const units = [...app.view.units].sort((a, b) => b.r - a.r);
        app.stage.onInput(); // the user is here: ambient motion runs
        app.select(units[0].id);
        // Frames keep coming while the dashes move (however slowly software rendering draws them).
        const start = app.perf.renders;
        const deadline = performance.now() + 20000;
        while (app.perf.renders < start + 4 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        const state = { particles: app.view.particles.count, flowing: app.view.linkMesh.flowing, renders: app.perf.renders - start };
        app.select(null);
        app.setState({ particles: 1 }, 'options');
        return state;
      });
      assert.equal(result.particles, 0, 'no particles');
      assert.ok(result.flowing > 0, 'the selected links have dashes');
      assert.ok(result.renders >= 4, `frames while the dashes move: ${result.renders}`);
    });

    await test('a click sends a wave of light out from the selection', async () => {
      const result = await page.evaluate(async () => {
        const app = window.codemap;
        const unit = [...app.view.units].sort((a, b) => b.linkIndices.length - a.linkIndices.length)[0];
        app.select(unit.id);
        const view = app.view;
        const started = { front: view.linkMesh.waveFront.value, reached: [...view.coronas.hops.array.slice(0, view.units.length)].filter((h) => h >= 0).length };
        const deadline = performance.now() + 30000;
        while (view.wave && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        const ended = { front: view.linkMesh.waveFront.value, ring: view.ring.material.opacity };
        app.select(null);
        return { started, ended };
      });
      assert.ok(result.started.front > -1, `the wave starts at the selection (front ${result.started.front})`);
      assert.ok(result.started.reached >= 2, `units on the wave's way: ${result.started.reached}`);
      assert.ok(result.ended.front < -10 && result.ended.ring === 0, 'the wave and the shock ring end (the ring fades out)');
    });

    await test('a new layout unfolds from its centre, then stops', async () => {
      const result = await page.evaluate(async () => {
        const app = window.codemap;
        app.galaxy.units = []; // nothing remembered: every unit is new
        app.galaxy.positions.clear();
        app.rebuild();
        const store = app.view.store;
        const running = store.introRunning;
        let spread = 0;
        for (let i = 0; i < app.view.units.length; i++) spread = Math.max(spread, Math.abs(store.origin.image.data[i * 4]));
        const deadline = performance.now() + 30000;
        while (store.introRunning && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        return { running, spread, ended: !store.introRunning };
      });
      assert.ok(result.running, 'the unfolding runs after a fresh build');
      assert.ok(result.spread > 0 && result.spread < 60, `it starts as a tight ball (spread ${result.spread})`);
      assert.ok(result.ended, 'the unfolding ends');
      await settled(page, 120000);
      assert.ok(await litPixels(page) > 400, 'the canvas shows the map');
    });

    await test('living motion keeps the map moving: twinkling sky, comets at rest', async () => {
      const sky = async () => {
        const shot = await page.locator('#stage canvas').screenshot({ clip: { x: 0, y: 0, width: 300, height: 200 } });
        return shot.toString('base64');
      };
      await page.evaluate(() => window.codemap.setMotion('living'));
      try {
        const state = await page.evaluate(async () => {
          const app = window.codemap;
          const start = app.perf.renders;
          const deadline = performance.now() + 20000;
          while (app.perf.renders < start + 4 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          return { renders: app.perf.renders - start, comets: app.view.particles.count, motion: app.stage.motion };
        });
        assert.equal(state.motion, 'living');
        assert.ok(state.renders >= 4, `frames keep coming: ${state.renders}`);
        assert.ok(state.comets > 0, 'comets flow along the strongest links at rest');
        const before = await sky();
        await page.waitForTimeout(1200);
        const after = await sky();
        const changed = await page.evaluate(async ([a, b]) => {
          const pixels = async (base64) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = new OffscreenCanvas(image.width, image.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            return ctx.getImageData(0, 0, image.width, image.height).data;
          };
          const [p, q] = [await pixels(a), await pixels(b)];
          let changed = 0;
          for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 30) changed++;
          return changed;
        }, [before, after]);
        assert.ok(changed > 3, `twinkling stars: ${changed} pixels changed`);
      } finally {
        await page.evaluate(() => window.codemap.setMotion(null));
      }
    });

    await test('an idle map draws nothing', async () => {
      // Calm motion (the default without a GPU): decoration stops, nothing is drawn while nothing changes.
      assert.equal(await page.evaluate(() => window.codemap.stage.motion), 'calm');
      await page.evaluate(() => window.codemap.select(null));
      await page.mouse.move(2, 300);
      await drained(page); // the hover change and the last frames of the camera damping
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

    await test('a level switch frames the new level, also after the user turned the map (and so does coming back to the galaxy)', async () => {
      const still = () => page.waitForFunction(() => {
        const app = window.codemap;
        return app.view === app.galaxy && app.galaxy.settled && !app.galaxy.store.introRunning && !app.stage.flight;
      }, null, { timeout: 60000, polling: 100 });
      // The user turns the map a little (from then on the camera is theirs), then switches the level or the view.
      const turnAndSwitch = async (change) => {
        await page.mouse.move(760, 420);
        await page.mouse.down();
        await page.mouse.move(800, 440, { steps: 4 });
        await page.mouse.up();
        assert.equal(await page.evaluate(() => window.codemap.galaxy.userMoved), true);
        await page.evaluate(change);
        await still();
        // The farthest unit from the middle of the view, in half views (beyond 1: off the screen; a fit frames
        // the units' spheres a little tightly, so an outer centre may sit just past 1).
        return page.evaluate(() => {
          const app = window.codemap;
          app.stage.camera.updateMatrixWorld();
          let worst = 0;
          for (const u of app.galaxy.units) {
            const p = app.galaxy.positionOf(u.id).project(app.stage.camera);
            worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
          }
          return worst;
        });
      };
      await page.evaluate(() => (window.codemap.select(null), window.codemap.setView('galaxy'), window.codemap.setLevel('type')));
      await still();
      const namespaces = await turnAndSwitch(() => (window.codemap.select(null), window.codemap.setLevel('namespace')));
      assert.ok(namespaces <= 1.1, `namespaces: a unit is ${namespaces.toFixed(2)} half views from the middle, the level is not framed`);
      // Back to the types: laid out before, but not what was on screen – framed as well.
      const types = await turnAndSwitch(() => (window.codemap.select(null), window.codemap.setLevel('type')));
      assert.ok(types <= 1.1, `types again: a unit is ${types.toFixed(2)} half views from the middle, the level is not framed`);
      // Back from the city, whose camera looked at something else.
      const back = await turnAndSwitch(() => (window.codemap.setView('city'), window.codemap.setView('galaxy')));
      assert.ok(back <= 1.1, `back from the city: a unit is ${back.toFixed(2)} half views from the middle, the galaxy is not framed`);
    });

    await test('no errors on the page', async () => {
      assert.deepEqual(errors, []);
    });
    await page.close();

    // Shaders compiled while drawing stall the page (WebGL waits for each one, WebGPU's queue too): a view
    // compiles its shaders the first time it is drawn, and never again – not when the user comes back to it,
    // not on the first click.
    const counted = await open(browser, query('/sample.codemap.json'), { init: countCompiles });
    await test('shaders compile once: neither the first click nor going back to a view compiles any', async () => {
      const p = counted.page;
      await settled(p, 60000);
      const compiles = () => p.evaluate(() => window.__compiles);
      const drawn = async () => {
        await p.waitForFunction(() => {
          const app = window.codemap;
          return app.view.units.length && app.view.settled !== false && (app.view !== app.zoomView || app.zoomView.semantic);
        }, null, { timeout: 60000, polling: 100 });
        const renders = await p.evaluate(() => window.codemap.perf.renders);
        await p.waitForFunction((n) => window.codemap.perf.renders >= n + 2, renders, { timeout: 60000, polling: 50 });
      };
      await drawn();
      let before = await compiles();
      await p.evaluate(() => window.codemap.select(window.codemap.view.units[0].id));
      await drawn();
      assert.equal((await compiles()) - before, 0, 'shaders compiled by the first selection');
      await p.evaluate(() => window.codemap.select(null));

      const tour = ['galaxy', 'city', 'layers', 'di', 'flow', 'matrix', 'auto'];
      const visit = async (view) => {
        await p.evaluate((v) => {
          const app = window.codemap;
          if (v === 'auto') return app.setLevel('auto');
          app.setView(v);
          app.setLevel('type');
        }, view);
        await drawn();
      };
      for (const view of tour) await visit(view);
      const again = [];
      for (const view of tour) {
        before = await compiles();
        await visit(view);
        again.push(`${view} ${(await compiles()) - before}`);
      }
      assert.ok(again.every((c) => c.endsWith(' 0')), `shaders compiled when going back to a view: ${again.join(', ')}`);
      assert.deepEqual(counted.errors, []);
    });
    await counted.page.close();

    // The editor loads the map again after every analysis: the cached map first and the fresh one a moment later,
    // then after every save. (A small canvas: without a GPU a frame of 2000 units costs seconds at the default size.)
    const again = await open(browser, query(big), { width: 640, height: 400 });
    const load = (change) => again.page.evaluate(async ({ url, change }) => {
      const doc = await (await fetch(url)).json();
      if (change === 'one type less') {
        const type = doc.nodes.findLast((n) => n.kind === 'class');
        const gone = new Set(doc.nodes.filter((n) => n.id === type.id || n.parent === type.id).map((n) => n.id));
        doc.nodes = doc.nodes.filter((n) => !gone.has(n.id));
        doc.edges = doc.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
      }

      window.codemap.load(doc, { preserve: true });
    }, { url: big, change });
    const rests = () => again.page.waitForFunction(() => {
      const app = window.codemap;
      return app?.view?.units?.length && app.view.settled && !app.view.store.introRunning && !app.stage.flight;
    }, null, { timeout: 120000, polling: 100 });

    await test('a map loaded again before its first layout has settled is framed all the same', async () => {
      const p = again.page;
      await p.waitForFunction(() => window.codemap?.view?.units?.length, null, { timeout: 60000, polling: 20 });
      await p.waitForTimeout(300);
      assert.equal(await p.evaluate(() => window.codemap.view.settled), false, 'the first layout is still running');
      await load();
      await rests();
      const framed = await p.evaluate(() => {
        const app = window.codemap;
        app.stage.camera.updateMatrixWorld();
        let worst = 0;
        for (const u of app.view.units) {
          const at = app.view.positionOf(u.id).project(app.stage.camera);
          worst = Math.max(worst, Math.abs(at.x), Math.abs(at.y));
        }

        return { worst, userMoved: app.view.userMoved };
      });
      assert.equal(framed.userMoved, false, 'nobody moved the camera');
      assert.ok(framed.worst <= 1.1, `a unit is ${framed.worst.toFixed(2)} half views from the middle: the camera stayed in the starting ball`);
    });

    await test('the same graph loaded again stays as it is (no new layout, the selection stays); another one is laid out', async () => {
      const p = again.page;
      await rests();
      const state = () => p.evaluate(() => {
        const app = window.codemap;
        const view = app.view;
        const unit = view.units[7];
        return {
          units: view.units.length,
          layoutStart: view.layoutStart,
          at: [unit.x, unit.y, unit.z],
          selected: view.highlight?.primary ?? null,
          unfolding: view.store.introRunning,
          settled: view.settled,
          newData: unit.node === app.model.get(unit.id),
        };
      });
      await p.evaluate(() => window.codemap.select(window.codemap.view.units[5].id));
      const before = await state();
      await load();
      const same = await state();
      assert.deepEqual({ ...same, newData: true }, { ...before, newData: true }, 'the map changed although the graph did not');
      assert.equal(same.newData, true, 'the units show the nodes of the new document');
      assert.ok(same.selected, 'the selection is still there');

      await load('one type less');
      const other = await state();
      assert.equal(other.units, before.units - 1);
      assert.notEqual(other.layoutStart, before.layoutStart, 'a graph with other units gets a new layout');
      await rests();
      await p.evaluate(() => window.codemap.select(null));
    });

    await test('single-key shortcuts are plain keys: not with Ctrl or Cmd, not in a text area', async () => {
      const p = again.page;
      await rests();
      const shown = () => p.evaluate(() => `${window.codemap.state.view} ${window.codemap.state.level}`);
      const start = await shown();
      await p.keyboard.press('Control+c'); // copy
      await p.keyboard.press('Meta+c');
      await p.keyboard.press('Control+1'); // the editor's "first editor group"
      await p.keyboard.press('Alt+m');
      assert.equal(await shown(), start, 'a shortcut with a modifier changed the map');
      await p.evaluate(() => {
        const area = document.createElement('textarea');
        area.id = 'smoke-area';
        document.body.append(area);
        area.focus();
      });
      await p.keyboard.press('c');
      assert.equal(await shown(), start, 'typing in a text area changed the map');
      await p.evaluate(() => document.getElementById('smoke-area').remove());
      await p.keyboard.press('c');
      assert.match(await shown(), /^city /, 'the plain key still works');
      await p.keyboard.press('g');
      assert.match(await shown(), /^galaxy /);
      await rests();
    });

    await test('labels are laid out when the camera, the units or the selection change, not on every frame', async () => {
      const p = again.page;
      await rests();
      await p.evaluate(() => {
        const app = window.codemap;
        app.setMotion('living'); // the sky twinkles: frames keep coming
        const labels = app.view.labels;
        const render = labels.render.bind(labels);
        window.__labelLayouts = 0;
        labels.render = (...args) => {
          window.__labelLayouts++;
          return render(...args);
        };
      });
      await rests();
      const count = () => p.evaluate(() => ({ layouts: window.__labelLayouts, frames: window.codemap.perf.renders }));
      const frames = async (n) => {
        const from = (await count()).frames;
        await p.waitForFunction((to) => window.codemap.perf.renders >= to, from + n, { timeout: 120000, polling: 50 });
      };
      await frames(2); // whatever was still pending
      const idle = await count();
      await frames(4);
      const later = await count();
      assert.ok(later.frames >= idle.frames + 4, 'frames are drawn');
      assert.equal(later.layouts - idle.layouts, 0, 'labels were laid out again although nothing they depend on changed');

      await p.evaluate(() => window.codemap.view.setHovered(window.codemap.view.units[3].id));
      await frames(2);
      const hovered = await count();
      assert.ok(hovered.layouts > later.layouts, 'a hover lays the labels out again');
      await p.evaluate(() => window.codemap.view.setHovered(null));
      await p.mouse.move(320, 200);
      await p.mouse.down();
      await p.mouse.move(350, 215, { steps: 3 });
      await p.mouse.up();
      await frames(2);
      assert.ok((await count()).layouts > hovered.layouts, 'turning the camera lays the labels out again');
    });

    await test('hovering a unit and leaving it brings the same quiet flow back', async () => {
      const p = again.page;
      await rests();
      await p.evaluate(() => (window.codemap.setMotion('living'), window.codemap.select(null), window.codemap.view.setHovered(null)));
      const flow = () => p.evaluate(() => {
        const particles = window.codemap.view.particles;
        return { count: particles.count, motion: Array.from(particles.motion.array.slice(0, 60)), ends: Array.from(particles.ends.array.slice(0, 60)) };
      });
      const rest = await flow();
      assert.ok(rest.count > 0, 'a living map at rest has a quiet flow');
      const linked = await p.evaluate(() => {
        const view = window.codemap.view;
        const unit = view.units.find((u) => u.linkIndices.length > 1);
        view.setHovered(unit.id);
        const ends = Array.from(view.particles.ends.array.slice(0, view.particles.count * 2));
        return { index: unit.index, links: unit.linkIndices.length, strangers: ends.filter((_, i) => i % 2 === 0).filter((source, i) => source !== unit.index && ends[i * 2 + 1] !== unit.index).length, count: view.particles.count };
      });
      assert.ok(linked.count > 0, 'the hovered unit\'s links flow');
      assert.equal(linked.strangers, 0, 'particles on links that are not the hovered unit\'s');
      await p.evaluate(() => window.codemap.view.setHovered(null));
      assert.deepEqual(await flow(), rest, 'the quiet flow came back as another one');
      assert.deepEqual(again.errors, []);
    });
    await again.page.close();

    if (renderer === 'webgpu') {
      // The compute-shader layout (forced: the CI adapter is a software one, where it is not chosen by itself).
      const gpu = await open(browser, query('/sample.codemap.json') + '&layout=gpu');
      await test('the GPU layout settles and looks like the d3 layout', async () => {
        await settled(gpu.page, 120000);
        const result = await gpu.page.evaluate(async () => {
          const app = window.codemap;
          const { MainThreadLayout, layoutMetrics } = window.codemapLayout;
          const spec = app.galaxy.layoutSpec(app.state, 0);
          const d3 = new MainThreadLayout(app.galaxy.layoutSpec(app.state, 0), { prewarmMs: 0 });
          while (!d3.settled) d3.step(1000);
          return { kind: app.galaxy.layout.kind, gpu: layoutMetrics(spec, app.galaxy.layout.positions), d3: layoutMetrics(spec, d3.positions) };
        });
        assert.equal(result.kind, 'gpu');
        assert.ok(result.gpu.finite, 'no broken positions');
        const ratio = (key) => result.gpu[key] / result.d3[key];
        for (const key of ['spread', 'linkStretch']) assert.ok(ratio(key) > 0.6 && ratio(key) < 1.5, `${key}: GPU ${result.gpu[key]} vs d3 ${result.d3[key]}`);
        assert.ok(await litPixels(gpu.page) > 400, 'the canvas shows the map');
        assert.deepEqual(gpu.errors, []);
      });
      await test('GPU layouts replace each other, and the semantic zoom takes over their positions', async () => {
        await gpu.page.evaluate(() => {
          const app = window.codemap;
          app.setLevel('namespace'); // interrupts nothing (settled), frees the old buffers
          app.setLevel('type');
        });
        await settled(gpu.page, 120000);
        await gpu.page.evaluate(() => window.codemap.setLevel('auto'));
        await gpu.page.waitForFunction(() => window.codemap.zoomView.semantic, null, { timeout: 120000 });
        const positions = await gpu.page.evaluate(() => window.codemap.view.units.every((u) => Number.isFinite(u.x) && Number.isFinite(u.y)));
        assert.ok(positions, 'units have positions');
        // Shaders read positions by store index: every unit needs its own.
        const indices = await gpu.page.evaluate(() => {
          const units = window.codemap.view.units;
          return { count: units.length, distinct: new Set(units.map((u) => u.index).filter(Number.isInteger)).size };
        });
        assert.equal(indices.distinct, indices.count, 'every unit has its own place in the position store');
        assert.ok(await litPixels(gpu.page) > 400, 'the canvas shows the map');
        assert.deepEqual(gpu.errors, []);
      });
      await gpu.page.close();
    }

    // A small canvas: without a GPU a frame costs seconds (mostly the bloom, per pixel), and a screenshot
    // waits for the frames still being drawn – on a one-core runner over a minute at the default size.
    const large = await open(browser, query(big), { width: 640, height: 400 });
    await test('a generated graph with 2000 types is laid out in a worker', async () => {
      // The worker does not wait for frames: even without a GPU (slow frames) the layout settles quickly.
      await settled(large.page, 60000);
      const info = await large.page.evaluate(() => ({ units: window.codemap.view.units.length, layout: window.codemap.view.layout.kind }));
      assert.ok(info.units >= 2000, `units: ${info.units}`);
      assert.equal(info.layout, 'worker');
      await drained(large.page, 120000); // the unfolding and the camera's flight are drawn
      assert.ok(await litPixels(large.page) > 400, 'the canvas shows the map');
      assert.deepEqual(large.errors, []);
    });
    if (renderer === 'webgpu') {
      await test('the grid many-body force (big layouts on the GPU) looks like the d3 layout', async () => {
        await settled(large.page, 60000);
        const result = await large.page.evaluate(async () => {
          const app = window.codemap;
          app.stage.setPaused(true);
          const { MainThreadLayout, GpuLayout, PositionStore, layoutMetrics } = window.codemapLayout;
          const spec = app.galaxy.layoutSpec(app.state, 0);
          const grid = new GpuLayout(app.galaxy.layoutSpec(app.state, 0), { renderer: app.stage.renderer, store: new PositionStore(), mode: 'grid' });
          grid.ticksPerFrame = 40;
          while (!grid.settled) {
            grid.step();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const d3 = new MainThreadLayout(app.galaxy.layoutSpec(app.state, 0), { prewarmMs: 0 });
          while (!d3.settled) d3.step(1000);
          const metrics = { grid: layoutMetrics(spec, grid.positions), d3: layoutMetrics(spec, d3.positions), side: grid.grid.side };
          grid.dispose();
          app.stage.setPaused(false);
          return metrics;
        });
        assert.ok(result.grid.finite, 'no broken positions');
        assert.ok(result.side >= 8, `cells per axis: ${result.side}`);
        const ratio = (key) => result.grid[key] / result.d3[key];
        for (const key of ['spread', 'linkStretch', 'groupTightness']) assert.ok(ratio(key) > 0.8 && ratio(key) < 1.3, `${key}: grid ${result.grid[key]} vs d3 ${result.d3[key]}`);
        assert.deepEqual(large.errors, []);
      });
    }
    await large.page.close();

    // A TypeScript-shaped map (written by hand, after the analyzer's shared analysis: tests/CodeMap.Tests/Golden):
    // packages, folders, files as the units, classes and functions in them, class methods inside the classes.
    const ts = await open(browser, query(fixture('tests/CodeMap.Tests/Golden/ts-mini.codemap.json')));
    await test('a TypeScript map: files are the units, in the language\'s words', async () => {
      await settled(ts.page, 60000);
      const info = await ts.page.evaluate(() => ({
        buttons: [...document.querySelectorAll('#level-toggle [data-level]')].map((b) => b.textContent),
        hud: document.getElementById('hud').textContent,
        units: window.codemap.view.units.map((u) => u.node.kind),
        method: (() => {
          const node = window.codemap.model.get('ts:api:src/orders/orders.service.ts#OrdersService.place');
          return { level: node.level, type: node.typeNode?.id, owner: node.ownerNode?.id };
        })(),
      }));
      assert.deepEqual(info.buttons, ['Packages', 'Folders', 'Files', 'Declarations', 'Auto']);
      assert.match(info.hud, /\d+ files · \d+ links/);
      assert.ok(info.units.length === 9 && info.units.every((k) => k === 'module'), `units: ${info.units}`);
      assert.deepEqual(info.method, { level: 'member', type: 'ts:api:src/orders/orders.service.ts', owner: 'ts:api:src/orders/orders.service.ts#OrdersService' });
      const names = await ts.page.evaluate(() => {
        const { shortName } = window.codemapLayout;
        const model = window.codemap.model;
        return ['OrdersService.place', 'legacyTotal'].map((name) => shortName(model.get(`ts:api:src/orders/orders.service.ts#${name}`)));
      });
      // A method is named with its class, a function on its own.
      assert.deepEqual(names, ['OrdersService.place', 'legacyTotal']);
    });

    for (const view of ['galaxy', 'city', 'layers', 'di', 'matrix', 'auto']) {
      await test(`a TypeScript map: ${view} view draws`, async () => {
        await settled(ts.page, 60000);
        await ts.page.evaluate((v) => (v === 'auto' ? window.codemap.setLevel('auto') : (window.codemap.setLevel('type'), window.codemap.setView(v))), view);
        await ts.page.waitForFunction(() => {
          const app = window.codemap;
          return app.view.units.length && app.view.settled !== false && (app.view !== app.zoomView || app.zoomView.semantic);
        }, null, { timeout: 60000, polling: 100 });
        await ts.page.waitForTimeout(300);
        assert.ok(await litPixels(ts.page) > 400, 'the canvas shows the map');
      });
    }

    await test('a TypeScript map: the DI view notes what the NestJS container changes on purpose', async () => {
      await settled(ts.page, 60000);
      const di = await ts.page.evaluate(() => {
        const app = window.codemap;
        app.setLevel('type');
        app.setView('di');
        return { hud: document.getElementById('hud').textContent, info: app.view.links?.filter((l) => l.violation === 'info').length };
      });
      assert.match(di.hud, /No DI problems found · 1 note\(s\)/);
      assert.equal(di.info, 1, 'the link that makes OrdersService request-scoped is marked');
    });

    await test('a TypeScript map: the call flow starts at the routes and dispatches through the interface', async () => {
      await settled(ts.page, 60000);
      const flow = await ts.page.evaluate(() => {
        const app = window.codemap;
        app.setLevel('type');
        app.setView('galaxy');
        app.setView('flow'); // the toolbar button: the best entry point
        return {
          entries: app.getEntryPoints().map((e) => ({ id: e.node.id, methods: e.methods.map((m) => m.id) })),
          roots: app.flow?.roots.map((r) => r.id) ?? [],
          methods: app.flow?.stats.methods ?? 0,
          nodes: [...(app.flow?.nodes.keys() ?? [])],
          hud: document.getElementById('hud').textContent,
        };
      });
      const routes = ['ts:api:src/orders/orders.routes.ts#route:GET /orders/:id', 'ts:api:src/orders/orders.routes.ts#route:POST /orders'];
      assert.ok(flow.entries.some((e) => e.id === 'ts:api:src/orders/orders.routes.ts' && routes.every((r) => e.methods.includes(r))), `entries: ${JSON.stringify(flow.entries)}`);
      assert.ok(flow.roots.some((r) => routes.includes(r)), `roots: ${flow.roots}`);
      assert.ok(flow.methods > 2, `methods in the flow: ${flow.methods}`);
      // POST /orders → OrdersService.place → OrdersRepository.save (interface) → SqlOrdersRepository.save
      assert.ok(flow.nodes.includes('ts:api:src/orders/orders.repository.ts#SqlOrdersRepository.save'), `flow: ${flow.nodes}`);
      assert.match(flow.hud, /methods in \d+ files?/);
    });

    await test('a TypeScript map keeps its levels when saved, without errors', async () => {
      await settled(ts.page, 60000);
      const saved = await ts.page.evaluate(() => {
        const text = window.codemapLayout.serializeDoc(window.codemap.model.doc);
        return JSON.parse(text).nodes.find((n) => n.id === 'ts:api:src/orders/orders.service.ts')?.level;
      });
      assert.equal(saved, 'type');
      assert.deepEqual(ts.errors, []);
    });
    await ts.page.close();

    if (samples) await sampleTests(query);
    else if (renderer === renderers[0]) console.log('  - the analyzer\'s maps of samples/shop-ts and samples/: skipped (no --samples)');

    // AR glasses: side-by-side stereo at the glasses' 3D-mode resolution.
    const ar = await open(browser, query('/sample.codemap.json') + '&ar=full', { width: 3840, height: 1080 });
    await test('AR glasses mode draws the map once per eye, with depth', async () => {
      await settled(ar.page, 120000);
      await ar.page.waitForFunction(() => !window.codemap.view.store?.introRunning, null, { timeout: 60000 });
      await drained(ar.page);
      const state = await ar.page.evaluate(() => {
        const app = window.codemap;
        const visible = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.style.display !== 'none').length;
        return {
          active: app.ar.active,
          sbs: app.stage.stereo?.sbs,
          chromeHidden: getComputedStyle(document.getElementById('topbar')).display === 'none',
          labels: [visible('#labels .eye-left .label'), visible('#labels .eye-right .label')],
          reticles: document.querySelectorAll('#ar-hud .ar-reticle').length,
          // The HUD sits at the map's depth: each eye's copy moved towards the nose.
          hud: [...document.querySelectorAll('#ar-hud .ar-eye-inner')].map((el) => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0)),
        };
      });
      assert.ok(state.active && state.sbs === 'full', 'stereo is on');
      assert.ok(state.chromeHidden, 'the normal UI is hidden (it would be split between the eyes)');
      assert.equal(state.reticles, 2, 'a reticle per eye');
      assert.ok(state.hud[0] > 0 && state.hud[1] === -state.hud[0], `HUD shifted to the map's depth: ${state.hud}`);
      assert.ok(state.labels[0] > 0 && state.labels[0] === state.labels[1], `labels per eye: ${state.labels}`);
      const halves = await eyeHalves(ar.page);
      assert.ok(halves.left > 400 && halves.right > 400, `both eyes show the map: ${halves.left} / ${halves.right} lit pixels`);
      assert.ok(halves.left / halves.right > 0.6 && halves.left / halves.right < 1.6, `similar eyes: ${halves.left} / ${halves.right}`);
      assert.ok(halves.differing > 100, `the eyes differ (disparity): ${halves.differing} pixels`);
    });
    await test('AR: the screen\'s shape: a hint until it is side by side, the field of view fits the eye pictures', async () => {
      // XREAL 1S (the default profile): 52° diagonal on a 16:10 display; a 16:9 eye picture spans its width.
      const tan = Math.tan((26 * Math.PI) / 180) / Math.hypot(1.6, 1);
      const degrees = (t) => (2 * Math.atan(t) * 180) / Math.PI;
      const fov169 = degrees((tan * 1.6) / (16 / 9));
      const fov1610 = degrees(tan);
      const at = async (width, height, fov) => {
        await ar.page.setViewportSize({ width, height });
        await ar.page.waitForFunction(([w, h, f]) => {
          const stage = window.codemap.stage;
          return stage.width === w && stage.height === h && (f === null || Math.abs(stage.camera.fov - f) < 0.01);
        }, [width, height, fov], { timeout: 30000, polling: 50 });
        return ar.page.evaluate(() => ({
          fov: window.codemap.stage.camera.fov,
          aspect: window.codemap.stage.camera.aspect,
          message: document.querySelector('#ar-hud .ar-message')?.textContent ?? '',
        }));
      };
      const full = await at(3840, 1080, fov169);
      assert.ok(Math.abs(full.aspect - 32 / 9) < 0.01 && full.message === '', `16:9 eyes: ${JSON.stringify(full)}`);
      const flat = await at(1920, 1200, null);
      assert.match(flat.message, /3D Mode/, 'not side by side yet: how to turn 3D on');
      const tall = await at(3840, 1200, fov1610);
      assert.ok(Math.abs(tall.aspect - 3.2) < 0.01 && tall.message === '', `16:10 eyes fill the display: ${JSON.stringify(tall)}`);
      const back = await at(3840, 1080, fov169);
      assert.equal(back.message, '', 'the hint goes once the screen is side by side');
    });
    await test('AR: the reticle selects what is in the middle of the view; Esc goes back', async () => {
      const target = await ar.page.evaluate(() => {
        const app = window.codemap;
        const stage = app.stage;
        const unit = [...app.view.units].sort((a, b) => b.r - a.r)[0];
        const position = app.view.positionOf(unit.id);
        stage.controls.target.copy(position);
        stage.camera.lookAt(position);
        stage.invalidate();
        return unit.id;
      });
      // Space and the state right after it in one go: without a GPU a single frame at 3840×1080 can outlast
      // the whole wave, so it may be over by the time a separate call looks.
      const selected = await ar.page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
        return { id: window.codemap.selection?.nodeId, wave: !!window.codemap.view.wave };
      });
      assert.equal(selected.id, target, 'Space selects the unit under the reticle');
      assert.ok(selected.wave, 'the selection wave runs');
      await ar.page.keyboard.press('Escape'); // clears the selection
      await ar.page.keyboard.press('Escape'); // leaves AR
      const after = await ar.page.evaluate(() => ({
        active: window.codemap.ar.active,
        stereo: window.codemap.stage.stereo,
        fov: window.codemap.stage.camera.fov,
        chrome: getComputedStyle(document.getElementById('topbar')).display !== 'none',
      }));
      assert.ok(!after.active && !after.stereo, 'AR is off');
      assert.equal(after.fov, 55, 'the normal field of view is back');
      assert.ok(after.chrome, 'the normal UI is back');
      assert.deepEqual(ar.errors, []);
    });
    await ar.page.close();

    const half = await open(browser, query('/sample.codemap.json') + '&ar=half', { width: 1920, height: 1080 });
    await test('AR glasses in half side-by-side: squeezed eyes', async () => {
      await settled(half.page, 120000);
      await half.page.waitForFunction(() => !window.codemap.view.store?.introRunning, null, { timeout: 60000 });
      await drained(half.page);
      const state = await half.page.evaluate(() => {
        const label = [...document.querySelectorAll('#labels .eye-left .label')].find((el) => el.style.display !== 'none');
        return { sbs: window.codemap.stage.stereo?.sbs, aspect: window.codemap.stage.camera.aspect, squeezed: !!label?.style.transform.includes('scaleX(0.5)') };
      });
      assert.equal(state.sbs, 'half');
      assert.ok(Math.abs(state.aspect - 32 / 9) < 0.01, `two 16:9 eyes: aspect ${state.aspect}`);
      assert.ok(state.squeezed, 'labels are squeezed (the glasses stretch them back)');
      const halves = await eyeHalves(half.page);
      assert.ok(halves.left > 200 && halves.right > 200, `both eyes show the map: ${halves.left} / ${halves.right}`);
      assert.deepEqual(half.errors, []);
    });
    await half.page.close();
  }

  await graphicsFallbacks();
} finally {
  await browser.close();
  await server.close();
}

/**
 * Editors and machines without a usable GPU (Cursor or VS Code with hardware acceleration off, a VM): recent
 * Chromium gives them no software WebGL 2, but may give a software WebGPU adapter. Whatever renderer is set,
 * the map then draws with WebGPU; with neither, the page says so.
 */
async function graphicsFallbacks() {
  console.log('\nwithout WebGL 2');
  const url = (renderer) => `${server.url}/?${new URLSearchParams({ data: '/sample.codemap.json', bench: '1', ...(renderer === 'auto' ? {} : { renderer }) })}`;
  const noWebGL = await launch({ headed: args.includes('--headed'), args: [...CHROMIUM_ARGS, '--disable-webgl'] });
  try {
    for (const renderer of ['auto', 'webgl', 'webgpu']) {
      await test(`the ${renderer} setting draws with WebGPU`, async () => {
        const { page, errors } = await open(noWebGL, url(renderer));
        await settled(page, 60000);
        assert.equal(await page.evaluate(() => window.codemap.stage.backend), 'webgpu');
        assert.ok(await litPixels(page) > 400, 'the canvas shows the map');
        assert.deepEqual(errors, []);
        await page.close();
      });
    }
  } finally {
    await noWebGL.close();
  }

  console.log('\nwithout WebGPU and WebGL 2');
  const nothing = await launch({ headed: args.includes('--headed'), args: ['--disable-webgl'] });
  try {
    await test('the page says the map needs WebGPU or WebGL 2', async () => {
      const { page } = await open(nothing, url('auto'));
      await page.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 30000 });
      const text = await page.evaluate(() => document.querySelector('#welcome .welcome-card').innerText);
      assert.match(text, /needs WebGPU or WebGL 2/);
      await page.close();
    });
  } finally {
    await nothing.close();
  }
}

/**
 * The analyzer's own maps: samples/shop-ts (NestJS API, Express gateway, Angular web on a domain library),
 * samples/shop-py (FastAPI, Django, Flask, Celery on a domain library) and samples/ (those and the C# Shop in one map).
 */
async function sampleTests(query) {
  const views = async (app, list) => {
    for (const view of list) {
      await app.page.evaluate((v) => (window.codemap.setLevel('type'), window.codemap.setView(v)), view);
      await app.page.waitForFunction(() => window.codemap.view.units.length && window.codemap.view.settled !== false, null, { timeout: 60000, polling: 100 });
      await app.page.waitForTimeout(300);
      assert.ok(await litPixels(app.page) > 400, `the ${view} view shows the map`);
    }
  };

  const shop = await open(browser, query(fixture(resolve(samples, 'shop-ts.codemap.json'))));
  await test('samples/shop-ts: packages, folders, files; every view draws', async () => {
    await settled(shop.page, 60000);
    const info = await shop.page.evaluate(() => ({
      buttons: [...document.querySelectorAll('#level-toggle [data-level]')].map((b) => b.textContent),
      hud: document.getElementById('hud').textContent,
    }));
    assert.deepEqual(info.buttons, ['Packages', 'Folders', 'Files', 'Declarations', 'Auto']);
    assert.match(info.hud, /\d+ files · \d+ links/);
    await views(shop, ['galaxy', 'city', 'layers', 'di', 'matrix']);
  });

  await test('samples/shop-ts: flows start at Nest handlers and Express routes and reach the implementation', async () => {
    await settled(shop.page, 60000);
    const result = await shop.page.evaluate(() => {
      const app = window.codemap;
      app.setLevel('type');
      app.setView('galaxy');
      const entries = app.getEntryPoints().map((e) => ({ id: e.node.id, methods: e.methods.map((m) => m.id) }));
      const nodesOf = (ids) => {
        app.showFlow(ids);
        return [...(app.flow?.nodes.keys() ?? [])];
      };
      return {
        entries,
        pay: nodesOf(['ts:@shop/api:src/orders/orders.controller.ts#OrdersController.pay']),
        product: nodesOf(['ts:@shop/gateway:src/catalog/catalog.routes.ts#route:GET /:id']),
        label: app.model.get('ts:@shop/gateway:src/catalog/catalog.routes.ts#route:GET /:id').name,
      };
    });
    const api = 'ts:@shop/api:src/';
    assert.ok(result.entries.some((e) => e.id === api + 'orders/orders.controller.ts#OrdersController' && e.methods.includes(api + 'orders/orders.controller.ts#OrdersController.pay')), JSON.stringify(result.entries));
    assert.ok(result.entries.some((e) => e.id === 'ts:@shop/gateway:src/catalog/catalog.routes.ts'), JSON.stringify(result.entries));
    // POST /orders/:id/pay → OrdersService.pay → PaymentsService.charge → PaymentGateway.charge (interface) → FakePaymentGateway.charge
    assert.ok(result.pay.includes(api + 'payments/payments.service.ts#PaymentsService.charge'), `pay: ${result.pay}`);
    assert.ok(result.pay.includes(api + 'payments/payment-gateway.ts#FakePaymentGateway.charge'), `pay: ${result.pay}`);
    // GET /catalog/:id → productById → ApiClient.get, in another file
    assert.ok(result.product.includes('ts:@shop/gateway:src/api-client.ts#ApiClient.get'), `product: ${result.product}`);
    assert.equal(result.label, 'GET /catalog/:id');
  });

  await test('samples/shop-ts: the DI view shows the Angular error, the Nest warning and the request scope notes', async () => {
    await settled(shop.page, 60000);
    const hud = await shop.page.evaluate(() => {
      window.codemap.setLevel('type');
      window.codemap.setView('di');
      return document.getElementById('hud').textContent;
    });
    assert.match(hud, /1 lifetime error\(s\) · 1 warning\(s\) · 4 note\(s\)/);
    assert.deepEqual(shop.errors, []);
  });
  await shop.page.close();

  const python = await open(browser, query(fixture(resolve(samples, 'shop-py.codemap.json'))));
  await test('samples/shop-py: projects, packages, modules; flows from FastAPI routes; the DI view\'s captive dependency', async () => {
    await settled(python.page, 60000);
    const info = await python.page.evaluate(() => {
      const app = window.codemap;
      const buttons = [...document.querySelectorAll('#level-toggle [data-level]')].map((b) => b.textContent);
      app.setLevel('type');
      app.setView('galaxy');
      app.showFlow(['py:shop-api:src/shop_api/routers/payments.py#pay_order']);
      const pay = [...(app.flow?.nodes.keys() ?? [])];
      app.setView('di');
      return { buttons, pay, entries: app.getEntryPoints().map((e) => e.node.id), hud: document.getElementById('hud').textContent };
    });
    assert.deepEqual(info.buttons, ['Projects', 'Packages', 'Modules', 'Declarations', 'Auto']);
    // POST /api/payments/{order_id} → PaymentsService.pay → PaymentGateway.charge (Protocol) → FakePaymentGateway.charge, and Order.pay in the domain library
    assert.ok(info.pay.includes('py:shop-api:src/shop_api/services/payments.py#FakePaymentGateway.charge'), `pay: ${info.pay}`);
    assert.ok(info.pay.includes('py:shop-domain:src/shop_domain/orders.py#Order.pay'), `pay: ${info.pay}`);
    assert.ok(info.entries.includes('py:shop-api:src/shop_api/routers/orders.py'), `entries: ${info.entries}`);
    assert.ok(info.entries.includes('py:backoffice:orders/views.py#OrderDetailView'), `entries: ${info.entries}`);
    assert.match(info.hud, /1 lifetime error\(s\)/);
    await views(python, ['galaxy', 'city', 'layers', 'di', 'flow', 'matrix']);
    assert.deepEqual(python.errors, []);
  });
  await python.page.close();

  const mixed = await open(browser, query(fixture(resolve(samples, 'samples.codemap.json'))));
  await test('samples/: C#, TypeScript and Python in one map, in each language\'s words', async () => {
    await settled(mixed.page, 60000);
    const info = await mixed.page.evaluate(() => {
      const app = window.codemap;
      return {
        buttons: [...document.querySelectorAll('#level-toggle [data-level]')].map((b) => b.textContent),
        languages: [...new Set(app.model.nodes.filter((n) => n.kind === 'project').map((n) => n.language))],
        entries: app.getEntryPoints().map((e) => e.node.id),
      };
    });
    assert.deepEqual(info.buttons, ['Projects / Packages', 'Namespaces / Packages / Folders', 'Types / Modules / Files', 'Members / Declarations', 'Auto']);
    assert.deepEqual(info.languages.sort(), ['csharp', 'python', 'typescript']);
    assert.ok(info.entries.includes('T:Shop.Api.Controllers.OrdersController'), `entries: ${info.entries}`);
    assert.ok(info.entries.includes('ts:@shop/api:src/orders/orders.controller.ts#OrdersController'), `entries: ${info.entries}`);
    assert.ok(info.entries.includes('py:shop-api:src/shop_api/routers/orders.py'), `entries: ${info.entries}`);
    await views(mixed, ['galaxy', 'city', 'layers', 'di', 'flow', 'matrix']);
    assert.deepEqual(mixed.errors, []);
  });
  await mixed.page.close();
}

if (failed) {
  console.log(`\n${failed} smoke test(s) failed.`);
  process.exit(1);
}

console.log('\nSmoke tests passed.');

/**
 * Waits until the stage has drawn every frame it wanted to (none pending, nothing left to redraw): a
 * map that keeps drawing never gets there, and slow software frames do not cut a test short.
 */
async function drained(page, timeout = 60000) {
  // Two display frames first: input handlers that wait for one (hover picking) have run by then.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const stage = window.codemap.stage;
    return !stage.raf && !stage.ambientTimer && !stage.dirty && stage.trailingFrames === 0 && !stage.flight;
  }, null, { timeout, polling: 50 });
}

/** Side by side: lit pixels in each half of the canvas, and how many pixels differ between the halves. */
async function eyeHalves(page) {
  const shot = await page.locator('#stage canvas').screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height);
    const half = Math.floor(width / 2);
    let left = 0;
    let right = 0;
    let differing = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < half; x++) {
        const a = (y * width + x) * 4;
        const b = (y * width + x + half) * 4;
        const la = data[a] + data[a + 1] + data[a + 2];
        const lb = data[b] + data[b + 1] + data[b + 2];
        if (la > 120) left++;
        if (lb > 120) right++;
        if (Math.abs(la - lb) > 90) differing++;
      }
    }

    return { left, right, differing };
  }, shot.toString('base64'));
}

/** Runs in the page before its scripts: counts the shader programs (WebGL) and pipelines (WebGPU) made. */
function countCompiles() {
  window.__compiles = 0;
  const count = (proto, name) => {
    const original = proto?.[name];
    if (!original) return;
    proto[name] = function (...args) {
      window.__compiles++;
      return original.apply(this, args);
    };
  };
  count(window.WebGL2RenderingContext?.prototype, 'linkProgram');
  count(window.GPUDevice?.prototype, 'createRenderPipeline');
  count(window.GPUDevice?.prototype, 'createRenderPipelineAsync');
}

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
