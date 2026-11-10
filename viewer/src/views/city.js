import {
  BoxGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { EDGE_KINDS } from '../data/palette.js';
import { buildingMaterial } from '../scene/materials.js';
import { LinkMesh } from '../scene/link-mesh.js';
import { GpuParticles, particlesPerLink } from '../scene/particles.js';
import { uploadAll, uploadRange } from '../scene/uploads.js';
import { PositionStore } from '../gpu/position-store.js';
import { disposeObject } from '../scene/disposer.js';
import { instances } from '../scene/instances.js';

const PROJECT_SLAB = 2.2;
const NAMESPACE_SLAB = 1.4;

const matrix = new Matrix4();
const color = new Color();

/**
 * Code city: every project is a district, every namespace a block, every type a building.
 * Footprint ~ size, height ~ chosen metric, colour ~ chosen mode. Relationships are arcs in the sky.
 */
export class CityView {
  constructor(stage, model, labels) {
    this.stage = stage;
    this.model = model;
    this.labels = labels;
    this.group = new Group();
    this.units = [];
    this.links = [];
    this.highlight = null;
    this.hovered = null;
    this.options = { allArcs: false, labels: true, particles: 1 };

    this.boxGeometry = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.buildingMaterial = buildingMaterial();
    this.districtMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
    // Arcs and particles read the roof of each building from the store and bend on the GPU.
    this.store = new PositionStore();
    this.arcMesh = new LinkMesh(this.store, { arc: true });
    this.arcs = this.arcMesh.mesh;
    this.particles = new GpuParticles(this.store, { max: 30000, size: 10, arc: true });

    this.ground = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ color: '#070b16', roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;

    // The sun (the stage's shared light) stands where the last build put it, and casts the buildings' shadows.
    this.sunPosition = new Vector3(300, 450, 175);
    this.shadowSize = 500;
    this.group.add(this.ground, this.arcs, this.particles.points);
  }

  activate() {
    this.stage.scene.add(this.group);
    this.active = true;
    this.applyLights();
    this.stage.setAtmosphere({ background: '#05070f', fog: 0, stars: true, nebula: 0.4 });
    this.stage.setBloom(0.75, 0.45, 0.35);
    this.stage.controls.maxPolarAngle = Math.PI * 0.49;
    this.stage.controls.minDistance = 8;
    this.stage.invalidate();
  }

  /** Sky and ground light, a little ambient and a sun over the city whose shadow covers it. */
  applyLights() {
    const lights = this.stage.lights;
    lights.set({
      hemisphere: { sky: 0x8fb4ff, ground: 0x0b0f1a, intensity: 0.9 },
      ambient: { color: 0x404a66, intensity: 0.6 },
      sun: { color: 0xc8d8ff, intensity: 1.6, position: this.sunPosition },
    });
    const size = this.shadowSize;
    const cam = lights.sun.shadow.camera;
    cam.left = cam.bottom = -size * 0.75;
    cam.right = cam.top = size * 0.75;
    cam.near = 1;
    cam.far = size * 3;
    cam.updateProjectionMatrix();
  }

  deactivate() {
    this.stage.scene.remove(this.group);
    this.active = false;
    this.stage.controls.maxPolarAngle = Math.PI;
    this.labels.clear();
    this.stage.invalidate();
  }

  setOptions(options) {
    Object.assign(this.options, options);
    this.refreshArcs();
  }

  // ------------------------------------------------------------------ build

  build(types, links, state) {
    this.state = state;
    const model = this.model;
    const footprint = state.footprintMetric ?? 'loc';

    // project -> namespace -> type tree
    const projects = new Map();
    for (const node of types) {
      const project = node.external ? { id: 'external', name: 'External', baseColor: new Color('#55596a') } : node.projectNode;
      const ns = node.external ? { id: 'external:' + (node.namespace ?? ''), name: node.namespace ?? 'external', baseColor: project.baseColor } : node.namespaceNode ?? project;
      if (!projects.has(project.id)) projects.set(project.id, { data: project, namespaces: new Map() });
      const p = projects.get(project.id);
      if (!p.namespaces.has(ns.id)) p.namespaces.set(ns.id, { data: ns, types: [] });
      p.namespaces.get(ns.id).types.push(node);
    }

    const root = {
      children: [...projects.values()].map((p) => ({
        data: p.data,
        children: [...p.namespaces.values()].map((ns) => ({
          data: ns.data,
          children: ns.types.map((t) => ({ data: t, value: Math.max(6, t.metrics[footprint] ?? 0) + 4 })),
        })),
      })),
    };

    const h = hierarchy(root).sum((d) => d.value ?? 0).sort((a, b) => b.value - a.value);
    const size = Math.min(9000, Math.max(260, Math.sqrt(h.value) * 4.2));
    treemap()
      .size([size, size])
      .tile(treemapSquarify.ratio(1.25))
      .paddingOuter((d) => (d.depth === 0 ? 0 : d.depth === 1 ? size * 0.006 + 2 : 1.5))
      .paddingTop((d) => (d.depth === 1 ? size * 0.012 + 6 : d.depth === 2 ? 4 : 0))
      .paddingInner((d) => (d.depth === 0 ? size * 0.012 + 4 : d.depth === 1 ? 2.5 : 1.6))(h);
    this.size = size;

    const offset = size / 2;
    const districts = h.descendants().filter((d) => d.depth === 1 || d.depth === 2);
    const leaves = h.leaves();
    const heightMetric = state.heightMetric ?? 'complexity';
    const maxHeight = Math.max(40, size * 0.16);

    // ---------------------------------------------------------------- districts
    this.districtMesh = instances(this.group, this.districtMesh, this.boxGeometry, this.districtMaterial, districts.length);
    this.districtMesh.receiveShadow = true;
    this.districts = districts.map((d, i) => {
      const base = d.depth === 1 ? 0 : PROJECT_SLAB;
      const height = d.depth === 1 ? PROJECT_SLAB : NAMESPACE_SLAB;
      // Heavy padding can collapse tiny districts; a zero scale would poison lighting (NaN) and bloom.
      const w = Math.max(0.5, d.x1 - d.x0);
      const dd = Math.max(0.5, d.y1 - d.y0);
      matrix.makeScale(w, height, dd);
      matrix.setPosition(d.x0 + w / 2 - offset, base, d.y0 + dd / 2 - offset);
      this.districtMesh.setMatrixAt(i, matrix);
      const c = (d.data.data.baseColor ?? new Color('#556')).clone();
      const hsl = {};
      c.getHSL(hsl);
      c.setHSL(hsl.h, hsl.s * 0.55, d.depth === 1 ? 0.13 : 0.2);
      this.districtMesh.setColorAt(i, c);
      return { node: d.data.data, depth: d.depth, x: d.x0 + w / 2 - offset, z: d.y0 + dd / 2 - offset, w, d: dd, top: base + height, front: d.y0 - offset };
    });
    uploadAll(this.districtMesh.instanceMatrix);
    uploadAll(this.districtMesh.instanceColor);
    this.districtMesh.computeBoundingSphere();

    // ---------------------------------------------------------------- buildings
    this.buildingMesh = instances(this.group, this.buildingMesh, this.boxGeometry, this.buildingMaterial, leaves.length);
    this.buildingMesh.castShadow = leaves.length < 6000;
    this.buildingMesh.receiveShadow = true;
    this.byId = new Map();
    this.units = leaves.map((leaf, i) => {
      const node = leaf.data.data;
      const w = Math.max(0.6, (leaf.x1 - leaf.x0) * 0.86);
      const d = Math.max(0.6, (leaf.y1 - leaf.y0) * 0.86);
      const t = model.norm(node, heightMetric);
      const height = 1.5 + t * maxHeight * (node.kind === 'interface' ? 0.5 : 1);
      const base = PROJECT_SLAB + NAMESPACE_SLAB;
      const unit = {
        id: node.id,
        node,
        index: i,
        x: (leaf.x0 + leaf.x1) / 2 - offset,
        z: (leaf.y0 + leaf.y1) / 2 - offset,
        w,
        d,
        base,
        height,
        top: base + height,
      };
      this.byId.set(node.id, unit);
      return unit;
    });
    this.store.ensure(this.units.length);
    for (const u of this.units) this.store.set(u.index, u.x, u.top, u.z);
    this.store.upload();
    this.updateMatrices();

    // ---------------------------------------------------------------- ground, light, links
    this.ground.scale.set(size * 3, size * 3, 1);
    this.ground.position.y = -0.05;
    this.sunPosition.set(size * 0.6, size * 0.9, size * 0.35);
    this.shadowSize = size;
    if (this.active) this.applyLights();

    this.links = links
      .filter((l) => this.byId.has(l.source) && this.byId.has(l.target))
      .map((l) => ({ ...l, s: this.byId.get(l.source), t: this.byId.get(l.target) }));

    this.labelOrder = [...this.units].sort((a, b) => b.height - a.height);
    this.recolor();
    this.setHighlight(null);
    if (!this.keepCamera) this.fit(false);
    // The buildings grow out of the ground, one after another.
    this.riseStart = this.stage.motion === 'off' ? null : performance.now();
    this.buildingMaterial.userData.rise.value = this.riseStart === null ? 1e6 : 0;
  }

  updateMatrices() {
    for (const u of this.units) this.setMatrix(u);
    uploadAll(this.buildingMesh.instanceMatrix);
    this.buildingMesh.computeBoundingSphere();
    this.stage.invalidate();
  }

  setMatrix(u) {
    const grow = u === this.hovered ? 1.08 : 1;
    matrix.makeScale(u.w * grow, u.height, u.d * grow);
    matrix.setPosition(u.x, u.base, u.z);
    this.buildingMesh.setMatrixAt(u.index, matrix);
  }

  recolor() {
    for (const u of this.units) this.setUnitColor(u);
    uploadAll(this.buildingMesh.instanceColor);

    this.stage.invalidate();
  }

  setUnitColor(u) {
    const h = this.highlight;
    this.model.colorOf(u.node, this.state?.colorMode ?? 'project', color);
    let factor = 0.85;
    if (h) {
      if (h.primary === u.id) factor = 1.55;
      else if (h.nodes.has(u.id)) factor = 1.15;
      else factor = 0.18;
    } else if (u === this.hovered) factor = 1.4;
    this.buildingMesh.setColorAt(u.index, color.multiplyScalar(factor));
  }

  setHighlight(highlight) {
    this.highlight = highlight;
    this.recolor();
    this.refreshArcs();
  }

  setHovered(id) {
    const unit = id ? this.byId?.get(id) ?? null : null;
    if (unit === this.hovered) return;
    const previous = this.hovered;
    this.hovered = unit;
    const mesh = this.buildingMesh;
    for (const u of [previous, unit]) {
      if (!u) continue;
      this.setMatrix(u);
      this.setUnitColor(u);
      uploadRange(mesh.instanceMatrix, u.index * 16, 16);
      uploadRange(mesh.instanceColor, u.index * 3, 3);
    }

    if (!this.highlight) this.refreshArcs();
    this.stage.invalidate();
  }

  // ------------------------------------------------------------------ arcs

  refreshArcs() {
    const h = this.highlight;
    let selected;
    let intensity = 1;
    if (h) selected = this.links.filter((_, i) => h.links.has(i));
    else if (this.hovered) selected = this.links.filter((l) => l.s === this.hovered || l.t === this.hovered);
    else if (this.options.allArcs) {
      selected = [...this.links].sort((a, b) => b.weight - a.weight).slice(0, 20000);
      intensity = selected.length > 800 ? 0.3 : 0.55;
    } else selected = [];

    const arcs = this.arcMesh;
    arcs.setCount(selected.length);
    selected.forEach((l, i) => {
      arcs.setEnds(i, l.s.index, l.t.index);
      arcs.setStyle(i, color.set(EDGE_KINDS[l.kind]?.color ?? '#ffffff'), intensity, intensity * 0.3, 1.6, h || this.hovered ? 1 : 0);
    });
    arcs.flush();

    const density = this.options.particles;
    const flowing = density > 0 ? selected.slice(0, 6000) : [];
    this.particles.setPaths(
      flowing.map((l) => ({
        source: l.s.index,
        target: l.t.index,
        count: particlesPerLink(Math.min(3, 1 + Math.floor(Math.log2(l.weight))), density),
        speed: 0.22 + Math.random() * 0.1,
        color: new Color(EDGE_KINDS[l.kind]?.color ?? '#ffffff').multiplyScalar(1.8 * intensity),
      })),
    );
    this.stage.invalidate();
  }

  // ------------------------------------------------------------------ frame

  update() {
    let rising = false;
    if (this.riseStart !== null && this.riseStart !== undefined) {
      const t = (performance.now() - this.riseStart) / 1000;
      rising = t < 2;
      this.buildingMaterial.userData.rise.value = rising ? t : 1e6;
      if (!rising) this.riseStart = null;
    }

    if (this.options.labels && !rising) this.renderLabels();
    else this.labels.clear();
    if (rising) return true;
    return this.particles.count || this.arcMesh.flowing ? 'ambient' : false;
  }

  renderLabels() {
    const items = [];
    const h = this.highlight;
    const camera = this.stage.camera.position;
    const add = (u, cls, force) =>
      items.push({ text: u.node.name, position: new Vector3(u.x, u.top + 1, u.z), cls, force, offsetY: 6, opacity: 1 });

    if (h?.primary && this.byId.has(h.primary)) add(this.byId.get(h.primary), 'l-selected', true);
    if (this.hovered) add(this.hovered, 'l-selected', true);
    if (h) for (const id of h.nodes) if (id !== h.primary && this.byId.has(id)) add(this.byId.get(id), '', false);

    for (const d of this.districts) {
      if (d.depth !== 1 && d.w < this.size * 0.04) continue;
      const position = new Vector3(d.x, d.top + 0.5, d.front + (d.depth === 1 ? 4 : 2));
      const distance = camera.distanceTo(position);
      if (d.depth === 2 && distance > this.size * 0.9) continue;
      items.push({
        text: d.depth === 2 ? shortNamespace(d.node.name) : d.node.name,
        position,
        cls: d.depth === 1 ? 'l-district' : 'l-namespace',
        opacity: d.depth === 1 ? 1 : Math.min(1, (this.size * 0.9) / distance - 0.2),
      });
    }

    let n = 0;
    for (const u of this.labelOrder) {
      if (n++ > (h ? 0 : 30)) break;
      add(u, '', false);
    }

    this.labels.render(items, 150);
  }

  // ------------------------------------------------------------------ interaction

  /** AR reticle: the nearest building a ray (the middle of the view) passes through. */
  pickAlong({ origin, direction }) {
    let best = null;
    let nearest = Infinity;
    for (const u of this.units) {
      // Slab test against the building's box.
      let near = 0;
      let far = Infinity;
      const min = [u.x - u.w / 2, u.base, u.z - u.d / 2];
      const max = [u.x + u.w / 2, u.top, u.z + u.d / 2];
      const o = [origin.x, origin.y, origin.z];
      const d = [direction.x, direction.y, direction.z];
      for (let axis = 0; axis < 3 && near <= far; axis++) {
        if (Math.abs(d[axis]) < 1e-9) {
          if (o[axis] < min[axis] || o[axis] > max[axis]) near = Infinity;
          continue;
        }

        let t0 = (min[axis] - o[axis]) / d[axis];
        let t1 = (max[axis] - o[axis]) / d[axis];
        if (t0 > t1) [t0, t1] = [t1, t0];
        near = Math.max(near, t0);
        far = Math.min(far, t1);
      }

      if (near <= far && near < nearest) {
        nearest = near;
        best = u;
      }
    }

    return best?.id ?? null;
  }

  pick(event) {
    const hits = this.stage.pick(event, [this.buildingMesh]);
    const hit = hits[0];
    return hit ? this.units[hit.instanceId]?.id ?? null : null;
  }

  positionOf(id) {
    const u = this.byId?.get(id);
    return u ? new Vector3(u.x, u.top, u.z) : null;
  }

  focus(id) {
    const u = this.byId?.get(id);
    if (!u) return;
    const target = new Vector3(u.x, u.base + u.height * 0.5, u.z);
    const distance = Math.max(40, u.height * 2.2, Math.max(u.w, u.d) * 5);
    const position = target.clone().add(new Vector3(0.55, 0.65, 0.9).normalize().multiplyScalar(distance));
    this.stage.flyTo(target, position, 900);
  }

  fit(animate = true) {
    const size = this.size ?? 300;
    const target = new Vector3(0, 0, 0);
    const narrow = Math.max(1, 1.2 / Math.max(0.3, this.stage.camera.aspect));
    const position = new Vector3(size * 0.62, size * 0.78, size * 1.05).multiplyScalar(narrow);
    // AR glasses: a model city of the chosen size, at the chosen distance.
    if (this.stage.stereo) position.normalize().multiplyScalar(this.stage.arFit(size * 0.6));
    if (animate) this.stage.flyTo(target, position, 1000);
    else this.stage.jumpTo(target, position);
  }

  dispose() {
    this.stage.scene.remove(this.group);
    disposeObject(this.group);
    this.boxGeometry.dispose();
    this.store.dispose();
    this.units = [];
    this.links = [];
  }
}

/** The last two parts of a namespace (Shop.Domain.Orders) or folder path (src/orders/api). */
export function shortNamespace(name) {
  const separator = name.includes('/') ? '/' : '.';
  const parts = name.split(separator);
  return parts.length > 2 ? '…' + parts.slice(-2).join(separator) : name;
}
