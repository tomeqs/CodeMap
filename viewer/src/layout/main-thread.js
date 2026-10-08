import { createSimulation, readPositions } from './d3-forces.js';
import { perf } from '../perf/stats.js';

/**
 * The force layout on the main thread, a few milliseconds per frame. Small graphs use it (a synchronous
 * pre-warm puts them in shape before the first frame), and it is the fallback when workers are blocked.
 */
export class MainThreadLayout {
  constructor(spec, { prewarmMs = 120 } = {}) {
    this.kind = 'main';
    this.spec = spec;
    this.sim = createSimulation(spec);
    this.positions = new Float32Array(spec.count * 3);
    this.settled = false;
    this.ticks = 0;
    this.changed = false;
    // Pre-warm: lay out most of the structure before the first frame, then animate the rest.
    const start = performance.now();
    while (performance.now() - start < prewarmMs && this.sim.alpha() > 0.2) this.tick();
    perf.set('prewarm', performance.now() - start);
    this.publish();
  }

  get alpha() {
    return this.sim.alpha();
  }

  tick() {
    this.sim.tick();
    this.ticks++;
    perf.ticks++;
  }

  publish() {
    readPositions(this.sim, this.positions);
    this.settled = this.sim.alpha() <= this.sim.alphaMin();
    this.changed = true;
  }

  /** Runs ticks for up to `budgetMs`; returns true when there are new positions to show. */
  step(budgetMs = 9) {
    if (!this.settled) {
      const start = performance.now();
      do this.tick();
      while (performance.now() - start < budgetMs && this.sim.alpha() > this.sim.alphaMin());
      this.publish();
    }

    const changed = this.changed;
    this.changed = false;
    return changed;
  }

  stop() {
    this.settled = true;
  }
}
