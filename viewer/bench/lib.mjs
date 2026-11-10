// Shared by the benchmark runner and the smoke tests: a static server for the built viewer and the
// test graphs, and a Chromium that can run both renderers (WebGL 2 and WebGPU) without a GPU.
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, writeDoc } from './generate.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const viewerRoot = resolve(here, '..');
export const dist = join(viewerRoot, 'dist');
export const dataDir = join(here, '.data');

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };

/** Serves a build (dist/) at / and bench/.data/ at /data/ on 127.0.0.1 (a secure context, so WebGPU is allowed). */
export async function serve(root = dist) {
  if (!existsSync(join(root, 'index.html'))) throw new Error(`No viewer build in ${root}: run npm run build`);
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const [base, path] = url.pathname.startsWith('/data/') ? [dataDir, url.pathname.slice(6)] : [root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)];
    const file = resolve(base, decodeURIComponent(path));
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A generated graph with this many types (cached in bench/.data). Returns its URL path. */
export async function graph(types, options = {}) {
  mkdirSync(dataDir, { recursive: true });
  const name = `bench-${types}${options.members !== undefined ? `-m${options.members}` : ''}.codemap.json`;
  const file = join(dataDir, name);
  if (!existsSync(file)) await writeDoc(generate({ types, ...options }), file);
  return `/data/${name}`;
}

/** A graph kept in the repository (path relative to its root), copied to bench/.data. Returns its URL path. */
export function fixture(path) {
  mkdirSync(dataDir, { recursive: true });
  const name = path.split('/').pop();
  copyFileSync(resolve(viewerRoot, '..', path), join(dataDir, name));
  return `/data/${name}`;
}

/**
 * Chromium flags: WebGPU on (a software adapter when there is no GPU), WebGL 2 through SwiftShader. Without
 * the Vulkan/ANGLE features, headless Chromium loses the WebGPU device as soon as a canvas presents a frame
 * ("A valid external Instance reference no longer exists").
 */
export const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--use-webgpu-adapter=swiftshader',
  '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-precise-memory-info',
];

/** @param args Chromium's command line; the default gives WebGPU and WebGL 2 on SwiftShader (no GPU needed). */
export async function launch({ headed = false, args = CHROMIUM_ARGS } = {}) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is missing: run npm install in viewer/ (the browser comes from `npx playwright install chromium`).');
  }

  return playwright.chromium.launch({ headless: !headed, args });
}

/** Opens the viewer and collects page errors and console errors; `init` runs in the page before its own scripts. */
export async function open(browser, url, { width = 1280, height = 800, init } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  if (init) await page.addInitScript(init);
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(url);
  return { page, errors };
}

/** Waits until a graph is on screen and its layout has settled (or the view has no layout). */
export async function settled(page, timeout = 180000) {
  await page.waitForFunction(() => {
    const app = window.codemap;
    const view = app?.view;
    if (!view?.units?.length) return false;
    return view.settled !== false; // the city has no layout to wait for
  }, null, { timeout, polling: 100 });
}

export function sizeName(n) {
  return n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n);
}
