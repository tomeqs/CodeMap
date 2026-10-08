import { CircleGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import { forceLink, forceManyBody, forceSimulation, forceX, forceZ } from 'd3-force-3d';
import { clusterForce, GalaxyView } from './galaxy.js';

const circle = new CircleGeometry(1, 96);
const ring = new RingGeometry(0.986, 1, 160);

/**
 * Nodes sit on horizontal planes (layers); the force layout only moves them sideways. Used for the
 * architecture layers view and the DI lifetime view: in both, a link that points up is a problem
 * and is drawn in red / amber.
 */
export class LayeredView extends GalaxyView {
  constructor(stage, model, labels) {
    super(stage, model, labels);
    this.planeGroup = new Group();
    this.group.add(this.planeGroup);
    this.planes = [];
    this.fitDirection = new Vector3(1, 0.36, 0.8);
    this.layering = { layers: [], layerOf: new Map() };
  }

  activate() {
    super.activate();
    this.stage.setBloom(0.62, 0.45, 0.24);
  }

  /**
   * @param layering { layerOf: Map<id, index>, layers: [{ title, color }] } from the bottom up.
   * Links may carry `violation: 'error' | 'warning'`.
   */
  build(units, links, state, layering) {
    this.layering = layering;
    super.build(units, links, state, []);
    this.stage.setBloom(0.62, 0.45, 0.24);
    this.buildPlanes();
  }

  layerY(index) {
    const count = Math.max(1, this.layering.layers.length);
    return (index - (count - 1) / 2) * this.spacing;
  }

  startSimulation(state, cachedRatio) {
    this.simulation?.stop();
    const units = this.units;
    const layerCount = Math.max(1, this.layering.layers.length);
    this.spacing = Math.min(240, Math.max(70, 24 * Math.sqrt(units.length / layerCount) + 40));
    for (const u of units) {
      u.layer = this.layering.layerOf.get(u.id) ?? 0;
      u.fy = this.layerY(u.layer); // height is the layer; the simulation only arranges each plane
      u.y = u.fy;
    }

    // Projects become columns through the layers.
    const projectIds = [...new Set(units.map((u) => u.node.projectNode?.id).filter(Boolean))].sort();
    const radius = projectIds.length > 1 ? 40 + 12 * Math.sqrt(units.length) : 0;
    const anchors = new Map(projectIds.map((id, i) => {
      const angle = (i / projectIds.length) * Math.PI * 2;
      return [id, { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius }];
    }));
    const anchorOf = (u) => anchors.get(u.node.projectNode?.id) ?? { x: 0, z: 0 };

    const degree = new Map();
    for (const l of this.links) {
      degree.set(l.s, (degree.get(l.s) ?? 0) + 1);
      degree.set(l.t, (degree.get(l.t) ?? 0) + 1);
    }

    const level = state.level;
    const groupOf = (u) => {
      const n = u.node;
      if (level === 'member') return n.typeNode?.id ?? n.parent;
      if (level === 'type') return n.namespaceNode?.id ?? n.parent;
      if (level === 'namespace') return n.projectNode?.id;
      return null;
    };

    const simLinks = this.links.map((l) => ({ source: l.s, target: l.t }));
    const sim = forceSimulation(units, 3)
      .force('link', forceLink(simLinks).distance((l) => l.source.r + l.target.r + 16).strength((l) => 0.3 / Math.min(degree.get(l.source) ?? 1, degree.get(l.target) ?? 1)))
      .force('charge', forceManyBody().strength((u) => -16 - u.r * u.r * 2.6).theta(0.9).distanceMax(520))
      .force('x', forceX((u) => anchorOf(u).x).strength(0.045))
      .force('z', forceZ((u) => anchorOf(u).z).strength(0.045))
      .force('cluster', clusterForce(groupOf, 0.16))
      .alpha(cachedRatio > 0.8 ? 0.4 : 1)
      .alphaDecay(units.length > 3000 ? 0.035 : 0.024)
      .velocityDecay(0.38)
      .stop();

    this.simulation = sim;
    this.settled = false;
    this.pendingFocus = null;

    const start = performance.now();
    while (performance.now() - start < 120 && sim.alpha() > 0.2) sim.tick();
    for (const u of units) this.positions.set(u.id, { x: u.x, y: u.y, z: u.z });
    this.updateMatrices();
    this.updateLinePositions();
  }

  // ------------------------------------------------------------------ planes

  buildPlanes() {
    for (const plane of this.planes) {
      plane.group.traverse((o) => o.material?.dispose());
      this.planeGroup.remove(plane.group);
    }

    const members = this.layering.layers.map(() => []);
    for (const u of this.units) members[u.layer]?.push(u);

    this.planes = this.layering.layers.map((layer, index) => {
      const tint = new Color(layer.color ?? '#6ea8ff');
      const fill = new Mesh(circle, new MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.075, side: DoubleSide, depthWrite: false }));
      const rim = new Mesh(ring, new MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.5, side: DoubleSide, depthWrite: false }));
      fill.rotation.x = rim.rotation.x = -Math.PI / 2;
      fill.raycast = rim.raycast = () => {}; // planes are scenery, not pickable
      const group = new Group();
      group.add(fill, rim);
      this.planeGroup.add(group);
      return { group, index, layer, members: members[index], radius: 40, center: new Vector3() };
    });
    this.updatePlanes();
  }

  updatePlanes() {
    for (const plane of this.planes) {
      const y = this.layerY(plane.index);
      let cx = 0;
      let cz = 0;
      for (const u of plane.members) {
        cx += u.x;
        cz += u.z;
      }

      const n = Math.max(1, plane.members.length);
      cx /= n;
      cz /= n;
      let radius = 36;
      for (const u of plane.members) radius = Math.max(radius, Math.hypot(u.x - cx, u.z - cz) + u.r + 16);
      plane.center.set(cx, y, cz);
      plane.radius = radius;
      plane.group.position.set(cx, y, cz);
      plane.group.scale.setScalar(radius);
    }
  }

  update(dt) {
    const moving = this.simulation && this.simulation.alpha() > this.simulation.alphaMin();
    super.update(dt);
    if (moving) this.updatePlanes();
  }

  /** Frames the stack of planes (their real extent, not the centre of mass of the nodes). */
  fit(animate = true) {
    if (!this.units.length) return;
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const plane of this.planes) {
      min.min(new Vector3(plane.center.x - plane.radius, plane.center.y, plane.center.z - plane.radius));
      max.max(new Vector3(plane.center.x + plane.radius, plane.center.y, plane.center.z + plane.radius));
    }

    for (const u of this.units) {
      min.min(new Vector3(u.x - u.r, u.y - u.r, u.z - u.r));
      max.max(new Vector3(u.x + u.r, u.y + u.r, u.z + u.r));
    }

    const center = min.clone().add(max).multiplyScalar(0.5);
    // Planes are seen at an angle: their far rims sit inside the bounding sphere, the vertical extent matters most.
    const halfHeight = (max.y - min.y) / 2 + 20;
    const halfWidth = Math.max(max.x - min.x, max.z - min.z) / 2;
    this.fitSphere(center, Math.max(halfHeight * 1.15, halfWidth * 0.85, 40), animate, 1);
  }

  extraLabels() {
    if (!this.options.labels) return [];
    return this.planes.map((plane) => ({
      text: plane.layer.title,
      position: new Vector3(plane.center.x + plane.radius * 0.72, plane.center.y, plane.center.z + plane.radius * 0.72),
      cls: 'l-district',
      force: true,
      offsetY: 0,
      opacity: 0.95,
    }));
  }
}
