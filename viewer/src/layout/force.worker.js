// The force layout in a Web Worker: the main thread stays free for drawing and input. Runs ticks in
// slices and sends positions back (in buffers the main thread hands back, so nothing is allocated per frame).
import { createSimulation, readPositions } from './d3-forces.js';

const SLICE_MS = 12;
const PREWARM_MS = 120;

let run = null;

self.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'ping':
      self.postMessage({ type: 'pong' });
      break;
    case 'start':
      run = { id: message.id, sim: createSimulation(message.spec), count: message.spec.count, buffers: [], ticks: 0, inFlight: 0, settled: false };
      prewarm(run);
      schedule();
      break;
    case 'buffer':
      // The main thread has shown a frame and hands its buffer back: send the newest positions, if any.
      if (!run || message.id !== run.id) break;
      if (message.buffer?.length === run.count * 3) run.buffers.push(message.buffer);
      run.inFlight--;
      flush(run);
      break;
    case 'stop':
      if (run && message.id === run.id) run = null;
      break;
  }
};

function prewarm(r) {
  const start = performance.now();
  while (performance.now() - start < PREWARM_MS && r.sim.alpha() > 0.2) tick(r);
  send(r);
}

function tick(r) {
  r.sim.tick();
  r.ticks++;
}

/** Sends the current positions (in a returned buffer when there is one). */
function send(r) {
  const positions = r.buffers.pop() ?? new Float32Array(r.count * 3);
  readPositions(r.sim, positions);
  r.settled = r.sim.alpha() <= r.sim.alphaMin();
  r.inFlight++;
  self.postMessage({ type: 'positions', id: r.id, positions, alpha: r.sim.alpha(), ticks: r.ticks, settled: r.settled }, [positions.buffer]);
}

// Yield between slices with a message channel (setTimeout would be clamped to 4 ms). The layout runs at
// full speed, whatever the frame rate; only the sending waits for the main thread.
const channel = new MessageChannel();
let scheduled = false;
channel.port1.onmessage = () => {
  scheduled = false;
  const r = run;
  if (!r || r.settled) return;
  const start = performance.now();
  do tick(r);
  while (performance.now() - start < SLICE_MS && r.sim.alpha() > r.sim.alphaMin());
  r.dirty = true;
  flush(r);
  schedule();
};

/** At most two frames of positions on their way: a slow main thread is not flooded (the last one always goes). */
function flush(r) {
  if (r.dirty && (r.inFlight < 2 || r.sim.alpha() <= r.sim.alphaMin())) {
    r.dirty = false;
    send(r);
  }
}

function schedule() {
  const r = run;
  if (!r || r.settled || scheduled || r.sim.alpha() <= r.sim.alphaMin()) return;
  scheduled = true;
  channel.port2.postMessage(null);
}
