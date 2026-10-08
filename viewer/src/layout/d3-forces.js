import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from 'd3-force-3d';

/**
 * A d3-force-3d simulation for a LayoutSpec (the same code on the main thread and in the worker, so both
 * give the same layout). It is stopped: the caller ticks it.
 */
export function createSimulation(spec) {
  const { count, position, fixedY, anchor, config } = spec;
  const nodes = new Array(count);
  for (let i = 0; i < count; i++) {
    const node = { x: position[i * 3], y: position[i * 3 + 1], z: position[i * 3 + 2] };
    if (!Number.isNaN(fixedY[i])) node.fy = fixedY[i];
    nodes[i] = node;
  }

  const links = new Array(spec.linkSource.length);
  for (let k = 0; k < links.length; k++) links[k] = { source: spec.linkSource[k], target: spec.linkTarget[k], index: k };

  const [ax, ay, az] = config.anchorStrength;
  const sim = forceSimulation(nodes, 3)
    .force('link', forceLink(links).distance((l) => spec.linkDistance[l.index]).strength((l) => spec.linkStrength[l.index]))
    .force('charge', forceManyBody().strength((n) => spec.charge[n.index]).theta(config.theta).distanceMax(config.distanceMax));
  if (ax) sim.force('x', forceX((n) => anchor[n.index * 3]).strength(ax));
  if (ay) sim.force('y', forceY((n) => anchor[n.index * 3 + 1]).strength(ay));
  if (az) sim.force('z', forceZ((n) => anchor[n.index * 3 + 2]).strength(az));
  if (config.clusterStrength && spec.groupCount) sim.force('cluster', clusterForce(spec, config.clusterStrength));
  if (config.center) sim.force('center', forceCenter(0, 0, 0));
  sim.alpha(config.alpha).alphaMin(config.alphaMin).alphaDecay(config.alphaDecay).velocityDecay(config.velocityDecay).stop();
  return sim;
}

/** Copies the node positions into a flat array (x, y, z per node). */
export function readPositions(sim, out) {
  const nodes = sim.nodes();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    out[i * 3] = n.x;
    out[i * 3 + 1] = n.y;
    out[i * 3 + 2] = n.z;
  }

  return out;
}

/** Pulls nodes toward the radius-weighted centroid of their group (namespace, type…). */
function clusterForce(spec, strength) {
  const { group, groupCount, radius } = spec;
  const sum = new Float64Array(groupCount * 4);
  let nodes = [];
  const force = (alpha) => {
    sum.fill(0);
    for (let i = 0; i < nodes.length; i++) {
      const g = group[i];
      if (g < 0) continue;
      const n = nodes[i];
      const w = radius[i];
      sum[g * 4] += n.x * w;
      sum[g * 4 + 1] += n.y * w;
      sum[g * 4 + 2] += n.z * w;
      sum[g * 4 + 3] += w;
    }

    const k = strength * alpha;
    for (let i = 0; i < nodes.length; i++) {
      const g = group[i];
      if (g < 0) continue;
      const w = sum[g * 4 + 3];
      if (w === 0) continue;
      const n = nodes[i];
      n.vx += (sum[g * 4] / w - n.x) * k;
      n.vy += (sum[g * 4 + 1] / w - n.y) * k;
      n.vz += (sum[g * 4 + 2] / w - n.z) * k;
    }
  };

  force.initialize = (n) => (nodes = n);
  return force;
}
