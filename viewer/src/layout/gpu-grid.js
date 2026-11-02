import { StorageBufferAttribute } from 'three/webgpu';
import {
  abs,
  atomicAdd,
  atomicLoad,
  atomicStore,
  clamp,
  dot,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  ivec3,
  Loop,
  max,
  min,
  select,
  sqrt,
  storage,
  uint,
  vec3,
  vec4,
} from 'three/tsl';

const WG = 64;
/** Threads that find the bounding box (partial minima and maxima, then one thread). */
const BOUND_THREADS = 256;
/** Threads of the prefix sum over the cell counts (each one a run of cells). */
const SCAN_THREADS = 1024;

/**
 * The grid for n nodes: cells per axis (about two nodes per cell in a round layout; a power of two, so
 * each coarser level halves it), the cells of the finest level, and where each level starts among all.
 * Levels stop at 4 cells per axis: a coarser one has no far cells for anyone.
 */
export function gridPlan(n) {
  const side = Math.min(64, Math.max(4, 2 ** Math.ceil(Math.log2(Math.cbrt(Math.max(1, n) / 2)))));
  const offsets = [];
  let total = 0;
  for (let size = side; size >= 4; size >>= 1) {
    offsets.push(total);
    total += size * size * size;
  }

  return { side, cells: side * side * side, offsets, total };
}

/**
 * The many-body force on a grid, for layouts too big for the exact force (every pair is nodes² per tick).
 *
 * Every tick the nodes are sorted into the cells of a cube around them (count with atomics, prefix sum,
 * scatter), each cell gets its total charge and centre of charge, and coarser levels (2³ cells each) sum
 * those up. A node then feels the nodes of its own and the 26 neighbouring cells one by one, and farther
 * nodes through cells: at each level, the cells next to its parent's neighbourhood that are not its own
 * neighbours (the classic interaction list). Far cells are at least one cell width away, so the error is
 * that of Barnes–Hut with θ ≈ 1 (d3 uses 0.9). As in d3, a cell counts only when its centre is closer
 * than distanceMax, and levels with cells wider than distanceMax are skipped (all their nodes are too far).
 *
 * The force kernel takes the nodes in cell order (`nodeAt`): neighbouring threads read the same cells.
 */
export class ChargeGrid {
  /**
   * `index`: room for cells + 1 + padded uints (cell starts, nodes in cell order, which the padding threads
   * find as themselves); `scratch`: room for 1 + plan.total vec4 (the grid's origin and cell width, the
   * cells). Both are slices of buffers the layout shares, see gpu-force.js.
   */
  constructor({ plan, count, padded, pos, nodeA, index, scratch, distanceMax, jiggle }) {
    const n = count;
    const N = uint(n);
    const { side: G, cells, offsets } = plan;
    const levels = offsets.length;
    this.side = G;

    const uints = (length) => storage(new StorageBufferAttribute(new Uint32Array(Math.max(1, length)), 1), 'uint', Math.max(1, length));
    const vec4s = (length) => storage(new StorageBufferAttribute(new Float32Array(Math.max(1, length) * 4), 4), 'vec4', Math.max(1, length));

    const boundMin = vec4s(BOUND_THREADS);
    const boundMax = vec4s(BOUND_THREADS);
    const params = { element: () => scratch.element(0) }; // grid origin xyz, cell width
    const cellCount = uints(cells).toAtomic();
    const nodeCell = uints(padded);
    const nodeSlot = uints(padded);
    const chunks = Math.min(SCAN_THREADS, cells);
    const chunk = cells / chunks;
    const chunkStart = uints(chunks);
    const cellStart = index;
    const sorted = { element: (k) => index.element(uint(k).add(cells + 1)) }; // node by cell order
    const sortedPos = vec4s(n); // position, charge, in cell order
    const cell = { element: (k) => scratch.element(uint(k).add(1)) }; // centre of charge, total charge; all levels in a row

    const cellOf = (p) => {
      const g = params.element(0);
      return ivec3(clamp(floor(p.sub(g.xyz).div(g.w)), vec3(0), vec3(G - 1)));
    };
    const indexOf = (c, size = G, offset = 0) => uint(c.x.add(c.y.mul(size)).add(c.z.mul(size * size)).add(offset));

    // 1. Bounding box: partial minima and maxima, then the grid's origin and cell width.
    const boundsPartial = Fn(() => {
      const t = instanceIndex;
      const lo = vec3(1e30).toVar();
      const hi = vec3(-1e30).toVar();
      Loop({ start: t, end: N, type: 'uint', condition: '<', update: BOUND_THREADS, name: 'm' }, ({ m: i }) => {
        const p = pos.element(i).xyz;
        lo.assign(min(lo, p));
        hi.assign(max(hi, p));
      });
      boundMin.element(t).assign(vec4(lo, 0));
      boundMax.element(t).assign(vec4(hi, 0));
    })().compute(BOUND_THREADS, [WG]);
    const bounds = Fn(() => {
      const lo = vec3(1e30).toVar();
      const hi = vec3(-1e30).toVar();
      Loop({ start: uint(0), end: uint(BOUND_THREADS), type: 'uint', condition: '<', name: 'm' }, ({ m: t }) => {
        lo.assign(min(lo, boundMin.element(t).xyz));
        hi.assign(max(hi, boundMax.element(t).xyz));
      });
      const extent = hi.sub(lo);
      // A hair wider than the box: the far side stays inside the last cell.
      const width = max(max(extent.x, extent.y), extent.z).mul(1.001 / G);
      params.element(0).assign(vec4(lo, max(width, 1e-3)));
    })().compute(1, [1]);

    // 2. Count the nodes per cell; each node keeps its cell and its slot in it.
    const countKernel = Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(N), () => {
        const c = indexOf(cellOf(pos.element(i).xyz)).toVar();
        nodeCell.element(i).assign(c);
        nodeSlot.element(i).assign(atomicAdd(cellCount.element(c), uint(1)));
      });
    })().compute(padded, [WG]);

    // 3. Prefix sum of the counts → where each cell's nodes start: runs of cells, the runs' starts, the cells.
    const scanRuns = Fn(() => {
      const t = instanceIndex;
      const sum = uint(0).toVar();
      Loop({ start: t.mul(chunk), end: t.add(1).mul(chunk), type: 'uint', condition: '<', name: 'k' }, ({ k }) => {
        sum.addAssign(atomicLoad(cellCount.element(k)));
      });
      chunkStart.element(t).assign(sum);
    })().compute(chunks, [Math.min(WG, chunks)]);
    const scanStarts = Fn(() => {
      const running = uint(0).toVar();
      Loop({ start: uint(0), end: uint(chunks), type: 'uint', condition: '<', name: 'k' }, ({ k }) => {
        const sum = chunkStart.element(k).toVar();
        chunkStart.element(k).assign(running);
        running.addAssign(sum);
      });
      cellStart.element(uint(cells)).assign(running);
    })().compute(1, [1]);
    // Also empties the counts for the next tick.
    const scanCells = Fn(() => {
      const t = instanceIndex;
      const running = chunkStart.element(t).toVar();
      Loop({ start: t.mul(chunk), end: t.add(1).mul(chunk), type: 'uint', condition: '<', name: 'k' }, ({ k }) => {
        cellStart.element(k).assign(running);
        running.addAssign(atomicLoad(cellCount.element(k)));
        atomicStore(cellCount.element(k), uint(0));
      });
    })().compute(chunks, [Math.min(WG, chunks)]);

    // 4. The nodes in cell order, with their positions and charges.
    const scatter = Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(N), () => {
        const k = cellStart.element(nodeCell.element(i)).add(nodeSlot.element(i));
        sorted.element(k).assign(i);
        sortedPos.element(k).assign(vec4(pos.element(i).xyz, nodeA.element(i).x));
      });
    })().compute(padded, [WG]);

    // 5. Every cell's centre of charge (weighted by |charge|) and total charge; then the coarser levels.
    const leaves = Fn(() => {
      const c = instanceIndex;
      If(c.lessThan(uint(cells)), () => {
        const sum = vec4(0).toVar();
        const charge = float(0).toVar();
        Loop({ start: cellStart.element(c), end: cellStart.element(c.add(1)), type: 'uint', condition: '<', name: 'k' }, ({ k }) => {
          const node = sortedPos.element(k);
          const weight = abs(node.w);
          sum.addAssign(vec4(node.xyz.mul(weight), weight));
          charge.addAssign(node.w);
        });
        cell.element(c).assign(vec4(sum.xyz.div(max(sum.w, 1e-12)), charge));
      });
    })().compute(cells, [WG]);
    const merges = [];
    for (let level = 1; level < levels; level++) {
      const size = G >> level;
      const below = offsets[level - 1];
      const offset = offsets[level];
      merges.push(
        Fn(() => {
          const c = instanceIndex;
          If(c.lessThan(uint(size * size * size)), () => {
            const x = int(c.mod(size));
            const y = int(c.div(size).mod(size));
            const z = int(c.div(size * size));
            const sum = vec4(0).toVar();
            const charge = float(0).toVar();
            for (let child = 0; child < 8; child++) {
              const at = ivec3(x.mul(2).add(child & 1), y.mul(2).add((child >> 1) & 1), z.mul(2).add(child >> 2));
              const part = cell.element(indexOf(at, size * 2, below));
              const weight = abs(part.w);
              sum.addAssign(vec4(part.xyz.mul(weight), weight));
              charge.addAssign(part.w);
            }
            cell.element(uint(offset).add(c)).assign(vec4(sum.xyz.div(max(sum.w, 1e-12)), charge));
          });
        })().compute(size * size * size, [WG]),
      );
    }

    this.kernels = [boundsPartial, bounds, countKernel, scanRuns, scanStarts, scanCells, scatter, leaves, ...merges];
    this.buffers = [boundMin, boundMax, cellCount, nodeCell, nodeSlot, chunkStart, sortedPos];

    const distanceMax2 = distanceMax * distanceMax;

    /** Shader: the node this force thread works on (cell order). */
    this.nodeAt = (t) => sorted.element(t);

    /**
     * Shader: adds the many-body force on node `i` (at `p`, thread `t` in cell order) to `dv`. Call it for
     * real nodes only (t < count).
     */
    this.apply = (t, i, p, dv, alpha) => {
      const push = (d, l, charge) => {
        // d3: below distanceMin (1) the force stops growing.
        const lAdjusted = select(l.lessThan(1), sqrt(l), l);
        dv.addAssign(d.mul(charge.mul(alpha).div(lAdjusted)));
      };

      const g = params.element(0);
      const c = cellOf(p).toVar();

      // Near: the nodes of the 27 cells around, one by one.
      Loop({ start: max(c.z.sub(1), 0), end: min(c.z.add(2), G), type: 'int', condition: '<', name: 'nz' }, ({ nz }) => {
        Loop({ start: max(c.y.sub(1), 0), end: min(c.y.add(2), G), type: 'int', condition: '<', name: 'ny' }, ({ ny }) => {
          Loop({ start: max(c.x.sub(1), 0), end: min(c.x.add(2), G), type: 'int', condition: '<', name: 'nx' }, ({ nx }) => {
            const at = indexOf(ivec3(nx, ny, nz)).toVar();
            Loop({ start: cellStart.element(at), end: cellStart.element(at.add(1)), type: 'uint', condition: '<', name: 'k' }, ({ k }) => {
              const other = sortedPos.element(k);
              const d = other.xyz.sub(p).toVar();
              const l = dot(d, d).toVar();
              If(other.w.notEqual(0).and(k.notEqual(t)).and(l.lessThan(distanceMax2)), () => {
                If(l.lessThan(1e-12), () => {
                  d.assign(jiggle(i, sorted.element(k)));
                  l.assign(dot(d, d));
                });
                push(d, l, other.w);
              });
            });
          });
        });
      });

      // Far: per level, the children of the parent's neighbours that are not neighbours themselves.
      for (let level = 0; level < levels; level++) {
        const size = G >> level;
        const offset = offsets[level];
        If(g.w.mul(1 << level).lessThan(distanceMax), () => {
          const own = c.shiftRight(ivec3(level)).toVar();
          const first = own.shiftRight(ivec3(1)).mul(2).sub(2).toVar();
          Loop({ start: max(first.z, 0), end: min(first.z.add(6), size), type: 'int', condition: '<', name: `fz${level}` }, ({ [`fz${level}`]: fz }) => {
            Loop({ start: max(first.y, 0), end: min(first.y.add(6), size), type: 'int', condition: '<', name: `fy${level}` }, ({ [`fy${level}`]: fy }) => {
              Loop({ start: max(first.x, 0), end: min(first.x.add(6), size), type: 'int', condition: '<', name: `fx${level}` }, ({ [`fx${level}`]: fx }) => {
                const near = abs(fx.sub(own.x)).lessThanEqual(1).and(abs(fy.sub(own.y)).lessThanEqual(1)).and(abs(fz.sub(own.z)).lessThanEqual(1));
                If(near.not(), () => {
                  const far = cell.element(indexOf(ivec3(fx, fy, fz), size, offset));
                  const d = far.xyz.sub(p).toVar();
                  const l = dot(d, d);
                  If(far.w.notEqual(0).and(l.lessThan(distanceMax2)), () => {
                    push(d, l, far.w);
                  });
                });
              });
            });
          });
        });
      }
    };
  }
}
