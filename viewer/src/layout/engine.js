import { MainThreadLayout } from './main-thread.js';
import { WorkerLayout, workerAvailable } from './worker-layout.js';

/** Up to this many nodes the layout runs on the main thread: the synchronous pre-warm lays them out almost completely. */
const MAIN_THREAD_MAX = 300;

const override = new URLSearchParams(globalThis.location?.search ?? '').get('layout');

/**
 * Starts a force layout for a spec where it runs best. Every engine has the same surface:
 * `positions` (x, y, z per node), `step(budgetMs)` → true when positions changed, `settled`, `stop()`, `kind`.
 * The returned object switches to the main thread by itself if the worker fails.
 */
export function startLayout(spec) {
  const kind = override === 'main' || override === 'worker' ? override : spec.count <= MAIN_THREAD_MAX || !workerAvailable() ? 'main' : 'worker';
  if (kind === 'main') return new MainThreadLayout(spec);
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
