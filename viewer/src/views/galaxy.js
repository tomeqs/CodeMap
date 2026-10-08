import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  BufferGeometry,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  Mesh,
  OctahedronGeometry,
  PointLight,
  Sprite,
  SpriteMaterial,
  TetrahedronGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { EDGE_KINDS } from '../data/palette.js';
import { unitMaterial } from '../scene/materials.js';
import { LinkMesh } from '../scene/link-mesh.js';
import { GpuParticles } from '../scene/particles.js';
import { PositionStore } from '../gpu/position-store.js';
import { dotTexture } from '../scene/textures.js';
import { perf } from '../perf/stats.js';
import { disposeObject } from '../scene/disposer.js';
import { createSpec } from '../layout/spec.js';
import { startLayout } from '../layout/engine.js';

/** Shapes by kind; `detail` (0–3) is how round the spheres are (fewer triangles for big graphs). */
const GEOMETRIES = {
  sphere: (detail) => new IcosahedronGeometry(1, detail),
  orb: (detail) => new IcosahedronGeometry(1, Math.max(0, detail - 1)),
  octa: () => new OctahedronGeometry(1.15, 0),
  box: () => new BoxGeometry(1.5, 1.5, 1.5),
  dodeca: () => new DodecahedronGeometry(1.1, 0),
  tetra: () => new TetrahedronGeometry(1.3, 0),
  cone: () => new ConeGeometry(0.9, 1.8, 10),
  ring: () => new TorusGeometry(1, 0.28, 10, 32),
};

const SHAPE_OF = {
  project: 'orb',
  package: 'ring',
  assembly: 'ring',
  namespace: 'orb',
  class: 'sphere',
  interface: 'octa',
  struct: 'box',
  record: 'dodeca',
  recordStruct: 'dodeca',
  enum: 'tetra',
  delegate: 'cone',
  method: 'sphere',
  constructor: 'octa',
  property: 'box',
  field: 'tetra',
  event: 'cone',
};

const RADIUS = {
  project: [9, 26],
  namespace: [4.5, 14],
  type: [1.6, 8],
  member: [0.9, 3.4],
};

/** Edge colours for problems: dependencies against the layering, DI lifetime errors / warnings. */
export const VIOLATION_COLORS = { error: '#ff4545', warning: '#ffb02e', true: '#ff4545' };

const color = new Color();
const tmp = new Vector3();
const tmp2 = new Vector3();
const tmp3 = new Vector3();

/** 3D force-directed "galaxy": projects form solar systems, namespaces clusters, types stars. */
export class GalaxyView {
  constructor(stage, model, labels) {
    this.stage = stage;
    this.model = model;
    this.labels = labels;
    this.group = new Group();
    this.positions = new Map(); // id -> {x,y,z}, survives rebuilds for smooth transitions
    this.meshes = [];
    this.units = [];
    this.links = [];
    this.highlight = null;
    this.hovered = null;
    this.options = { flowAll: false, labels: true, autoRotate: false };
    this.detail = -1;
    // Everything reads unit positions from the store on the GPU: nodes, links and particles.
    this.store = new PositionStore();
    this.material = unitMaterial(this.store, 0.36);
    this.linkMesh = new LinkMesh(this.store);
    this.lines = this.linkMesh.mesh;
    this.particles = new GpuParticles(this.store, { max: 60000, size: 2.6 });
    this.halo = new Sprite(new SpriteMaterial({ map: dotTexture(), color: 0xffffff, transparent: true, opacity: 0.4, blending: AdditiveBlending, depthWrite: false }));
    this.halo.visible = false;

    this.lightGroup = new Group();
    this.lightGroup.add(new AmbientLight(0x8899cc, 0.55));
    const key = new DirectionalLight(0xffffff, 1.2);
    key.position.set(300, 500, 400);
    this.lightGroup.add(key);
    const rim = new PointLight(0x6ea8ff, 2, 0, 0);
    rim.position.set(-400, -200, -300);
    this.lightGroup.add(rim);

    this.group.add(this.lines, this.particles.points, this.halo, this.lightGroup);
    this.userMoved = false;
    /** Optional (node) => label text; the call-flow view labels methods with their type. */
    this.labelText = null;
    /** Node size multiplier (the call-flow view shows methods, normally the smallest nodes, as the main actors). */
    this.radiusScale = 1;
  }

  activate() {
    this.stage.scene.add(this.group);
    this.stage.setAtmosphere({ background: '#03050b', fog: 0, stars: true });
    this.stage.setBloom(0.78, 0.5, 0.2);
    this.stage.controls.autoRotate = this.options.autoRotate;
    this.stage.controls.autoRotateSpeed = 0.35;
    this.stage.controls.maxPolarAngle = Math.PI;
    this.stage.controls.minDistance = 5;
    this.stage.invalidate();
  }

  deactivate() {
    this.stage.scene.remove(this.group);
    this.stage.controls.autoRotate = false;
    this.labels.clear();
    this.stage.invalidate();
  }

  setOptions(options) {
    Object.assign(this.options, options);
    this.stage.controls.autoRotate = this.options.autoRotate;
    this.refreshParticles();
    this.stage.invalidate();
  }

  // ------------------------------------------------------------------ build

  build(units, links, state, ghosts = []) {
    this.savePositions();
    this.state = state;
    const model = this.model;
    const all = [...units.map((n) => ({ node: n, ghost: false })), ...ghosts.map((n) => ({ node: n, ghost: true }))];
    const byId = new Map();

    let cached = 0;
    this.units = all.map(({ node, ghost }) => {
      const r = this.radiusFor(node, state, ghost);
      const unit = { id: node.id, node, ghost, r, x: 0, y: 0, z: 0 };
      const known = this.positions.get(node.id);
      if (known) {
        unit.x = known.x;
        unit.y = known.y;
        unit.z = known.z;
        cached++;
      } else {
        // Start new nodes at the position of their nearest laid-out ancestor: drilling down "explodes" clusters.
        let anchor = null;
        for (let a = node.parent ? model.get(node.parent) : null; a && !anchor; a = a.parent ? model.get(a.parent) : null) anchor = this.positions.get(a.id);
        const spread = anchor ? 12 : 220;
        unit.x = (anchor?.x ?? 0) + (Math.random() - 0.5) * spread;
        unit.y = (anchor?.y ?? 0) + (Math.random() - 0.5) * spread;
        unit.z = (anchor?.z ?? 0) + (Math.random() - 0.5) * spread;
      }

      byId.set(node.id, unit);
      return unit;
    });
    this.units.forEach((u, i) => (u.index = i)); // place in the position store and in the layout
    this.store.ensure(this.units.length);
    this.byId = byId;

    this.links = links
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({ ...l, s: byId.get(l.source), t: byId.get(l.target) }));
    this.indexUnitLinks();

    // Dense graphs glow into one blob: tone bloom down as the node count grows.
    const density = Math.log10(Math.max(100, this.units.length) / 100);
    this.stage.setBloom(Math.max(0.45, 0.78 - density * 0.2), 0.5, 0.2 + density * 0.06);

    this.buildMeshes();
    this.buildLines();
    this.recolor();
    this.startSimulation(state, cached / Math.max(1, this.units.length));
    this.labelOrder = [...this.units].sort((a, b) => labelRank(b) - labelRank(a));
    this.setHighlight(null);
    if (cached < this.units.length * 0.5) this.fit(false);
  }

  /** Every unit knows the indices of its links (hover updates only those). */
  indexUnitLinks() {
    for (const u of this.units) u.linkIndices = [];
    this.links.forEach((l, i) => {
      l.s.linkIndices.push(i);
      l.t.linkIndices.push(i);
    });
  }

  /** Keeps where every unit is, for the next build (unchanged units stay put, new ones grow out of their parent). */
  savePositions() {
    for (const u of this.units) {
      const p = this.positions.get(u.id);
      if (p) {
        p.x = u.x;
        p.y = u.y;
        p.z = u.z;
      } else this.positions.set(u.id, { x: u.x, y: u.y, z: u.z });
    }
  }

  /** Node size: the size metric within the node's level range. */
  radiusFor(node, state, ghost = false) {
    const t = state.sizeMetric ? this.model.norm(node, state.sizeMetric) : 0.3;
    const base = node.level === 'project' && state.level !== 'project' ? RADIUS.project : RADIUS[node.level] ?? RADIUS[state.level] ?? RADIUS.type;
    const r = base[0] + (base[1] - base[0]) * Math.sqrt(t);
    return r * (ghost ? 0.75 : 1) * this.radiusScale;
  }

  buildMeshes() {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }

    this.meshes = [];
    const groups = new Map();
    for (const unit of this.units) {
      const shape = SHAPE_OF[unit.node.kind] ?? 'sphere';
      if (!groups.has(shape)) groups.set(shape, []);
      groups.get(shape).push(unit);
    }

    // Level of detail: a sphere is 1280 triangles at full detail; tens of thousands of them are too many,
    // more so without a GPU (software rendering).
    const n = this.units.length;
    const detail = Math.max(0, (n < 2500 ? 3 : n < 12000 ? 2 : 1) - (this.stage.software ? 1 : 0));
    if (detail !== this.detail) {
      for (const geometry of Object.values(this.geometries ?? {})) geometry.dispose();
      this.geometries = Object.fromEntries(Object.entries(GEOMETRIES).map(([k, f]) => [k, f(detail)]));
      this.detail = detail;
    }

    // One instanced mesh per shape: the shape's vertices plus, per instance, the unit's store index,
    // colour and size.
    for (const [shape, list] of groups) {
      const base = this.geometries[shape];
      const geometry = new BufferGeometry();
      geometry.setIndex(base.index);
      geometry.setAttribute('position', base.attributes.position);
      geometry.setAttribute('normal', base.attributes.normal);
      const unitIndex = new InstancedBufferAttribute(new Float32Array(list.length), 1);
      geometry.setAttribute('aUnit', unitIndex);
      geometry.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(list.length * 3), 3));
      geometry.setAttribute('aScale', new InstancedBufferAttribute(new Float32Array(list.length), 1));
      const mesh = new Mesh(geometry, this.material);
      mesh.count = list.length;
      mesh.userData.units = list;
      list.forEach((unit, i) => {
        unit.mesh = mesh;
        unit.slot = i; // its instance in the mesh (`index` is its place in the store and the layout)
        unitIndex.array[i] = unit.index;
      });
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }

    this.updateMatrices();
  }

  buildLines() {
    const links = this.linkMesh;
    links.setCount(this.links.length);
    this.links.forEach((l, i) => links.setEnds(i, l.s.index, l.t.index));
    links.flush();
  }

  startSimulation(state, cachedRatio) {
    this.layout?.stop();
    const spec = this.layoutSpec(state, cachedRatio);
    this.layoutStart = performance.now();
    this.layout = startLayout(spec);
    this.settled = false;
    this.pendingFocus = null;
    // A fresh layout in the worker: show it once its first (pre-warmed) frame is back, not the starting cloud.
    this.setLayoutVisible(this.layout.kind === 'main' || cachedRatio >= 0.5);
    this.applyLayout();
  }

  setLayoutVisible(visible) {
    for (const mesh of this.meshes) mesh.visible = visible;
    this.linkMesh.mesh.visible = visible;
    this.layoutHidden = !visible;
  }

  /** The force layout of the galaxy: projects are "solar systems" on a sphere, groups (namespaces, types) clump. */
  layoutSpec(state, cachedRatio) {
    const units = this.units;
    const n = units.length;
    const level = state.level;
    const projectIds = [...new Set(units.map((u) => u.node.projectNode?.id).filter(Boolean))];
    const anchors = new Map();
    const radius = level === 'project' ? 0 : 50 + 22 * Math.sqrt(n / Math.max(1, projectIds.length)) * Math.cbrt(projectIds.length);
    projectIds.forEach((id, i) => anchors.set(id, fibonacciSphere(i, projectIds.length, projectIds.length > 1 ? radius : 0)));
    const anchor = level === 'project' ? 0 : 0.035;
    const spec = createSpec(n, this.links.length, {
      alpha: cachedRatio > 0.8 ? 0.35 : 1,
      alphaDecay: n > 3000 ? 0.035 : 0.022,
      velocityDecay: 0.35,
      theta: 0.9,
      distanceMax: 700,
      anchorStrength: [anchor, anchor, anchor],
      clusterStrength: 0.22,
      center: true,
    });
    this.fillSpec(spec, state, (u) => anchors.get(u.node.projectNode?.id));
    spec.charge.forEach((_, i) => (spec.charge[i] = -14 - units[i].r * units[i].r * 2.2));
    this.fillLinks(spec, (l) => l.s.r + l.t.r + 14 + (l.s.node.projectNode !== l.t.node.projectNode ? 26 : 0), 0.55);
    return spec;
  }

  /** Positions, sizes, anchors and groups (namespace of a type, type of a member…) of the units. */
  fillSpec(spec, state, anchorOf) {
    const level = state.level;
    const groupOf = (n) => {
      if (level === 'member') return n.typeNode?.id ?? n.parent;
      if (level === 'type') return n.namespaceNode?.id ?? n.parent;
      if (level === 'namespace') return n.projectNode?.id;
      return null;
    };
    const groups = new Map();
    this.units.forEach((u, i) => {
      u.index = i;
      spec.position[i * 3] = u.x;
      spec.position[i * 3 + 1] = u.y;
      spec.position[i * 3 + 2] = u.z;
      spec.radius[i] = u.r;
      const a = anchorOf(u);
      if (a) {
        spec.anchor[i * 3] = a.x ?? 0;
        spec.anchor[i * 3 + 1] = a.y ?? 0;
        spec.anchor[i * 3 + 2] = a.z ?? 0;
      }

      const g = groupOf(u.node);
      if (g) {
        if (!groups.has(g)) groups.set(g, groups.size);
        spec.group[i] = groups.get(g);
      }
    });
    spec.groupCount = groups.size;
  }

  /** Links pull their ends to `distance`, hubs more gently (strength / smaller degree). */
  fillLinks(spec, distance, strength) {
    const degree = new Int32Array(this.units.length);
    for (const l of this.links) {
      degree[l.s.index]++;
      degree[l.t.index]++;
    }

    this.links.forEach((l, k) => {
      spec.linkSource[k] = l.s.index;
      spec.linkTarget[k] = l.t.index;
      spec.linkDistance[k] = distance(l);
      spec.linkStrength[k] = strength / Math.min(degree[l.s.index], degree[l.t.index]);
    });
  }

  /** Takes the newest positions of the layout: to the GPU in one upload, and to the units (labels, picking, camera). */
  applyLayout() {
    const p = this.layout.positions;
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      u.x = p[i * 3];
      u.y = p[i * 3 + 1];
      u.z = p[i * 3 + 2];
    }

    this.store.setAll(p, units.length);
    this.store.upload();
    this.stage.invalidate();
  }

  // ------------------------------------------------------------------ frame

  /** Advances the layout and the animations; returns true while the layout moves, 'ambient' for decoration only. */
  update(dt) {
    let busy = false;
    const layout = this.layout;
    if (layout && !this.settled) {
      busy = true;
      if (layout.step(9)) {
        this.applyLayout();
        if (this.layoutHidden) this.setLayoutVisible(true);
      }
      if (layout.settled) {
        this.settled = true;
        perf.set('settle', performance.now() - this.layoutStart);
        this.savePositions();
        if (this.pendingFocus) this.focus(this.pendingFocus);
        else if (!this.userMoved) this.fit(true);
      }
    }

    const halo = this.halo.visible && this.highlight?.primary ? this.byId.get(this.highlight.primary) : null;
    if (halo) {
      this.halo.position.set(halo.x, halo.y, halo.z);
      const pulse = 1 + 0.12 * Math.sin(performance.now() / 260);
      this.halo.scale.setScalar(halo.r * 3.6 * pulse);
    }

    if (this.options.labels) this.renderLabels();
    else this.labels.clear();
    return busy || (halo || this.particles.count ? 'ambient' : false);
  }

  /** Positions (to the store) and sizes of every unit, e.g. after an animation step. */
  updateMatrices() {
    for (const u of this.units) {
      this.store.set(u.index, u.x, u.y, u.z);
      this.setScale(u);
    }

    this.store.upload();
    for (const mesh of this.meshes) {
      const scale = mesh.geometry.attributes.aScale;
      scale.clearUpdateRanges();
      scale.needsUpdate = true;
    }

    this.stage.invalidate();
  }

  setScale(u) {
    u.mesh.geometry.attributes.aScale.array[u.slot] = u.r * (u.grow ?? 1) * (u === this.hovered ? 1.35 : 1);
  }

  // ------------------------------------------------------------------ colours & highlight

  recolor() {
    for (const u of this.units) this.setUnitColor(u);
    for (const mesh of this.meshes) {
      const colors = mesh.geometry.attributes.aColor;
      colors.clearUpdateRanges();
      colors.needsUpdate = true;
    }

    this.recolorLines();
  }

  setUnitColor(u) {
    const h = this.highlight;
    this.model.colorOf(u.node, this.state?.colorMode ?? 'project', color);
    let factor = u.ghost ? 0.45 : 1;
    if (h) {
      if (h.primary === u.id) factor = 1.25;
      else if (h.nodes.has(u.id)) factor = h.secondary?.has(u.id) ? 1.15 : 1;
      else factor = 0.1;
    } else if (this.hovered === u) factor = 1.3;
    color.multiplyScalar(factor);
    color.toArray(u.mesh.geometry.attributes.aColor.array, u.slot * 3);
  }

  recolorLines() {
    this.links.forEach((l, index) => this.setLinkColor(l, index));
    this.linkMesh.flush();
    this.stage.invalidate();
  }

  /** A link's colour, how bright it is at its source and target, and its width. */
  setLinkColor(l, index) {
    const h = this.highlight;
    const hovered = this.hovered;
    const count = this.links.length;
    const base = count > 4000 ? 0.09 : count > 1500 ? 0.14 : count > 500 ? 0.22 : 0.32;
    const c = linkColor(l);
    let a;
    let b;
    if (h) {
      const on = h.links.has(index);
      a = on ? 1.0 : l.violation ? 0.12 : 0.025;
      b = on ? 0.35 : l.violation ? 0.05 : 0.01;
    } else if (l.violation) {
      // Problems stay visible at rest: they are what these views are about.
      a = 1.0;
      b = 0.45;
    } else if (hovered && (l.s === hovered || l.t === hovered)) {
      a = 1;
      b = 0.35;
    } else {
      const w = Math.min(1, 0.6 + Math.log2(l.weight) * 0.12);
      a = base * w;
      b = base * 0.25 * w;
    }

    // Ribbons with soft edges: highlighted and heavier links are wider, the rest stays a faint thread.
    const on = (h && h.links.has(index)) || (!h && hovered && (l.s === hovered || l.t === hovered));
    const width = (on ? 1.9 : l.violation ? 1.6 : 1.1) * Math.min(1.6, 1 + Math.log2(l.weight) * 0.1);
    const gain = on ? 1 : 0.75;
    this.linkMesh.setStyle(index, c, a * gain, b * gain, width);
  }

  /** highlight: null | { primary, nodes:Set<id>, links:Set<index>, secondary?:Set<id> } */
  setHighlight(highlight) {
    this.highlight = highlight;
    this.halo.visible = !!highlight?.primary && this.byId?.has(highlight.primary);
    if (this.halo.visible) this.halo.material.color.copy(this.model.colorOf(this.model.get(highlight.primary), this.state.colorMode, new Color()));
    this.recolor();
    this.refreshParticles();
  }

  setHovered(id) {
    const unit = id ? this.byId?.get(id) ?? null : null;
    if (unit === this.hovered) return;
    const previous = this.hovered;
    this.hovered = unit;
    // Only the two units (and, without a selection, their links) change: upload just those.
    const restyled = [];
    for (const u of [previous, unit]) {
      if (!u || !u.mesh) continue;
      this.setScale(u);
      this.setUnitColor(u);
      const { aScale, aColor } = u.mesh.geometry.attributes;
      aScale.addUpdateRange(u.slot, 1);
      aScale.needsUpdate = true;
      aColor.addUpdateRange(u.slot * 3, 3);
      aColor.needsUpdate = true;
      if (this.highlight) continue;
      for (const i of u.linkIndices ?? []) {
        this.setLinkColor(this.links[i], i);
        restyled.push(i);
      }
    }

    if (restyled.length) this.linkMesh.flushStyle(restyled);
    if (!this.highlight) this.refreshParticles();
    this.stage.invalidate();
  }

  refreshParticles() {
    const h = this.highlight;
    let selected;
    if (h) selected = this.links.filter((_, i) => h.links.has(i));
    else if (this.hovered) selected = this.links.filter((l) => l.s === this.hovered || l.t === this.hovered);
    else if (this.options.flowAll) selected = this.links;
    else selected = this.links.filter((l) => l.violation);
    // The GPU animates them all; only the budget for very large selections is limited.
    selected = selected.slice(0, 20000);

    this.particles.setPaths(
      selected.map((l) => ({
        source: l.s.index,
        target: l.t.index,
        count: Math.min(4, 1 + Math.floor(Math.log2(l.weight))),
        speed: 0.28 + Math.random() * 0.12,
        color: linkColor(l).clone().multiplyScalar(1.6),
      })),
    );
    this.stage.invalidate();
  }

  // ------------------------------------------------------------------ labels

  renderLabels() {
    const items = [];
    const h = this.highlight;
    const camera = this.stage.camera.position;
    const push = (u, cls, force = false) => {
      const distance = camera.distanceTo(tmp2.set(u.x, u.y, u.z));
      const opacity = force ? 1 : Math.max(0.25, Math.min(1, (u.r * 90) / distance));
      items.push({ text: this.labelText?.(u.node) ?? u.node.name, position: tmp2.clone(), cls, offsetY: 4 + (u.r * 300) / Math.max(distance, 1), opacity, force });
    };

    // Label budgets go to units on screen: zoomed into a big graph, the nearby names still show.
    const { width, height } = this.stage;
    const onScreen = (u) => {
      const p = this.stage.project(tmp2.set(u.x, u.y, u.z), tmp3);
      return p && p.x > -40 && p.y > -20 && p.x < width + 40 && p.y < height + 20;
    };

    if (h?.primary && this.byId.has(h.primary)) push(this.byId.get(h.primary), 'l-selected', true);
    if (this.hovered) push(this.hovered, 'l-selected', true);
    if (h) {
      let shown = 0;
      for (const id of h.nodes) {
        if (shown >= 60) break;
        const u = id !== h.primary && this.byId.get(id);
        if (u && onScreen(u)) {
          push(u, '');
          shown++;
        }
      }
    }

    const budget = h ? 25 : 70;
    let n = 0;
    let scanned = 0;
    for (const u of this.labelOrder) {
      if (n >= budget || scanned++ > 5000) break;
      if (h && !h.nodes.has(u.id)) continue;
      if (!onScreen(u)) continue;
      push(u, u.node.level === 'project' ? 'l-project' : u.node.level === 'namespace' ? 'l-namespace' : '');
      n++;
    }

    items.unshift(...this.extraLabels());
    this.labels.render(items, 140);
  }

  /** Subclasses add fixed labels (e.g. layer names); they win label placement. */
  extraLabels() {
    return [];
  }

  // ------------------------------------------------------------------ interaction

  /**
   * The unit under the pointer: the nearest one whose projected sphere contains it (at least a few pixels
   * wide, so tiny far-away units can still be clicked). Positions come from the units, not the GPU.
   */
  pick(event) {
    const canvas = this.stage.canvas;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const camera = this.stage.camera;
    camera.updateMatrixWorld();
    const m = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).elements;
    const pixelScale = rect.height / 2 / Math.tan((camera.fov * Math.PI) / 360);
    let best = null;
    let bestDepth = Infinity;
    for (const u of this.units) {
      if (!u.mesh?.visible) continue;
      const w = m[3] * u.x + m[7] * u.y + m[11] * u.z + m[15];
      if (w <= camera.near) continue;
      const sx = ((m[0] * u.x + m[4] * u.y + m[8] * u.z + m[12]) / w * 0.5 + 0.5) * rect.width;
      const sy = (-(m[1] * u.x + m[5] * u.y + m[9] * u.z + m[13]) / w * 0.5 + 0.5) * rect.height;
      const radius = Math.max(4, (u.r * (u.grow ?? 1) * (u === this.hovered ? 1.35 : 1) * 1.1 * pixelScale) / w);
      const dx = sx - px;
      const dy = sy - py;
      if (dx * dx + dy * dy <= radius * radius && w < bestDepth) {
        best = u;
        bestDepth = w;
      }
    }

    return best?.id ?? null;
  }

  positionOf(id) {
    const u = this.byId?.get(id);
    return u ? new Vector3(u.x, u.y, u.z) : null;
  }

  focus(id) {
    const u = this.byId?.get(id);
    if (!u) return;
    this.userMoved = true;
    // While the layout is still moving, fly there now and again once it has settled.
    this.pendingFocus = this.settled ? null : id;
    this.stage.focusOn(new Vector3(u.x, u.y, u.z), Math.max(70, u.r * 22));
  }

  fit(animate = true) {
    if (!this.units.length) return;
    const center = new Vector3();
    for (const u of this.units) center.add(tmp.set(u.x, u.y, u.z));
    center.divideScalar(this.units.length);
    let radius = 10;
    for (const u of this.units) radius = Math.max(radius, tmp.set(u.x, u.y, u.z).distanceTo(center) + u.r);
    this.fitSphere(center, radius, animate, 0.95);
  }

  /** Moves the camera so that a sphere fills the view (looking from `fitDirection`). */
  fitSphere(center, radius, animate, tightness) {
    // Fit the narrower of the two fields of view (portrait phones are narrow, not short).
    const vFov = (this.stage.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.stage.camera.aspect);
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * tightness;
    const dir = (this.fitDirection ?? new Vector3(0.35, 0.45, 1)).clone().normalize();
    const position = center.clone().add(dir.multiplyScalar(distance));
    if (animate) this.stage.flyTo(center, position, 1100);
    else this.stage.jumpTo(center, position);
  }

  dispose() {
    this.layout?.stop();
    this.layout = null;
    this.stage.scene.remove(this.group);
    disposeObject(this.group);
    for (const geometry of Object.values(this.geometries ?? {})) geometry.dispose();
    this.store.dispose();
    this.units = [];
    this.links = [];
  }
}

/** A link's base colour (its kind, or red / amber for a problem), computed once. */
export function linkColor(l) {
  return (l.color ??= new Color(l.violation ? VIOLATION_COLORS[l.violation] ?? VIOLATION_COLORS.error : EDGE_KINDS[l.kind]?.color ?? '#9fb3c8'));
}

function labelRank(u) {
  const levelBoost = u.node.level === 'project' ? 1000 : u.node.level === 'namespace' ? 500 : 0;
  return levelBoost + u.r * 10 - (u.ghost ? 100 : 0);
}

function fibonacciSphere(i, n, radius) {
  if (n <= 1) return { x: 0, y: 0, z: 0 };
  const y = 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const theta = Math.PI * (3 - Math.sqrt(5)) * i;
  return { x: Math.cos(theta) * r * radius, y: y * radius * 0.7, z: Math.sin(theta) * r * radius };
}
