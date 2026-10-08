import { Vector3 } from 'three';
import { GalaxyView } from './galaxy.js';

/** On-screen radius (px) above which a cluster opens, and the (smaller) one below which it closes again. */
const OPEN = { project: 150, namespace: 105, type: 95 };
const CLOSE = { project: 110, namespace: 72, type: 68 };
/** Members of neighbouring types would overlap: only the types closest to the camera open. */
const MAX_OPEN_TYPES = 3;
const ANIMATION_MS = 480;
const KIND_ORDER = { constructor: 0, method: 1, property: 2, field: 3, event: 4 };

const tmp = new Vector3();
const lastCamera = new Vector3();
const lastTarget = new Vector3();

/**
 * Semantic zoom: one force layout of every type, shown at the level of detail the camera distance calls
 * for. Far away a namespace is a single star at the centre of its types; fly into it and it opens into the
 * types, fly into a type and its members appear around it. Nothing is laid out again, so the map stays
 * where it was: clusters simply open and close.
 */
export class ZoomView extends GalaxyView {
  constructor(stage, model, labels) {
    super(stage, model, labels);
    this.semantic = false;
    this.open = new Set();
    this.onUnitsChanged = null;
  }

  /** units / links: every visible type of the solution and the links between them (the base layout). */
  build(units, links, state) {
    this.savePositions(); // the base layout if it is on screen, not the opened clusters
    this.units = [];
    this.semantic = false;
    this.open = new Set();
    super.build(units, links, state, []);
  }

  savePositions() {
    if (!this.semantic) super.savePositions();
  }

  update(dt) {
    const result = super.update(dt);
    if (!this.semantic) {
      if (this.settled) this.enterSemantic();
      return result || this.semantic; // one more frame to show the opened clusters
    }

    let busy = !!this.animation;
    if (this.animation) this.animate();
    const now = performance.now();
    const camera = this.stage.camera;
    const moved = camera.position.distanceToSquared(lastCamera) > 1e-4 || this.stage.controls.target.distanceToSquared(lastTarget) > 1e-4;
    if (moved) {
      if (now - (this.lastEvaluation ?? 0) > 110) {
        lastCamera.copy(camera.position);
        lastTarget.copy(this.stage.controls.target);
        this.lastEvaluation = now;
        this.evaluate();
      } else busy = true; // evaluate again once the camera has come to rest
    }

    return busy || !!this.animation || result;
  }

  /** Members sit on a small sphere around their type: keep them smaller than in the members level. */
  radiusFor(node, state, ghost = false) {
    return super.radiusFor(node, state, ghost) * (node.level === 'member' ? 0.6 : 1);
  }

  // ------------------------------------------------------------------ hierarchy

  enterSemantic() {
    this.semantic = true;
    this.buildHierarchy();
    this.evaluate(true);
  }

  /** Containers (project → namespace → type → members) over the laid-out types, with centres and extents. */
  buildHierarchy() {
    const model = this.model;
    this.kids = new Map();
    this.info = new Map();
    this.memberLayout = new Map();
    const roots = new Set();
    const add = (parent, child) => {
      if (!this.kids.has(parent)) this.kids.set(parent, new Set());
      this.kids.get(parent).add(child);
    };

    const typesOf = new Map(); // container -> laid-out types inside it
    for (const u of this.units) {
      const type = u.node;
      this.info.set(type.id, { x: u.x, y: u.y, z: u.z, r: u.r, extent: u.r });
      const namespace = type.external ? null : type.namespaceNode;
      const project = type.external ? null : type.projectNode?.kind === 'project' ? type.projectNode : null;
      if (namespace) add(namespace.id, type.id);
      if (project) add(project.id, namespace ? namespace.id : type.id);
      roots.add(project?.id ?? namespace?.id ?? type.id);
      for (const container of [namespace, project]) {
        if (!container) continue;
        if (!typesOf.has(container.id)) typesOf.set(container.id, []);
        typesOf.get(container.id).push(u);
      }
    }

    for (const [id, types] of typesOf) {
      const center = new Vector3();
      let weight = 0;
      for (const u of types) {
        center.add(tmp.set(u.x, u.y, u.z).multiplyScalar(u.r));
        weight += u.r;
      }

      center.divideScalar(weight || 1);
      let extent = 0;
      for (const u of types) extent = Math.max(extent, tmp.set(u.x, u.y, u.z).distanceTo(center) + u.r);
      this.info.set(id, { x: center.x, y: center.y, z: center.z, r: this.radiusFor(model.get(id), this.state), extent });
    }

    this.roots = [...roots].sort();
  }

  /** What a container opens into: namespaces of a project, types of a namespace, members of a type. */
  kidsOf(node) {
    if (node.level === 'type') return this.membersOf(node).map((m) => m.id);
    return [...(this.kids.get(node.id) ?? [])];
  }

  membersOf(type) {
    let layout = this.memberLayout.get(type.id);
    if (layout) return layout.members;
    const state = this.state;
    const members = this.model
      .childrenOf(type.id)
      .filter((m) => m.level === 'member' && (state.showTests || !m.isTest))
      .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name));
    // Members on a sphere around their type (a golden spiral keeps the kinds together).
    const center = this.info.get(type.id);
    const radius = center.r * 1.15 + 1.7 * Math.sqrt(members.length) + 2;
    const positions = new Map();
    members.forEach((m, i) => {
      const y = members.length === 1 ? 0 : 1 - (i / (members.length - 1)) * 2;
      const ring = Math.sqrt(1 - y * y);
      const theta = Math.PI * (3 - Math.sqrt(5)) * i;
      positions.set(m.id, { x: center.x + Math.cos(theta) * ring * radius, y: center.y + y * radius, z: center.z + Math.sin(theta) * ring * radius });
    });
    layout = { members, positions, extent: radius + 2 };
    this.memberLayout.set(type.id, layout);
    return members;
  }

  /** Centre and extent of a node in the base layout (members: on their type's sphere). */
  infoOf(node) {
    if (node.level === 'type') {
      const info = this.info.get(node.id);
      if (!info) return null;
      const layout = this.memberLayout.get(node.id);
      return layout ? { ...info, extent: layout.extent } : info;
    }

    if (node.level === 'member') {
      const type = node.typeNode;
      if (!type || !this.info.has(type.id)) return null;
      this.membersOf(type);
      const p = this.memberLayout.get(type.id).positions.get(node.id);
      return p ? { ...p, r: this.radiusFor(node, this.state), extent: 1 } : null;
    }

    return this.info.get(node.id) ?? null;
  }

  // ------------------------------------------------------------------ level of detail

  /** Pixels per world unit at distance 1 from the camera. */
  get pixelScale() {
    return this.stage.height / 2 / Math.tan((this.stage.camera.fov * Math.PI) / 360);
  }

  screenRadius(info) {
    const distance = this.stage.camera.position.distanceTo(tmp.set(info.x, info.y, info.z));
    if (distance <= info.extent) return Infinity;
    return (info.extent * this.pixelScale) / distance;
  }

  onScreen(info, radiusPx) {
    if (radiusPx === Infinity) return true;
    tmp.set(info.x, info.y, info.z).project(this.stage.camera);
    if (tmp.z > 1) return false; // behind the camera
    const x = ((tmp.x + 1) / 2) * this.stage.width;
    const y = ((1 - tmp.y) / 2) * this.stage.height;
    return x + radiusPx > 0 && x - radiusPx < this.stage.width && y + radiusPx > 0 && y - radiusPx < this.stage.height;
  }

  evaluate(force = false) {
    if (!this.semantic) return;
    const model = this.model;
    const open = new Set();
    const list = [];
    const candidates = [];
    const visit = (id) => {
      const node = model.get(id);
      const info = node && this.infoOf(node);
      if (!info) return;
      if (node.level !== 'member') {
        const kids = this.kidsOf(node);
        if (kids.length) {
          const wasOpen = this.open.has(id);
          const px = this.screenRadius(node.level === 'type' ? { ...info, extent: this.memberLayout.get(id)?.extent ?? info.extent } : info);
          if (px > (wasOpen ? CLOSE[node.level] : OPEN[node.level]) && this.onScreen(info, px)) {
            if (node.level === 'type') {
              // decided below, once every candidate is known
              const entry = { id, ghost: false, kids, score: px * (wasOpen ? 1.25 : 1) };
              candidates.push(entry);
              list.push(entry);
              return;
            }

            open.add(id);
            for (const kid of kids) visit(kid);
            return;
          }
        }
      }

      list.push({ id, ghost: false });
    };

    for (const root of this.roots) visit(root);
    candidates.sort((a, b) => b.score - a.score);
    for (const entry of candidates.slice(0, MAX_OPEN_TYPES)) {
      open.add(entry.id);
      entry.ghost = true;
    }

    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry.ghost && entry.kids) list.splice(i + 1, 0, ...entry.kids.map((kid) => ({ id: kid, ghost: false })));
    }

    if (!force && open.size === this.open.size && [...open].every((id) => this.open.has(id))) return;
    this.open = open;
    this.show(list);
  }

  /** Swaps in a new set of units: newcomers fly out of (or into) their relatives, the rest stay put. */
  show(list) {
    const model = this.model;
    const previous = this.byId ?? new Map();
    const state = this.state;
    const now = performance.now();
    const nearestShown = (node) => {
      for (let n = node.parent ? model.get(node.parent) : null; n; n = n.parent ? model.get(n.parent) : null) if (previous.has(n.id)) return previous.get(n.id);
      return null;
    };

    this.units = list.map(({ id, ghost }) => {
      const node = model.get(id);
      const info = this.infoOf(node);
      const unit = { id, node, ghost, r: this.radiusFor(node, state, ghost), tx: info.x, ty: info.y, tz: info.z };
      const old = previous.get(id);
      // A child opening out of its parent starts at the parent; a parent closing over its children grows in place.
      const from = old ?? nearestShown(node) ?? info;
      unit.fx0 = from.x;
      unit.fy0 = from.y;
      unit.fz0 = from.z;
      unit.x = from.x;
      unit.y = from.y;
      unit.z = from.z;
      unit.grow = old ? 1 : 0.25;
      unit.grow0 = unit.grow;
      return unit;
    });
    this.byId = new Map(this.units.map((u) => [u.id, u]));
    this.links = model
      .aggregateMixed(new Set(this.units.map((u) => u.id)), state)
      .map((l) => ({ ...l, s: this.byId.get(l.source), t: this.byId.get(l.target) }));
    this.indexUnitLinks();

    this.hovered = null;
    this.buildMeshes();
    this.buildLines();
    this.recolor();
    this.labelOrder = [...this.units].sort((a, b) => rank(b) - rank(a));
    this.animation = { start: now };
    this.animate();
    this.refreshParticles();
    this.onUnitsChanged?.();
    this.stage.invalidate();
  }

  animate() {
    const t = Math.min(1, (performance.now() - this.animation.start) / ANIMATION_MS);
    const e = 1 - Math.pow(1 - t, 3);
    for (const u of this.units) {
      u.x = u.fx0 + (u.tx - u.fx0) * e;
      u.y = u.fy0 + (u.ty - u.fy0) * e;
      u.z = u.fz0 + (u.tz - u.fz0) * e;
      u.grow = u.grow0 + (1 - u.grow0) * e;
    }

    this.updateMatrices();
    if (t >= 1) this.animation = null;
  }

  // ------------------------------------------------------------------ navigation

  /** Camera distance at which the container holding `node` is open (so the node itself is on screen). */
  distanceToShow(node) {
    const parent = node.level === 'member' ? node.typeNode : node.level === 'type' ? node.namespaceNode ?? node.projectNode : node.level === 'namespace' ? node.projectNode : null;
    const info = parent && this.infoOf(parent);
    if (!info || !OPEN[parent.level]) return 120;
    if (parent.level === 'type') this.membersOf(parent);
    const extent = parent.level === 'type' ? this.memberLayout.get(parent.id).extent : info.extent;
    return Math.max(18, (extent * this.pixelScale) / (OPEN[parent.level] * 1.6));
  }

  /** Flies to a node close enough for every container around it to open. */
  reveal(id) {
    const node = this.model.get(id);
    const info = node && this.infoOf(node);
    if (!info) return false;
    this.userMoved = true;
    this.stage.focusOn(new Vector3(info.x, info.y, info.z), this.distanceToShow(node), 1000);
    return true;
  }

  /** Double click: fly in until the node opens. */
  zoomInto(id) {
    const node = this.model.get(id);
    const info = node && this.infoOf(node);
    if (!info) return;
    if (node.level === 'type') this.membersOf(node);
    const extent = node.level === 'type' ? this.memberLayout.get(id)?.extent ?? info.extent : info.extent;
    const threshold = OPEN[node.level];
    const distance = threshold ? Math.max(12, (extent * this.pixelScale) / (threshold * (node.level === 'type' ? 1.7 : 1.5))) : 30;
    this.userMoved = true;
    this.stage.focusOn(new Vector3(info.x, info.y, info.z), distance, 900);
  }

  focus(id) {
    const u = this.byId?.get(id);
    if (!u) return this.reveal(id);
    this.userMoved = true;
    this.pendingFocus = null;
    this.stage.focusOn(new Vector3(u.tx ?? u.x, u.ty ?? u.y, u.tz ?? u.z), Math.max(40, u.r * 16));
  }

  /** Names of the open clusters float above them, so you know where you are. */
  extraLabels() {
    if (!this.semantic || !this.options.labels) return [];
    const items = [];
    for (const id of this.open) {
      const node = this.model.get(id);
      const info = node && this.infoOf(node);
      if (!info) continue;
      const extent = node.level === 'type' ? this.memberLayout.get(id)?.extent ?? info.extent : info.extent;
      items.push({
        text: node.name,
        position: new Vector3(info.x, info.y + extent * 0.85, info.z),
        cls: node.level === 'project' ? 'l-project' : node.level === 'namespace' ? 'l-district' : 'l-selected',
        force: node.level === 'type',
        offsetY: 0,
        opacity: 0.9,
      });
    }

    return items;
  }
}

function rank(u) {
  const level = u.node.level === 'project' ? 1000 : u.node.level === 'namespace' ? 500 : u.node.level === 'type' ? 100 : 0;
  return level + u.r * 10 - (u.ghost ? 1000 : 0);
}
