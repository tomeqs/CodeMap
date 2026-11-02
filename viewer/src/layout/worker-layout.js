import LayoutWorker from './force.worker.js?worker&inline';
import { specBuffers } from './spec.js';
import { perf } from '../perf/stats.js';

/** One worker for the whole session; null once it turned out not to work here (e.g. a CSP without blob: workers). */
let shared;
let broken = false;
/** The worker answered its first ping: it runs (a big layout may still take a while). */
let alive = false;

function worker() {
  if (broken) return null;
  if (!shared) {
    try {
      shared = new LayoutWorker({ name: 'codemap-layout' });
      shared.addEventListener('error', () => markBroken('the layout worker failed'));
      shared.addEventListener('message', (event) => {
        if (event.data?.type === 'pong') alive = true;
      });
      shared.postMessage({ type: 'ping' });
    } catch (error) {
      markBroken(error?.message ?? 'workers are not allowed here');
    }
  }

  return shared;
}

function markBroken(reason) {
  if (broken) return;
  broken = true;
  console.warn(`CodeMap: layout on the main thread (${reason}).`);
  try {
    shared?.terminate();
  } catch {
    // already gone
  }

  shared = null;
}

export function workerAvailable() {
  return !broken && typeof Worker === 'function';
}

/** Starts the worker ahead of the first layout and resolves to where layouts will run: 'worker' or 'main'. */
export function checkWorker(timeout = 4000) {
  const w = worker();
  if (!w) return Promise.resolve('main');
  return new Promise((resolve) => {
    const done = () => {
      clearInterval(poll);
      resolve(alive && !broken ? 'worker' : 'main');
    };
    const start = performance.now();
    const poll = setInterval(() => {
      if (alive || broken) done();
      else if (performance.now() - start > timeout) {
        markBroken('the layout worker did not start');
        done();
      }
    }, 20);
  });
}

let nextId = 1;

/**
 * The force layout in a Web Worker. step() picks up the newest positions the worker sent; the worker
 * keeps computing at full speed in the meantime. If the worker cannot start (or never answers its ping),
 * `failed` is set and the caller switches to the main thread.
 */
export class WorkerLayout {
  constructor(spec, { answerTimeout = 4000 } = {}) {
    this.kind = 'worker';
    this.id = nextId++;
    this.count = spec.count;
    this.positions = spec.position.slice(); // until the first frame arrives: where the layout starts
    this.settled = false;
    this.failed = false;
    this.alpha = spec.config.alpha;
    this.ticks = 0;
    this.latest = null;
    this.received = false;
    this.started = performance.now();
    const w = worker();
    if (!w) {
      this.failed = true;
      return;
    }

    this.worker = w;
    this.onMessage = (event) => this.receive(event.data);
    w.addEventListener('message', this.onMessage);
    // The spec is copied for the worker (positions stay usable here); its arrays are transferred, not cloned.
    const copy = { ...spec, config: { ...spec.config } };
    for (const [key, value] of Object.entries(copy)) if (ArrayBuffer.isView(value)) copy[key] = value.slice();
    w.postMessage({ type: 'start', id: this.id, spec: copy }, specBuffers(copy));
    this.timeout = setTimeout(() => {
      if (!alive && !this.received) {
        markBroken('the layout worker did not start');
        this.failed = true;
      }
    }, answerTimeout);
  }

  receive(message) {
    if (message.id !== this.id || message.type !== 'positions') return;
    if (!this.received) perf.set('prewarm', performance.now() - this.started);
    this.received = true;
    // Keep only the newest frame; an older one goes straight back to the worker.
    if (this.latest) this.release(this.latest.positions);
    this.latest = message;
  }

  release(buffer) {
    this.worker?.postMessage({ type: 'buffer', id: this.id, buffer }, [buffer.buffer]);
  }

  /** Takes the newest positions from the worker; returns true when there are new ones to show. */
  step() {
    const message = this.latest;
    if (!message) return false;
    this.latest = null;
    this.positions.set(message.positions);
    perf.ticks += message.ticks - this.ticks;
    this.ticks = message.ticks;
    this.alpha = message.alpha;
    this.release(message.positions);
    if (message.settled) this.finish();
    return true;
  }

  finish() {
    this.settled = true;
    clearTimeout(this.timeout);
    this.worker?.removeEventListener('message', this.onMessage);
  }

  stop() {
    if (!this.settled) this.worker?.postMessage({ type: 'stop', id: this.id });
    this.finish();
  }
}
