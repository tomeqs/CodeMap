import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  QuadraticBezierCurve3,
  Vector3,
} from 'three';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { EDGE_KINDS } from '../data/palette.js';
import { buildingMaterial, createLines, FlowParticles } from '../scene/materials.js';
import { disposeObject } from '../scene/disposer.js';

const SEGMENTS = 18;
const PROJECT_SLAB = 2.2;
const NAMESPACE_SLAB = 1.4;

const matrix = new Matrix4();
const color = new Color();
const tmp = new Vector3();

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
    this.options = { allArcs: false, labels: true };

    this.boxGeometry = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.buildingMaterial = buildingMaterial();
    this.districtMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
    this.arcs = createLines(1);
    this.particles = new FlowParticles(6000, 3.5);

    this.ground = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ color: '#070b16', roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;

    this.sun = new DirectionalLight(0xc8d8ff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.group.add(
      new HemisphereLight(0x8fb4ff, 0x0b0f1a, 0.9),
      new AmbientLight(0x404a66, 0.6),
      this.sun,
      this.sun.target,
      this.ground,
      this.arcs,
      this.particles.points,
    );
  }

  activate() {
    this.stage.scene.add(this.group);
    this.stage.setAtmosphere({ background: '#05070f', fog: 0, stars: true });
    this.stage.setBloom(0.75, 0.45, 0.35);
    this.stage.controls.maxPolarAngle = Math.PI * 0.49;
    this.stage.controls.minDistance = 8;
    this.stage.invalidate();
  }

  deactivate() {
    this.stage.scene.remove(this.group);
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
    this.group.remove(this.districtMesh);
    this.districtMesh?.dispose();
    this.districtMesh = new InstancedMesh(this.boxGeometry, this.districtMaterial, districts.length);
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
    this.group.add(this.districtMesh);

    // ---------------------------------------------------------------- buildings
    this.group.remove(this.buildingMesh);
    this.buildingMesh?.dispose();
    this.buildingMesh = new InstancedMesh(this.boxGeometry, this.buildingMaterial, leaves.length);
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
    this.updateMatrices();
    this.group.add(this.buildingMesh);

    // ---------------------------------------------------------------- ground, light, links
    this.ground.scale.set(size * 3, size * 3, 1);
    this.ground.position.y = -0.05;
    this.sun.position.set(size * 0.6, size * 0.9, size * 0.35);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -size * 0.75;
    cam.right = cam.top = size * 0.75;
    cam.near = 1;
    cam.far = size * 3;
    cam.updateProjectionMatrix();

    this.links = links
      .filter((l) => this.byId.has(l.source) && this.byId.has(l.target))
      .map((l) => ({ ...l, s: this.byId.get(l.source), t: this.byId.get(l.target) }));
    this.links.forEach((l) => (l.curve = arcCurve(l.s, l.t)));

    this.labelOrder = [...this.units].sort((a, b) => b.height - a.height);
    this.recolor();
    this.setHighlight(null);
    if (!this.keepCamera) this.fit(false);
  }

  updateMatrices() {
    for (const u of this.units) this.setMatrix(u);
    this.buildingMesh.instanceMatrix.clearUpdateRanges();
    this.buildingMesh.instanceMatrix.needsUpdate = true;
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
    if (this.buildingMesh.instanceColor) {
      this.buildingMesh.instanceColor.clearUpdateRanges();
      this.buildingMesh.instanceColor.needsUpdate = true;
    }

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
      mesh.instanceMatrix.addUpdateRange(u.index * 16, 16);
      mesh.instanceColor.addUpdateRange(u.index * 3, 3);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
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
      selected = [...this.links].sort((a, b) => b.weight - a.weight).slice(0, 3000);
      intensity = selected.length > 800 ? 0.3 : 0.55;
    } else selected = [];

    this.group.remove(this.arcs);
    this.arcs.geometry.dispose();
    this.arcs = createLines(Math.max(1, selected.length * SEGMENTS));
    const pos = this.arcs.geometry.attributes.position.array;
    const col = this.arcs.geometry.attributes.color.array;
    let i = 0;
    const point = new Vector3();
    const next = new Vector3();
    for (const l of selected) {
      color.set(EDGE_KINDS[l.kind]?.color ?? '#ffffff');
      for (let s = 0; s < SEGMENTS; s++) {
        const t0 = s / SEGMENTS;
        const t1 = (s + 1) / SEGMENTS;
        l.curve.getPoint(t0, point);
        l.curve.getPoint(t1, next);
        const a = intensity * (1 - t0 * 0.7);
        const b = intensity * (1 - t1 * 0.7);
        pos.set([point.x, point.y, point.z, next.x, next.y, next.z], i * 6);
        col.set([color.r * a, color.g * a, color.b * a, color.r * b, color.g * b, color.b * b], i * 6);
        i++;
      }
    }

    this.arcs.geometry.setDrawRange(0, i * 2);
    this.arcs.geometry.attributes.position.needsUpdate = true;
    this.arcs.geometry.attributes.color.needsUpdate = true;
    this.group.add(this.arcs);
    this.stage.invalidate();

    const flowing = selected.length > 1200 ? selected.slice(0, 1200) : selected;
    this.particles.setPaths(
      flowing.map((l) => ({
        count: Math.min(3, 1 + Math.floor(Math.log2(l.weight))),
        speed: 0.22 + Math.random() * 0.1,
        phase: Math.random(),
        color: new Color(EDGE_KINDS[l.kind]?.color ?? '#ffffff').multiplyScalar(1.8 * intensity),
        at: (t, out) => l.curve.getPoint(t, out),
      })),
    );
  }

  // ------------------------------------------------------------------ frame

  update(dt) {
    if (this.particles.count) this.particles.update(dt, tmp);
    if (this.options.labels) this.renderLabels();
    else this.labels.clear();
    return this.particles.count ? 'ambient' : false;
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
    if (animate) this.stage.flyTo(target, position, 1000);
    else this.stage.jumpTo(target, position);
  }

  dispose() {
    this.stage.scene.remove(this.group);
    disposeObject(this.group);
    this.boxGeometry.dispose();
    this.units = [];
    this.links = [];
  }
}

function arcCurve(s, t) {
  const start = new Vector3(s.x, s.top, s.z);
  const end = new Vector3(t.x, t.top, t.z);
  const distance = start.distanceTo(end);
  const mid = start.clone().lerp(end, 0.5);
  mid.y = Math.max(start.y, end.y) + 12 + distance * 0.42;
  return new QuadraticBezierCurve3(start, mid, end);
}

function shortNamespace(name) {
  const parts = name.split('.');
  return parts.length > 2 ? '…' + parts.slice(-2).join('.') : name;
}
