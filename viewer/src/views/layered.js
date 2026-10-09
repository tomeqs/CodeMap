import { CircleGeometry, Color, DoubleSide, Group, Mesh, RingGeometry, Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { feedsBloom } from '../scene/materials.js';
import { createSpec } from '../layout/spec.js';
import { GalaxyView } from './galaxy.js';

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

  /** Height is the layer (fixed); the layout only arranges each plane. Projects become columns through the layers. */
  layoutSpec(state, cachedRatio) {
    const units = this.units;
    const n = units.length;
    const layerCount = Math.max(1, this.layering.layers.length);
    this.spacing = Math.min(240, Math.max(70, 24 * Math.sqrt(n / layerCount) + 40));
    for (const u of units) {
      u.layer = this.layering.layerOf.get(u.id) ?? 0;
      u.y = this.layerY(u.layer);
    }

    const projectIds = [...new Set(units.map((u) => u.node.projectNode?.id).filter(Boolean))].sort();
    const radius = projectIds.length > 1 ? 40 + 12 * Math.sqrt(n) : 0;
    const anchors = new Map(projectIds.map((id, i) => {
      const angle = (i / projectIds.length) * Math.PI * 2;
      return [id, { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius }];
    }));

    const spec = createSpec(n, this.links.length, {
      alpha: cachedRatio > 0.8 ? 0.4 : 1,
      alphaDecay: n > 3000 ? 0.035 : 0.024,
      velocityDecay: 0.38,
      theta: 0.9,
      distanceMax: 520,
      anchorStrength: [0.045, 0, 0.045],
      clusterStrength: 0.16,
      center: false,
    });
    this.fillSpec(spec, state, (u) => anchors.get(u.node.projectNode?.id) ?? { x: 0, z: 0 });
    units.forEach((u, i) => {
      spec.fixedY[i] = u.y;
      spec.charge[i] = -16 - u.r * u.r * 2.6;
    });
    this.fillLinks(spec, (l) => l.s.r + l.t.r + 16, 0.3);
    return spec;
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
      const fill = new Mesh(circle, feedsBloom(new MeshBasicNodeMaterial({ color: tint, transparent: true, opacity: 0.075, side: DoubleSide, depthWrite: false }), 0));
      const rim = new Mesh(ring, feedsBloom(new MeshBasicNodeMaterial({ color: tint, transparent: true, opacity: 0.5, side: DoubleSide, depthWrite: false }), 0.5));
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
    const moving = !this.settled;
    const result = super.update(dt);
    if (moving) this.updatePlanes();
    return result;
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
