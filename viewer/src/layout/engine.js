import { MainThreadLayout } from './main-thread.js';
import { WorkerLayout, workerAvailable } from './worker-layout.js';
import { GpuLayout } from './gpu-force.js';

/** Up to this many nodes the layout runs on the main thread: the synchronous pre-warm lays them out almost completely. */
const MAIN_THREAD_MAX = 300;

const override = new URLSearchParams(globalThis.location?.search ?? '').get('layout');

/** The GPU layout failed once (shader or device trouble): the worker takes over for the rest of the session. */
let gpuBroken = false;

/** Where layouts of this size run on this machine: 'gpu', 'worker' or 'main'. */
export function layoutKind(count, gpu = {}) {
  const gpuReady = gpu.backend === 'webgpu' && !gpuBroken && !!gpu.renderer;
  if (override === 'gpu' && gpuReady) return 'gpu';
  if (override === 'main' || override === 'worker') return override;
  if (count <= MAIN_THREAD_MAX) return 'main';
  // A software WebGPU adapter (no GPU) computes slower than the worker.
  if (gpuReady && !gpu.software) return 'gpu';
  return workerAvailable() ? 'worker' : 'main';
}

/**
 * Starts a force layout for a spec where it runs best: compute shaders on WebGPU, a worker, or the main
 * thread for small graphs. Every engine has the same surface: `positions` (x, y, z per node, on the CPU),
 * `step(budgetMs)` → true when positions changed, `settled`, `stop()`, `kind`; `writesStore` when it draws
 * straight into the position store. `gpu`: { renderer, store, backend, software } of the stage.
 */
export function startLayout(spec, gpu = {}) {
  const kind = layoutKind(spec.count, gpu);
  if (kind === 'gpu') {
    try {
      return new GpuLayout(spec, gpu);
    } catch (error) {
      gpuBroken = true;
      console.warn('CodeMap: the GPU layout failed, using the worker.', error);
    }
  }

  if (kind === 'main' || !workerAvailable()) return new MainThreadLayout(spec);
  return new FallbackLayout(spec);
}

/** A worker layout that falls back to the main thread when the worker cannot start or does not answer. */
class FallbackLayout {
  constructor(spec) {
    this.spec = spec;
    this.engine = new WorkerLayout(spec);
    if (this.engine.failed) this.engine = new MainThreadLayout(spec);
  }

  get kind() {
    return this.engine.kind;
  }

  get positions() {
    return this.engine.positions;
  }

  get settled() {
    return this.engine.settled;
  }

  get alpha() {
    return this.engine.alpha;
  }

  step(budgetMs) {
    if (this.engine.failed) {
      this.engine.stop();
      this.engine = new MainThreadLayout(this.spec, { prewarmMs: 0 });
    }

    return this.engine.step(budgetMs);
  }

  stop() {
    this.engine.stop();
  }
}
