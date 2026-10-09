import { FloatType, StorageBufferAttribute, StorageTexture } from 'three/webgpu';
import {
  dot,
  float,
  Fn,
  hash,
  If,
  instanceIndex,
  int,
  ivec2,
  length,
  localId,
  Loop,
  max,
  select,
  sqrt,
  storage,
  textureStore,
  uint,
  uniform,
  vec3,
  vec4,
  workgroupArray,
  workgroupBarrier,
} from 'three/tsl';
import { perf } from '../perf/stats.js';
import { ChargeGrid, gridPlan } from './gpu-grid.js';

/** Threads per workgroup; also the tile of nodes each workgroup shares for the many-body force. */
const WG = 64;
/** Threads that add up partial sums of all positions (for the centring force). */
const PARTIALS = 256;
/** Width of the position store texture (see gpu/position-store.js). */
const STORE_WIDTH = 1024;
/**
 * The many-body force here is exact (or, on the grid, as good as exact: measured within 1%); d3's
 * Barnes–Hut approximation (θ = 0.9) pushes far nodes less, and the views were tuned with it. Weaker
 * charges keep the GPU layout as compact (measured: spread within ~10%).
 */
const CHARGE_MATCH = 0.72;
/** From this many nodes the many-body force runs on a grid instead of every pair; `?layoutMode=grid|exact` forces either. */
const GRID_FROM = 12000;

const modeOverride = new URLSearchParams(globalThis.location?.search ?? '').get('layoutMode');

/** 'grid' or 'exact': how the many-body force of a layout with `count` nodes is computed. */
export function chargeMode(count) {
  if (modeOverride === 'grid' || modeOverride === 'exact') return modeOverride;
  return count >= GRID_FROM ? 'grid' : 'exact';
}

/**
 * The force layout as WebGPU compute shaders: the same forces as the d3 layout (layout/d3-forces.js) on the
 * same LayoutSpec, every node in parallel.
 *
 * One tick:
 *   1. groups:  the radius-weighted centroid of every group (one thread per group)
 *   2. centre:  the mean position (partial sums, then one thread), when the spec centres the layout
 *   3. forces:  per node, links along its adjacency list (predicted positions, like d3) and the many-body
 *               force against every other node, in tiles shared through workgroup memory; anchors; groups.
 *               Big layouts (`chargeMode`) take the many-body force from a grid instead (gpu-grid.js),
 *               which sorts the nodes into cells first: near nodes one by one, far ones by cell.
 *   4. move:    velocity decay, the centring shift, fixed heights; writes the position store texture
 *
 * Links are applied Jacobi-style (all from the start of the tick) where d3 goes link by link, and the
 * many-body force is exact where d3 approximates far nodes (Barnes–Hut): with the same exact force the
 * two give the same layout (measured), with d3's approximation it looks the same, not bit for bit. Alpha (the cooling) is computed here, as in d3, so settling needs no readback; positions
 * come back to the CPU (labels, picking, camera) every few frames and once at the end.
 */
export class GpuLayout {
  constructor(spec, { renderer, store, mode }) {
    this.kind = 'gpu';
    this.spec = spec;
    this.renderer = renderer;
    this.store = store;
    this.writesStore = true; // the positions on screen come straight from the compute shaders
    const n = spec.count;
    this.count = n;
    this.config = spec.config;
    this.alpha = spec.config.alpha;
    this.ticks = 0;
    this.settled = false;
    this.positions = spec.position.slice();
    this.fresh = true;
    this.readback = null;
    this.lastReadback = 0;
    this.mode = mode ?? chargeMode(n);
    store.ensure(n);
    this.build();
    this.ticksPerFrame = Math.max(1, Math.min(12, Math.floor(3e8 / this.cost)));
    // The store shows what the shaders write from now on.
    store.useTexture(this.texture);
    this.renderer.compute(this.publish);
    // Pre-warm on the GPU: the first frame already shows the shape coming out of the starting cloud.
    const ticks = this.ticksPerFrame;
    this.ticksPerFrame = Math.min(60, ticks * 4);
    this.step();
    this.ticksPerFrame = ticks;
    this.lastFrame = 0;
  }

  build() {
    const spec = this.spec;
    const n = spec.count;
    const padded = Math.ceil(n / WG) * WG;
    this.padded = padded;
    const grid = this.mode === 'grid';
    // Rough work per tick: every pair, or the near cells' nodes and the far cells per node.
    this.cost = grid ? Math.max(1, n) * 1000 : Math.max(1, padded * padded);
    const vec4s = (fill, length = padded) => {
      const array = new Float32Array(length * 4);
      fill?.(array);
      return storage(new StorageBufferAttribute(array, 4), 'vec4', length);
    };
    // A shader stage may bind only 8 storage buffers (WebGPU's default limit), so related arrays share one:
    // `node` holds two vec4 per node, `index` the link and grid lists, `scratch` centroids and grid cells.
    const slice = (buffer, offset, stride = 1) => ({
      element: (i) => {
        const k = stride === 1 ? uint(i) : uint(i).mul(stride);
        return buffer.element(offset ? k.add(offset) : k);
      },
    });
    const plan = grid ? gridPlan(n) : null;

    // Positions and velocities; padding nodes sit at the origin with no charge (they push nothing).
    this.pos = vec4s((a) => {
      for (let i = 0; i < n; i++) a.set([spec.position[i * 3], spec.position[i * 3 + 1], spec.position[i * 3 + 2], 1], i * 4);
    });
    this.vel = vec4s();
    this.velNext = vec4s();
    // Per node: (charge, anchor x, y, z) and (fixed y, fixed?, group, radius).
    const node = vec4s((a) => {
      for (let i = 0; i < n; i++) {
        const fixed = !Number.isNaN(spec.fixedY[i]);
        a.set([spec.charge[i] * CHARGE_MATCH, spec.anchor[i * 3], spec.anchor[i * 3 + 1], spec.anchor[i * 3 + 2]], i * 8);
        a.set([fixed ? spec.fixedY[i] : 0, fixed ? 1 : 0, spec.group[i], spec.radius[i]], i * 8 + 4);
      }
    }, padded * 2);
    const nodeA = slice(node, 0, 2);
    const nodeB = slice(node, 1, 2);

    // Links as adjacency lists (CSR): for node i, entries start[i]..start[i+1] are (other node, distance,
    // strength × its share of the pull, 0). In d3 the target moves by `bias`, the source by 1 - bias.
    const links = spec.linkSource.length;
    const count = new Int32Array(n);
    for (let k = 0; k < links; k++) {
      count[spec.linkSource[k]]++;
      count[spec.linkTarget[k]]++;
    }

    // The index buffer: link list starts (n + 1), then the grid's cell starts (cells + 1) and nodes in cell order.
    const start = new Uint32Array(n + 1 + (plan ? plan.cells + 1 + padded : 0));
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + count[i];
    if (plan) for (let k = 0; k < padded; k++) start[n + plan.cells + 2 + k] = k; // until the first sort
    const fill = start.slice(0, n);
    const adjacency = new Float32Array(Math.max(1, links * 2) * 4);
    for (let k = 0; k < links; k++) {
      const s = spec.linkSource[k];
      const t = spec.linkTarget[k];
      const bias = count[s] / (count[s] + count[t]);
      const strength = spec.linkStrength[k];
      adjacency.set([t, spec.linkDistance[k], strength * (1 - bias), 0], fill[s]++ * 4);
      adjacency.set([s, spec.linkDistance[k], strength * bias, 0], fill[t]++ * 4);
    }

    const index = storage(new StorageBufferAttribute(start, 1), 'uint', start.length);
    if (!plan) index.toReadOnly();
    const adjStart = index;
    const adj = storage(new StorageBufferAttribute(adjacency, 4), 'vec4', Math.max(1, links * 2)).toReadOnly();

    // Groups: members listed group by group, and a centroid (sum of r·position, sum of r) per group.
    const groups = Math.max(1, spec.groupCount);
    const groupCount = new Uint32Array(groups + 1);
    for (let i = 0; i < n; i++) if (spec.group[i] >= 0) groupCount[spec.group[i] + 1]++;
    for (let g = 0; g < groups; g++) groupCount[g + 1] += groupCount[g];
    const order = new Uint32Array(Math.max(1, n));
    const cursor = groupCount.slice(0, groups);
    for (let i = 0; i < n; i++) if (spec.group[i] >= 0) order[cursor[spec.group[i]]++] = i;
    const groupStart = storage(new StorageBufferAttribute(groupCount, 1), 'uint', groups + 1).toReadOnly();
    const groupOrder = storage(new StorageBufferAttribute(order, 1), 'uint', Math.max(1, n)).toReadOnly();
    // Scratch: the group centroids, then the grid's parameters and cells.
    const scratch = vec4s(null, groups + (plan ? 1 + plan.total : 0));
    const centroid = scratch;
    const partial = storage(new StorageBufferAttribute(new Float32Array(PARTIALS * 4), 4), 'vec4', PARTIALS);
    const mean = storage(new StorageBufferAttribute(new Float32Array(4), 4), 'vec4', 1);

    const config = spec.config;
    this.uAlpha = uniform(this.alpha);
    const alpha = this.uAlpha;
    const keep = float(1 - config.velocityDecay);
    const anchorStrength = vec3(...config.anchorStrength);
    const clusterStrength = float(config.clusterStrength);
    const distanceMax2 = float(config.distanceMax * config.distanceMax);
    const distanceMin2 = float(1);
    const N = uint(n);
    const pos = this.pos;
    this.grid = grid
      ? new ChargeGrid({
          plan,
          count: n,
          padded,
          pos,
          nodeA,
          index: slice(index, n + 1),
          scratch: slice(scratch, groups),
          distanceMax: config.distanceMax,
          jiggle,
        })
      : null;
    const vel = this.vel;
    const velNext = this.velNext;

    this.texture = new StorageTexture(STORE_WIDTH, this.store.rows);
    this.texture.type = FloatType;
    const texture = this.texture;
    const storeAt = (i) => ivec2(int(i).mod(STORE_WIDTH), int(i).div(STORE_WIDTH));

    // 1. Group centroids.
    this.groupKernel = Fn(() => {
      const g = instanceIndex;
      If(g.lessThan(uint(groups)), () => {
        const sum = vec4(0).toVar();
        Loop({ start: groupStart.element(g), end: groupStart.element(g.add(1)), type: 'uint', condition: '<', name: 'm' }, ({ m: i }) => {
          const k = groupOrder.element(i);
          const r = nodeB.element(k).w;
          sum.addAssign(vec4(pos.element(k).xyz.mul(r), r));
        });
        centroid.element(g).assign(sum);
      });
    })().compute(groups, [WG]);

    // 2. Mean position: partial sums, then their sum.
    this.partialKernel = Fn(() => {
      const t = instanceIndex;
      const sum = vec4(0).toVar();
      Loop({ start: t, end: N, type: 'uint', condition: '<', update: PARTIALS, name: 'm' }, ({ m: i }) => {
        sum.addAssign(vec4(pos.element(i).xyz, 1));
      });
      partial.element(t).assign(sum);
    })().compute(PARTIALS, [WG]);
    this.meanKernel = Fn(() => {
      const sum = vec4(0).toVar();
      Loop({ start: uint(0), end: uint(PARTIALS), type: 'uint', condition: '<', name: 'm' }, ({ m: i }) => {
        sum.addAssign(partial.element(i));
      });
      mean.element(0).assign(vec4(sum.xyz.div(max(sum.w, 1)), 0));
    })().compute(1, [1]);

    // 3. Forces → next velocity.
    const tile = workgroupArray('vec4', WG);
    this.forceKernel = Fn(() => {
      const t = instanceIndex;
      // On the grid, threads take the nodes in cell order (neighbouring threads read the same cells).
      const i = grid ? this.grid.nodeAt(t).toVar() : t;
      const li = localId.x;
      const valid = i.lessThan(N);
      const p = pos.element(i).xyz.toVar();
      const v = vel.element(i).xyz.toVar();
      const dv = vec3(0).toVar();

      // Links: towards (or away from) linked nodes, with d3's predicted positions (position + velocity).
      If(valid, () => {
        const predicted = p.add(v);
        Loop({ start: adjStart.element(i), end: adjStart.element(i.add(1)), type: 'uint', condition: '<', name: 'edge' }, ({ edge: k }) => {
          const entry = adj.element(k);
          const j = uint(entry.x);
          const d = pos.element(j).xyz.add(vel.element(j).xyz).sub(predicted).toVar();
          If(dot(d, d).lessThan(1e-12), () => {
            d.assign(jiggle(i, k));
          });
          const l = length(d);
          dv.addAssign(d.mul(l.sub(entry.y).div(l).mul(alpha).mul(entry.z)));
        });
      });

      // Many-body: from the grid, or every other node, a tile at a time through workgroup memory (all threads
      // take part). Loops get their own names: nested TSL loops would all be called `i` in WGSL and shadow
      // each other.
      if (grid) {
        If(valid, () => {
          this.grid.apply(t, i, p, dv, alpha);
        });
      } else Loop({ start: uint(0), end: uint(this.padded), type: 'uint', condition: '<', update: WG, name: 'base' }, ({ base }) => {
        const j = base.add(li);
        tile.element(li).assign(vec4(pos.element(j).xyz, select(j.lessThan(N), nodeA.element(j).x, 0)));
        workgroupBarrier();
        Loop({ start: uint(0), end: uint(WG), type: 'uint', condition: '<', name: 't' }, ({ t }) => {
          const other = tile.element(t);
          const d = other.xyz.sub(p).toVar();
          const l = dot(d, d).toVar();
          If(other.w.notEqual(0).and(base.add(t).notEqual(i)).and(l.lessThan(distanceMax2)), () => {
            If(l.lessThan(1e-12), () => {
              d.assign(jiggle(i, base.add(t)));
              l.assign(dot(d, d));
            });
            const lAdjusted = select(l.lessThan(distanceMin2), sqrt(distanceMin2.mul(l)), l);
            dv.addAssign(d.mul(other.w.mul(alpha).div(lAdjusted)));
          });
        });
        workgroupBarrier();
      });

      If(valid, () => {
        const a = nodeA.element(i);
        const b = nodeB.element(i);
        // Anchors (forceX/Y/Z) and the pull to the group's centroid.
        dv.addAssign(a.yzw.sub(p).mul(anchorStrength).mul(alpha));
        If(b.z.greaterThanEqual(0), () => {
          const c = centroid.element(uint(b.z));
          If(c.w.greaterThan(0), () => {
            dv.addAssign(c.xyz.div(c.w).sub(p).mul(clusterStrength).mul(alpha));
          });
        });
        velNext.element(i).assign(vec4(v.add(dv).mul(keep), 0));
      });
    })().compute(padded, [WG]);

    // 4. Move: new velocity, the centring shift, fixed heights; to the store texture for drawing.
    const center = config.center;
    this.moveKernel = Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(N), () => {
        const b = nodeB.element(i);
        const v = velNext.element(i).xyz.toVar();
        const p = pos.element(i).xyz.toVar();
        if (center) p.subAssign(mean.element(0).xyz);
        p.addAssign(v);
        If(b.y.greaterThan(0.5), () => {
          p.y.assign(b.x);
          v.y.assign(0);
        });
        // A broken number (0/0) must not spread: put the node back on its anchor.
        If(p.x.equal(p.x).not().or(p.y.equal(p.y).not()).or(p.z.equal(p.z).not()), () => {
          p.assign(nodeA.element(i).yzw);
          v.assign(vec3(0));
        });
        pos.element(i).assign(vec4(p, 1));
        vel.element(i).assign(vec4(v, 0));
        textureStore(texture, storeAt(i), vec4(p, 1));
      });
    })().compute(padded, [WG]);

    // Copies the positions into the store texture (the first frame, before any tick).
    this.publish = Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(N), () => {
        textureStore(texture, storeAt(i), pos.element(i));
      });
    })().compute(padded, [WG]);

    this.buffers = [this.pos, this.vel, this.velNext, node, index, adj, groupStart, groupOrder, scratch, partial, mean, ...(this.grid?.buffers ?? [])];
    this.kernels = [
      this.groupKernel,
      ...(config.center ? [this.partialKernel, this.meanKernel] : []),
      ...(this.grid?.kernels ?? []),
      this.forceKernel,
      this.moveKernel,
    ];
  }

  /**
   * Runs this frame's ticks on the GPU. Returns true when new positions arrived on the CPU (a readback),
   * which is when units, labels and picking catch up.
   */
  step() {
    if (this.stopped) return false;
    const config = this.config;
    if (this.alpha >= config.alphaMin) {
      for (let k = 0; k < this.ticksPerFrame && this.alpha >= config.alphaMin; k++) {
        // As d3: alpha += (alphaTarget - alpha) * alphaDecay, then the forces at that alpha.
        this.alpha += (0 - this.alpha) * config.alphaDecay;
        this.uAlpha.value = this.alpha;
        this.renderer.compute(this.kernels);
        this.ticks++;
        perf.ticks++;
      }

      this.adapt();
    }

    const done = this.alpha < config.alphaMin;
    const now = performance.now();
    if (!this.readback && (done || now - this.lastReadback > 200)) this.read(done);
    const fresh = this.fresh;
    this.fresh = false;
    return fresh;
  }

  /**
   * Fewer ticks per frame when frames get slow, more when there is room. Small layouts cost next to nothing
   * per tick (the many-body force is nodes² pairs): slow frames are not their fault, they keep their ticks.
   */
  adapt() {
    const now = performance.now();
    if (this.lastFrame) {
      const interval = now - this.lastFrame;
      const cheap = this.cost * this.ticksPerFrame < 4e7;
      if (interval > 40 && !cheap && this.ticksPerFrame > 1) this.ticksPerFrame--;
      else if ((interval < 20 || cheap) && this.ticksPerFrame < 48) this.ticksPerFrame++;
    }

    this.lastFrame = now;
  }

  /** Positions back to the CPU (asynchronously; one read at a time). */
  read(final) {
    const ticks = this.ticks;
    this.readback = this.renderer
      .getArrayBufferAsync(this.pos.value)
      .then((buffer) => {
        if (this.stopped) return;
        const data = new Float32Array(buffer);
        const out = this.positions;
        for (let i = 0; i < this.count; i++) {
          out[i * 3] = data[i * 4];
          out[i * 3 + 1] = data[i * 4 + 1];
          out[i * 3 + 2] = data[i * 4 + 2];
        }

        this.store.setAll(out, this.count); // the CPU copy of the store follows, for when it takes over again
        this.fresh = true;
        if (final && ticks === this.ticks) this.settled = true;
      })
      .catch((error) => {
        console.warn('CodeMap: reading the GPU layout back failed', error);
        if (final) this.settled = true;
      })
      .finally(() => {
        this.readback = null;
        this.lastReadback = performance.now();
      });
  }

  stop() {
    this.stopped = true;
    this.settled = true;
  }

  /** Frees the GPU buffers and kernels; the store goes back to drawing the CPU copy (the last positions read). */
  dispose() {
    this.stop();
    this.store.upload();
    const kernels = [this.groupKernel, this.partialKernel, this.meanKernel, this.forceKernel, this.moveKernel, this.publish, ...(this.grid?.kernels ?? [])];
    for (const kernel of kernels) kernel?.dispose();
    // three frees storage buffers only through its (internal) attribute cache.
    const attributes = this.renderer._attributes;
    for (const node of this.buffers ?? []) attributes?.delete(node.value);
    this.texture.dispose();
  }
}

/** A tiny pseudo-random push for two nodes on the same spot (d3's jiggle), different per pair. */
function jiggle(i, k) {
  const seed = float(i).mul(12.9898).add(float(k).mul(78.233));
  return vec3(hash(seed), hash(seed.add(1.7)), hash(seed.add(3.1))).sub(0.5).mul(1e-3);
}
