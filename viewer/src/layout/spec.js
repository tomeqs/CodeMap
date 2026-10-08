/**
 * What a force layout needs, as plain typed arrays, so the same layout can run on the main thread, in a
 * Web Worker or on the GPU: node sizes and charges, links with their distance and strength, groups
 * (pulled together), anchors (projects), an optional fixed height per node (the layers views) and the
 * simulation settings. Everything is precomputed by the view; engines only integrate.
 *
 * @typedef {object} LayoutSpec
 * @property {number} count                  number of nodes
 * @property {Float32Array} position          x, y, z per node: where the layout starts
 * @property {Float32Array} radius            node radius (cluster weights)
 * @property {Float32Array} charge            many-body strength per node (negative: repulsion)
 * @property {Int32Array} group               group index per node, -1 for none
 * @property {number} groupCount
 * @property {Float32Array} anchor            x, y, z each node is pulled toward
 * @property {Float32Array} fixedY            height a node is pinned to (NaN: free)
 * @property {Int32Array} linkSource
 * @property {Int32Array} linkTarget
 * @property {Float32Array} linkDistance
 * @property {Float32Array} linkStrength
 * @property {LayoutConfig} config
 *
 * @typedef {object} LayoutConfig
 * @property {number} alpha            starting "temperature" (1 = from scratch, lower = settle what is there)
 * @property {number} alphaMin         below this the layout has settled
 * @property {number} alphaDecay
 * @property {number} velocityDecay
 * @property {number} theta            Barnes–Hut accuracy of the many-body force
 * @property {number} distanceMax      no repulsion beyond this distance
 * @property {number[]} anchorStrength x, y, z
 * @property {number} clusterStrength
 * @property {boolean} center          keep the centre of mass at the origin
 */

export const DEFAULT_CONFIG = {
  alpha: 1,
  alphaMin: 0.001,
  alphaDecay: 0.022,
  velocityDecay: 0.35,
  theta: 0.9,
  distanceMax: 700,
  anchorStrength: [0, 0, 0],
  clusterStrength: 0,
  center: false,
};

/** An empty spec for `count` nodes and `links` links (fixed heights default to free). */
export function createSpec(count, links, config = {}) {
  return {
    count,
    position: new Float32Array(count * 3),
    radius: new Float32Array(count),
    charge: new Float32Array(count),
    group: new Int32Array(count).fill(-1),
    groupCount: 0,
    anchor: new Float32Array(count * 3),
    fixedY: new Float32Array(count).fill(NaN),
    linkSource: new Int32Array(links),
    linkTarget: new Int32Array(links),
    linkDistance: new Float32Array(links),
    linkStrength: new Float32Array(links),
    config: { ...DEFAULT_CONFIG, ...config },
  };
}

/** The typed arrays of a spec, for postMessage transfer lists. */
export function specBuffers(spec) {
  return Object.values(spec).filter((v) => ArrayBuffer.isView(v)).map((v) => v.buffer);
}

/** Number of ticks from `alpha` until the layout settles (alpha decays geometrically). */
export function ticksToSettle(config) {
  const { alpha, alphaMin, alphaDecay } = config;
  if (alpha < alphaMin) return 0;
  return Math.ceil(Math.log(alphaMin / alpha) / Math.log(1 - alphaDecay));
}
