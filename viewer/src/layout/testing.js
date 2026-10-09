// Layout engines for the benchmark and smoke tests (loaded with ?bench=1 only).
export { MainThreadLayout } from './main-thread.js';
export { WorkerLayout } from './worker-layout.js';
export { startLayout } from './engine.js';
export { GpuLayout } from './gpu-force.js';
export { PositionStore } from '../gpu/position-store.js';

/** Shape of a layout, to compare engines: link lengths against their targets, spread, how tight groups are. */
export function layoutMetrics(spec, positions) {
  const n = spec.count;
  const p = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let ratio = 0;
  for (let k = 0; k < spec.linkSource.length; k++) ratio += dist(p(spec.linkSource[k]), p(spec.linkTarget[k])) / spec.linkDistance[k];
  ratio /= Math.max(1, spec.linkSource.length);
  const center = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) center[d] += positions[i * 3 + d] / n;
  let spread = 0;
  for (let i = 0; i < n; i++) spread += dist(p(i), center) / n;
  const sums = new Map();
  for (let i = 0; i < n; i++) {
    const g = spec.group[i];
    if (g < 0) continue;
    const s = sums.get(g) ?? [0, 0, 0, 0];
    for (let d = 0; d < 3; d++) s[d] += positions[i * 3 + d];
    s[3]++;
    sums.set(g, s);
  }

  let inGroup = 0;
  let grouped = 0;
  for (let i = 0; i < n; i++) {
    const s = sums.get(spec.group[i]);
    if (!s) continue;
    inGroup += dist(p(i), [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
    grouped++;
  }

  const finite = Array.from(positions).every(Number.isFinite);
  return { linkStretch: ratio, spread, groupTightness: grouped ? inGroup / grouped / spread : 0, finite };
}
