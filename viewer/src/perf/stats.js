/**
 * Counters and timings for benchmarks and tests (window.codemap.perf): how many frames ran, how many
 * were actually drawn, how long the steps of a load took, and frame-time samples on demand.
 */
export class PerfStats {
  constructor() {
    this.frames = 0; // animation frames that ran
    this.renders = 0; // frames that drew something
    this.ticks = 0; // layout simulation steps
    this.timings = {}; // name -> ms of the latest run
    this.sampling = null;
  }

  /** Records how long a step took (the latest value wins). */
  time(name, fn) {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.timings[name] = performance.now() - start;
    }
  }

  set(name, ms) {
    this.timings[name] = ms;
  }

  /** Called by the stage for every animation frame: `work` is the CPU time of the frame in ms. */
  frame(now, work, rendered) {
    this.frames++;
    if (rendered) this.renders++;
    const s = this.sampling;
    if (!s) return;
    if (s.last !== null) s.intervals.push(now - s.last);
    s.last = now;
    s.work.push(work);
    if (rendered) s.renders++;
  }

  startSampling() {
    this.sampling = { last: null, intervals: [], work: [], renders: 0, start: performance.now() };
  }

  /** Frame intervals and CPU time per frame since startSampling(). */
  stopSampling() {
    const s = this.sampling;
    this.sampling = null;
    if (!s) return null;
    return {
      ms: performance.now() - s.start,
      frames: s.work.length,
      renders: s.renders,
      interval: summary(s.intervals),
      work: summary(s.work),
    };
  }

  snapshot() {
    return { frames: this.frames, renders: this.renders, ticks: this.ticks, timings: { ...this.timings } };
  }
}

function summary(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean: round(mean), p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1]) };
}

function round(v) {
  return Math.round(v * 100) / 100;
}

export const perf = new PerfStats();
