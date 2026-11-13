import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  ConeGeometry,
  DodecahedronGeometry,
  BufferGeometry,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  Mesh,
  OctahedronGeometry,
  Sprite,
  TetrahedronGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';
import { EDGE_KINDS, KIND_SHAPES } from '../data/palette.js';
import { unitMaterial } from '../scene/materials.js';
import { LinkMesh } from '../scene/link-mesh.js';
import { GpuParticles, particlesPerLink } from '../scene/particles.js';
import { Coronas } from '../scene/coronas.js';
import { uploadAll, uploadRange } from '../scene/uploads.js';
import { PositionStore } from '../gpu/position-store.js';
import { dotTexture, ringTexture } from '../scene/textures.js';
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


const RADIUS = {
  project: [9, 26],
  namespace: [4.5, 14],
  type: [1.6, 8],
  member: [0.9, 3.4],
};

/** A soft blue ambient, a white key light from above and a blue rim from behind (the stage's shared lights). */
const GALAXY_LIGHTS = {
  ambient: { color: 0x8899cc, intensity: 0.55 },
  sun: { color: 0xffffff, intensity: 1.2, position: new Vector3(300, 500, 400) },
  point: { color: 0x6ea8ff, intensity: 2, position: new Vector3(-400, -200, -300) },
};

/** Edge colours for problems: dependencies against the layering, DI lifetime errors / warnings. */
export const VIOLATION_COLORS = { error: '#ff4545', warning: '#ffb02e', info: '#64b5f6', true: '#ff4545' };

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
    this.options = { flowAll: false, labels: true, autoRotate: false, particles: 1 };
    this.detail = -1;
    // Everything reads unit positions from the store on the GPU: nodes, links and particles.
    this.store = new PositionStore();
    this.material = unitMaterial(this.store, 0.36);
    this.linkMesh = new LinkMesh(this.store);
    this.lines = this.linkMesh.mesh;
    this.particles = new GpuParticles(this.store, { max: 60000, size: 9 });
    this.coronas = new Coronas(this.store);
    // The halo and the shock ring are drawn all the time, transparent while there is no selection: hidden, their
    // shaders would be compiled on the first click – a stall just when the user expects an answer.
    this.halo = new Sprite(new SpriteNodeMaterial({ map: dotTexture(), color: 0xffffff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    this.haloOn = false;
    // The shock wave around a unit when it is selected.
    this.ring = new Sprite(new SpriteNodeMaterial({ map: ringTexture(), color: 0xffffff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    this.wave = null;

    this.group.add(this.lines, this.coronas.sprite, this.particles.points, this.halo, this.ring);
    this.userMoved = false;
    /** Optional (node) => label text; the call-flow view labels methods with their type. */
    this.labelText = null;
    /** Node size multiplier (the call-flow view shows methods, normally the smallest nodes, as the main actors). */
    this.radiusScale = 1;
  }

  activate() {
    this.active = true;
    this.labelKey = null;
    this.stage.scene.add(this.group);
    // The camera showed another view until now: whatever this one builds next is framed (see build()).
    this.builtIds = null;
    this.stage.lights.set(GALAXY_LIGHTS);
    this.stage.setAtmosphere({ background: '#03050b', fog: 0, stars: true });
    this.stage.setBloom(1.1, 0.6, 0.14);
    this.stage.controls.autoRotate = this.options.autoRotate;
    this.stage.controls.autoRotateSpeed = 0.35;
    this.stage.controls.maxPolarAngle = Math.PI;
    this.stage.controls.minDistance = 5;
    this.stage.invalidate();
  }

  deactivate() {
    this.active = false;
    this.stage.scene.remove(this.group);
    this.stage.controls.autoRotate = false;
    this.labels.clear();
    this.labelKey = null;
    this.stage.invalidate();
  }

  setOptions(options) {
    const flowChanged = 'flowAll' in options && options.flowAll !== this.options.flowAll;
    Object.assign(this.options, options);
    this.stage.controls.autoRotate = this.options.autoRotate;
    if (flowChanged && this.links?.length) this.recolorLines(); // the dashes follow
    // A view off screen gets its particles when it is built again.
    if (this.active) this.refreshParticles();
    this.stage.invalidate();
  }

  // ------------------------------------------------------------------ build

  build(units, links, state, ghosts = []) {
    if (this.keepLayout && this.refresh(units, links, state, ghosts)) return;
    this.savePositions();
    const shown = this.builtIds ?? new Set(); // what the last build put on screen
    this.state = state;
    this.hovered = null; // a unit of the old build
    const model = this.model;
    const all = [...units.map((n) => ({ node: n, ghost: false })), ...ghosts.map((n) => ({ node: n, ghost: true }))];
    const byId = new Map();

    let cached = 0;
    let kept = 0;
    this.units = all.map(({ node, ghost }) => {
      if (shown.has(node.id)) kept++;
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
        // A new graph starts as a tight ball and bursts out (the store's unfolding shows it).
        const spread = anchor ? 12 : this.stage.motion === 'off' ? 220 : 40;
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
    this.stage.setBloom(Math.max(0.6, 1.1 - density * 0.25), 0.6, 0.14 + density * 0.06);

    this.buildMeshes();
    this.buildLines();
    this.recolor();
    // Everything new unfolds from where it starts (units that stay glide to their new place).
    if (this.stage.motion !== 'off') this.store.beginIntro();
    else this.store.endIntro();
    this.startSimulation(state, cached / Math.max(1, this.units.length));
    this.labelOrder = [...this.units].sort((a, b) => labelRank(b) - labelRank(a));
    this.setHighlight(null);
    // Mostly units the last build did not show (another level, also one seen before, or the first build since
    // the view came back): a different map, framed now and again once its layout has settled – even if the user
    // had moved the camera on the old one. Moving it from now on keeps it where the user puts it.
    if (kept < this.units.length * 0.5) {
      this.userMoved = false;
      this.fit(false);
    }

    this.builtIds = new Set(this.units.map((u) => u.id));
  }

  /**
   * A map loaded again with the units and links that are on screen (a save that changed no structure): they take
   * the new nodes, sizes, colours and weights where they are. No new layout, nothing unfolds, and the selection
   * and the camera stay. False when anything else changed: then the map is built anew.
   */
  refresh(units, links, state, ghosts = []) {
    const all = [...units.map((n) => ({ node: n, ghost: false })), ...ghosts.map((n) => ({ node: n, ghost: true }))];
    if (!this.builtIds || !this.layout || all.length !== this.units.length || state.level !== this.state?.level) return false;
    const shape = (node) => KIND_SHAPES[node.kind] ?? 'sphere';
    for (let i = 0; i < all.length; i++) {
      const u = this.units[i];
      if (u.id !== all[i].node.id || u.ghost !== all[i].ghost || shape(u.node) !== shape(all[i].node)) return false;
    }

    const shown = links.filter((l) => this.byId.has(l.source) && this.byId.has(l.target));
    if (shown.length !== this.links.length || shown.some((l, i) => l.source !== this.links[i].source || l.target !== this.links[i].target)) return false;
    if (!this.sameArrangement()) return false;

    this.state = state;
    all.forEach(({ node, ghost }, i) => {
      const u = this.units[i];
      u.node = node;
      u.r = this.radiusFor(node, state, ghost);
      this.setScale(u);
    });
    for (const mesh of this.meshes) uploadAll(mesh.geometry.attributes.aScale);
    this.coronas.flushRadii();
    this.links = shown.map((l) => ({ ...l, s: this.byId.get(l.source), t: this.byId.get(l.target) }));
    this.indexUnitLinks();
    this.recolor();
    this.labelOrder = [...this.units].sort((a, b) => labelRank(b) - labelRank(a));
    this.refreshParticles();
    this.stage.invalidate();
    return true;
  }

  /** Whether the units may stay where they are for the data of this build (the layered views: the same layers). */
  sameArrangement() {
    return true;
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
      const shape = KIND_SHAPES[unit.node.kind] ?? 'sphere';
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

    this.coronas.setCount(this.units.length);
    this.updateMatrices();
  }

  buildLines() {
    const links = this.linkMesh;
    links.setCount(this.links.length);
    this.links.forEach((l, i) => links.setEnds(i, l.s.index, l.t.index));
    links.flush();
  }

  startSimulation(state, cachedRatio) {
    this.stopLayout();
    const spec = this.layoutSpec(state, cachedRatio);
    this.layoutStart = performance.now();
    const stage = this.stage;
    this.layout = startLayout(spec, { renderer: stage.renderer, store: this.store, backend: stage.backend, software: stage.software });
    this.settled = false;
    this.pendingFocus = null;
    // A fresh layout in the worker: show it once its first (pre-warmed) frame is back, not the starting cloud –
    // unless it unfolds (then the starting ball is where the show begins).
    this.setLayoutVisible(this.layout.kind !== 'worker' || cachedRatio >= 0.5 || this.store.introRunning);
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

  /**
   * Takes the newest positions of the layout: to the units (labels, picking, camera) and, unless the layout
   * writes the store on the GPU itself, to the GPU in one upload.
   */
  applyLayout() {
    const p = this.layout.positions;
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      u.x = p[i * 3];
      u.y = p[i * 3 + 1];
      u.z = p[i * 3 + 2];
    }

    if (!this.layout.writesStore) {
      this.store.setAll(p, units.length);
      this.store.upload();
    }

    this.moved();
    this.stage.invalidate();
  }

  /** Units changed place: what follows them on screen (labels) is laid out again. */
  moved() {
    this.positionsVersion = (this.positionsVersion ?? 0) + 1;
  }

  stopLayout() {
    this.layout?.stop();
    this.layout?.dispose?.();
    this.layout = null;
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

    // The unfolding of a new layout runs on the GPU clock of the store; labels wait for its end.
    if (this.store.tickIntro()) busy = true;
    if (this.wave) busy = this.advanceWave() || busy;

    const halo = this.haloOn && this.highlight?.primary ? this.byId.get(this.highlight.primary) : null;
    if (halo) {
      this.halo.position.set(halo.x, halo.y, halo.z);
      const pulse = 1 + 0.12 * Math.sin(performance.now() / 260);
      this.halo.scale.setScalar(halo.r * 3.6 * pulse);
    }

    if (this.options.labels && !this.store.introRunning) {
      // Laying the labels out is thousands of projections: only when the camera, the units or the selection moved.
      if (busy || this.labelsChanged()) this.renderLabels();
    } else {
      this.labels.clear();
      this.labelKey = null;
    }

    return busy || (halo || this.particles.count || this.linkMesh.flowing ? 'ambient' : false);
  }

  /** Positions (to the store) and sizes of every unit, e.g. after an animation step. */
  updateMatrices() {
    for (const u of this.units) {
      this.store.set(u.index, u.x, u.y, u.z);
      this.setScale(u);
    }

    this.store.upload();
    for (const mesh of this.meshes) uploadAll(mesh.geometry.attributes.aScale);

    this.coronas.flushRadii();

    this.moved();
    this.stage.invalidate();
  }

  setScale(u) {
    const scale = u.r * (u.grow ?? 1) * (u === this.hovered ? 1.35 : 1);
    u.mesh.geometry.attributes.aScale.array[u.slot] = scale;
    this.coronas.setRadius(u.index, scale);
  }

  // ------------------------------------------------------------------ colours & highlight

  recolor() {
    for (const u of this.units) this.setUnitColor(u);
    for (const mesh of this.meshes) uploadAll(mesh.geometry.attributes.aColor);

    this.coronas.flushColors();
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
    this.coronas.setColor(u.index, color);
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
    // Dashes run along what is in focus (and every link with "flow on all links"), towards the dependency.
    const flow = on ? 1 : !h && l.violation ? 0.8 : !h && this.options.flowAll ? 0.6 : 0;
    this.linkMesh.setStyle(index, c, a * gain, b * gain, width, flow);
  }

  /** highlight: null | { primary, nodes:Set<id>, links:Set<index>, secondary?:Set<id> } */
  setHighlight(highlight) {
    const previous = this.highlight?.primary;
    this.highlight = highlight;
    this.haloOn = !!highlight?.primary && !!this.byId?.has(highlight.primary);
    this.halo.material.opacity = this.haloOn ? 0.4 : 0;
    if (this.haloOn) this.halo.material.color.copy(this.model.colorOf(this.model.get(highlight.primary), this.state.colorMode, new Color()));
    if (highlight?.primary !== previous || !highlight) this.startWave(highlight);
    this.recolor();
    this.refreshParticles();
  }

  /**
   * A wave of light from a newly selected unit: out along the highlighted links, hop after hop (each unit
   * flares as it arrives), with a shock ring around the unit itself.
   */
  startWave(highlight) {
    const primary = highlight?.primary && this.byId?.get(highlight.primary);
    this.linkMesh.clearWaves();
    if (!primary || this.stage.motion === 'off') {
      this.wave = null;
      this.ring.material.opacity = 0;
      this.linkMesh.waveFront.value = this.coronas.waveFront.value = -100;
      this.coronas.setHops(null);
      return;
    }

    // Hops from the selection over the highlighted links.
    const hops = new Map([[primary, 0]]);
    const queue = [primary];
    for (let k = 0; k < queue.length; k++) {
      const u = queue[k];
      for (const i of u.linkIndices ?? []) {
        if (!highlight.links.has(i)) continue;
        const l = this.links[i];
        const other = l.s === u ? l.t : l.s;
        if (!hops.has(other)) {
          hops.set(other, hops.get(u) + 1);
          queue.push(other);
        }
      }
    }

    let max = 0;
    for (const i of highlight.links) {
      const l = this.links[i];
      if (!l || !hops.has(l.s) || !hops.has(l.t)) continue;
      this.linkMesh.setWave(i, hops.get(l.s), hops.get(l.t));
      max = Math.max(max, hops.get(l.s), hops.get(l.t));
    }

    this.coronas.setHops(new Map([...hops].map(([u, hop]) => [u.index, hop])));
    this.wave = { start: performance.now(), max, unit: primary };
    this.ring.material.color.copy(this.model.colorOf(primary.node, this.state.colorMode, new Color()));
    this.advanceWave();
  }

  /** Moves the wave and the shock ring on; false once both are over. */
  advanceWave() {
    const wave = this.wave;
    const t = (performance.now() - wave.start) / 1000;
    const front = t * WAVE_SPEED - 0.3;
    const ring = Math.min(1, t / RING_SECONDS);
    const u = wave.unit;
    this.ring.position.set(u.x, u.y, u.z);
    this.ring.scale.setScalar(u.r * (2 + 16 * (1 - (1 - ring) ** 2)));
    this.ring.material.opacity = 0.9 * (1 - ring);
    if (front > wave.max + 1.5 && ring >= 1) {
      this.wave = null;
      this.ring.material.opacity = 0;
      this.linkMesh.waveFront.value = this.coronas.waveFront.value = -100;
      return false;
    }

    this.linkMesh.waveFront.value = this.coronas.waveFront.value = front;
    return true;
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
      uploadRange(aScale, u.slot, 1);
      uploadRange(aColor, u.slot * 3, 3);
      this.coronas.flushColors([u.index]);
      this.coronas.flushRadii([u.index]);
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
    let calm = []; // the quiet flow of a living map at rest
    const byIndex = (indices) => [...indices].sort((a, b) => a - b).map((i) => this.links[i]).filter(Boolean);
    if (h) selected = byIndex(h.links);
    else if (this.hovered) selected = byIndex(new Set(this.hovered.linkIndices ?? []));
    else if (this.options.flowAll) selected = this.links;
    else {
      selected = this.violations();
      if (this.stage.motion === 'living') calm = this.calmPaths(this.options.particles);
    }

    // The GPU animates them all; only the budget for very large selections is limited.
    selected = selected.slice(0, 20000);
    const density = this.options.particles;
    const paths = density > 0 ? selected.map((l) => ({
      source: l.s.index,
      target: l.t.index,
      count: particlesPerLink(Math.min(4, 1 + Math.floor(Math.log2(l.weight))), density),
      speed: 0.28 + Math.random() * 0.12,
      color: linkColor(l).clone().multiplyScalar(1.8),
    })) : [];
    if (density > 0) paths.push(...calm);
    this.particles.setPaths(paths);
    this.stage.invalidate();
  }

  /** The links that are problems (they always flow); kept per build. */
  violations() {
    if (this.violating?.links !== this.links) this.violating = { links: this.links, list: this.links.filter((l) => l.violation) };
    return this.violating.list;
  }

  /**
   * The quiet flow of a living map at rest, along its heaviest links. Kept per build, with each path's speed and
   * phase: hovering a unit and leaving it brings the same flow back, not one that jumps.
   */
  calmPaths(density) {
    if (this.calm?.links !== this.links || this.calm.density !== density) {
      const paths = density > 0 ? this.strongestLinks().filter((l) => !l.violation).map((l) => ({
        source: l.s.index,
        target: l.t.index,
        count: particlesPerLink(1, density),
        speed: 0.12 + Math.random() * 0.08,
        phase: Math.random(),
        color: linkColor(l).clone().multiplyScalar(1.5),
      })) : [];
      this.calm = { links: this.links, density, paths };
    }

    return this.calm.paths;
  }

  /** The heaviest links (about the top 12%, at most 1500), for the quiet flow at rest; kept per build. */
  strongestLinks() {
    if (this.strongest?.links === this.links) return this.strongest.list;
    const list = [...this.links].sort((a, b) => b.weight - a.weight).slice(0, Math.min(1500, Math.ceil(this.links.length * 0.12)));
    this.strongest = { links: this.links, list };
    return list;
  }

  // ------------------------------------------------------------------ labels

  /** Whether anything the labels depend on changed since they were last laid out (and remembers the new state). */
  labelsChanged() {
    const stage = this.stage;
    if (stage.stereo) return true; // per eye, with the head's movement
    const { position, quaternion, fov, aspect } = stage.camera;
    const key = [
      position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w, fov, aspect,
      stage.width, stage.height, this.positionsVersion, this.highlight, this.hovered, this.labelOrder, this.labelText,
    ];
    const last = this.labelKey;
    if (last && key.every((value, i) => value === last[i])) return false;
    this.labelKey = key;
    return true;
  }

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
  /**
   * AR reticle: the unit closest in angle to a ray (the middle of the view), within its own apparent size
   * (at least MIN_PICK_ANGLE). Positions on the CPU, one pass: fine for a click or a few times a second.
   */
  pickAlong({ origin, direction }) {
    let best = null;
    let bestScore = Infinity;
    const minAngle = (MIN_PICK_ANGLE * Math.PI) / 180;
    for (const u of this.units) {
      const dx = u.x - origin.x;
      const dy = u.y - origin.y;
      const dz = u.z - origin.z;
      const along = dx * direction.x + dy * direction.y + dz * direction.z;
      if (along <= 0) continue;
      const distance = Math.hypot(dx, dy, dz);
      const angle = Math.acos(Math.min(1, along / distance));
      const reach = Math.max(minAngle, Math.atan(u.r / distance));
      const score = angle / reach;
      if (score <= 1 && score < bestScore) {
        best = u;
        bestScore = score;
      }
    }

    return best?.id ?? null;
  }

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

  /**
   * Moves the camera so that a sphere fills the view (looking from `fitDirection`). AR glasses: the map is
   * set at the chosen size and distance in the room instead (see Stage.arFit).
   */
  fitSphere(center, radius, animate, tightness) {
    // Fit the narrower of the two fields of view (portrait phones are narrow, not short).
    const vFov = (this.stage.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.stage.camera.aspect);
    const distance = this.stage.stereo ? this.stage.arFit(radius) : (radius / Math.sin(Math.min(vFov, hFov) / 2)) * tightness;
    const dir = (this.fitDirection ?? new Vector3(0.35, 0.45, 1)).clone().normalize();
    const position = center.clone().add(dir.multiplyScalar(distance));
    if (animate) this.stage.flyTo(center, position, 1100);
    else this.stage.jumpTo(center, position);
  }

  dispose() {
    this.stopLayout();
    this.stage.scene.remove(this.group);
    disposeObject(this.group);
    for (const geometry of Object.values(this.geometries ?? {})) geometry.dispose();
    this.store.dispose();
    this.units = [];
    this.links = [];
  }
}

/** The AR reticle reaches units within this angle (degrees) of the middle of the view, or their size. */
const MIN_PICK_ANGLE = 1.5;

/** The selection wave: hops per second, and how long the shock ring takes to spread and fade. */
const WAVE_SPEED = 1.6;
const RING_SECONDS = 1.1;

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
