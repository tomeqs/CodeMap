import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { columnMaterial } from '../scene/materials.js';
import { uploadAll } from '../scene/uploads.js';
import { disposeObject } from '../scene/disposer.js';
import { instances } from '../scene/instances.js';
import { VIOLATION_COLORS } from './galaxy.js';
import { shortNamespace } from './city.js';

/** World units per row / column. */
const CELL = 10;
const TILE = 0.84; // footprint of a diagonal tile, as a share of the cell
const COLUMN = 0.62; // footprint of a dependency column
const CYCLE_COLOR = '#ff8a3d';
const GUIDE_COLOR = '#8fb8ff';
/** A dependency's colour, from a few references (dim blue) to many (bright cyan); red: against the layers. */
const CELL_LOW = new Color('#2f5fa8');
const CELL_HIGH = new Color('#8ae9ff');

const matrix = new Matrix4();
const color = new Color();

/**
 * Dependency structure matrix in 3D: the units on both axes (rows from the far edge towards you, columns from
 * left to right, in the order of data/matrix.js), one tile per unit on the diagonal, and a column in cell
 * (row, column) when the row uses the column: the taller, the more dependencies. Layers are bands along the
 * diagonal, cycles framed blocks; dependencies against the layers stand above the diagonal, in red.
 */
export class MatrixView {
  constructor(stage, model, labels) {
    this.stage = stage;
    this.model = model;
    this.labels = labels;
    this.group = new Group();
    this.units = [];
    this.links = [];
    this.cells = [];
    this.highlight = null;
    this.hovered = null;
    this.hoveredCell = null;
    this.options = { labels: true };

    this.box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.flat = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.tileMaterial = columnMaterial(0.42);
    this.cellMaterial = columnMaterial(0.3);
    this.bandMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false });
    this.frameMaterial = new MeshBasicMaterial({ color: 0xffffff });
    this.guideMaterial = new MeshBasicMaterial({ color: GUIDE_COLOR, transparent: true, opacity: 0.1, depthWrite: false });
    this.gridMaterial = new LineBasicMaterial({ color: '#1d2742', transparent: true, opacity: 0.85 });

    this.ground = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ color: '#070b16', roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    // The sun is the stage's shared light; it stands where the last build put it.
    this.sunPosition = new Vector3(0, 1, 0);
    this.guides = new InstancedMesh(this.flat, this.guideMaterial, 4);
    this.guides.count = 0;
    this.guides.renderOrder = 2;
    this.group.add(this.ground, this.guides);
  }

  activate() {
    this.stage.scene.add(this.group);
    this.active = true;
    this.applyLights();
    this.stage.setAtmosphere({ background: '#05070f', fog: 0, stars: true, nebula: 0.35 });
    this.stage.setBloom(0.7, 0.45, 0.35);
    this.stage.controls.maxPolarAngle = Math.PI * 0.49;
    this.stage.controls.minDistance = 8;
    this.stage.invalidate();
  }

  /** Sky and ground light, a little ambient and a sun over the grid. */
  applyLights() {
    this.stage.lights.set({
      hemisphere: { sky: 0x8fb4ff, ground: 0x0b0f1a, intensity: 0.9 },
      ambient: { color: 0x404a66, intensity: 0.6 },
      sun: { color: 0xc8d8ff, intensity: 1.4, position: this.sunPosition },
    });
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
    this.stage.invalidate();
  }

  // ------------------------------------------------------------------ build

  /** `layout`: buildMatrix(units, links, layering) from data/matrix.js. */
  build(units, links, state, layout) {
    this.state = state;
    this.layout = layout;
    this.links = links;
    const n = layout.order.length;
    const size = Math.max(1, n) * CELL;
    const half = size / 2;
    this.size = size;
    this.half = half;
    const at = (i) => -half + (i + 0.5) * CELL;
    this.at = at;

    // ---------------------------------------------------------------- the units, on the diagonal
    this.tileMesh = this.replaceMesh(this.tileMesh, this.box, this.tileMaterial, n);
    this.byId = new Map();
    this.units = layout.order.map((node, i) => {
      // Low: the tiles name the rows and columns; the dependencies are what stands out.
      const height = 1 + this.model.norm(node, state.sizeMetric ?? 'loc') * CELL * 0.7;
      const unit = { id: node.id, node, index: i, x: at(i), z: at(i), w: CELL * TILE, d: CELL * TILE, base: 0, height, top: height };
      this.byId.set(node.id, unit);
      return unit;
    });

    for (const u of this.units) {
      matrix.makeScale(u.w, u.height, u.d);
      matrix.setPosition(u.x, 0, u.z);
      this.tileMesh.setMatrixAt(u.index, matrix);
    }

    // ---------------------------------------------------------------- the dependencies
    let maxWeight = 1;
    for (const c of layout.cells) if (c.weight > maxWeight) maxWeight = c.weight;
    const linear = state.matrixHeight === 'linear';
    this.cellMesh = this.replaceMesh(this.cellMesh, this.box, this.cellMaterial, layout.cells.length);
    this.cells = layout.cells.map((c, i) => {
      const t = linear ? c.weight / maxWeight : Math.log1p(c.weight) / Math.log1p(maxWeight);
      // A dependency against the layers stands out, however few references it has.
      const height = Math.max(0.8 + t * CELL * 2.6, c.upward ? CELL * 1.8 : 0);
      matrix.makeScale(CELL * COLUMN, height, CELL * COLUMN);
      matrix.setPosition(at(c.col), 0, at(c.row));
      this.cellMesh.setMatrixAt(i, matrix);
      return { ...c, index: i, x: at(c.col), z: at(c.row), height, strength: t, source: c.link.source, target: c.link.target };
    });

    for (const mesh of [this.tileMesh, this.cellMesh]) {
      uploadAll(mesh.instanceMatrix);
      mesh.computeBoundingSphere();
    }

    // ---------------------------------------------------------------- layers, cycles, grid
    const levels = layout.levels;
    this.bandMesh = this.replaceMesh(this.bandMesh, this.flat, this.bandMaterial, levels.length);
    this.bandMesh.renderOrder = 1;
    levels.forEach((band, i) => {
      const span = (band.to - band.from + 1) * CELL;
      const center = (at(band.from) + at(band.to)) / 2;
      matrix.makeScale(span, 1, span);
      matrix.setPosition(center, 0.02, center);
      this.bandMesh.setMatrixAt(i, matrix);
      this.bandMesh.setColorAt(i, color.set(layerColor(i, levels.length)));
    });
    uploadAll(this.bandMesh.instanceMatrix);
    if (this.bandMesh.instanceColor) uploadAll(this.bandMesh.instanceColor);
    this.bandMesh.computeBoundingSphere();

    const blocks = layout.blocks;
    this.frameMesh = this.replaceMesh(this.frameMesh, this.box, this.frameMaterial, blocks.length * 4);
    const thick = CELL * 0.08;
    blocks.forEach((b, i) => {
      const from = at(b.from) - CELL / 2;
      const to = at(b.to) + CELL / 2;
      const span = to - from;
      const mid = (from + to) / 2;
      const sides = [
        [mid, from, span + thick, thick],
        [mid, to, span + thick, thick],
        [from, mid, thick, span],
        [to, mid, thick, span],
      ];
      sides.forEach(([x, z, w, d], k) => {
        matrix.makeScale(w, CELL * 0.12, d);
        matrix.setPosition(x, 0, z);
        this.frameMesh.setMatrixAt(i * 4 + k, matrix);
        this.frameMesh.setColorAt(i * 4 + k, color.set(CYCLE_COLOR).multiplyScalar(1.6));
      });
    });
    uploadAll(this.frameMesh.instanceMatrix);
    if (this.frameMesh.instanceColor) uploadAll(this.frameMesh.instanceColor);
    this.frameMesh.computeBoundingSphere();

    this.group.remove(this.grid);
    this.grid?.geometry.dispose();
    const step = n <= 200 ? 1 : 5;
    const lines = [];
    for (let k = 0; k <= n; k += step) {
      const p = -half + k * CELL;
      lines.push(p, 0.01, -half, p, 0.01, half, -half, 0.01, p, half, 0.01, p);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(lines, 3));
    this.grid = new LineSegments(geometry, this.gridMaterial);
    this.group.add(this.grid);

    this.ground.scale.set(size * 1.6 + 200, size * 1.6 + 200, 1);
    this.ground.position.y = -0.05;
    this.sunPosition.set(size * 0.4, size * 1.2, size * 0.8);
    if (this.active) this.applyLights();

    this.labelOrder = [...this.units].sort((a, b) => b.height - a.height);
    this.hovered = null;
    this.hoveredCell = null;
    this.setHighlight(null);
    if (!this.keepCamera) this.fit(false);
    // The columns grow out of the grid, one after another.
    this.riseStart = this.stage.motion === 'off' ? null : performance.now();
    const rise = this.riseStart === null ? 1e6 : 0;
    this.tileMaterial.userData.rise.value = rise;
    this.cellMaterial.userData.rise.value = rise;
  }

  /** An instanced mesh of `count` instances: the old one while it has room (see instances()). */
  replaceMesh(old, geometry, material, count) {
    return instances(this.group, old, geometry, material, count);
  }

  // ------------------------------------------------------------------ colour and highlight

  recolor() {
    const h = this.highlight;
    const hovered = this.hovered;
    for (const u of this.units) {
      this.model.colorOf(u.node, this.state?.colorMode ?? 'project', color);
      let factor = 0.9;
      if (h) factor = h.primary === u.id ? 1.6 : h.nodes.has(u.id) ? 1.15 : 0.22;
      else if (u === hovered) factor = 1.45;
      else if (this.hoveredCell && (this.hoveredCell.row === u.index || this.hoveredCell.col === u.index)) factor = 1.3;
      this.tileMesh.setColorAt(u.index, color.multiplyScalar(factor));
    }

    for (const c of this.cells) {
      if (c.upward) color.set(VIOLATION_COLORS.error);
      else color.copy(CELL_LOW).lerp(CELL_HIGH, c.strength);
      let factor = c.upward ? 1.8 : 0.95;
      if (h) factor *= h.links.has(c.linkIndex) ? 1.45 : 0.14;
      else if (this.hoveredCell) factor *= c === this.hoveredCell ? 1.7 : c.row === this.hoveredCell.row || c.col === this.hoveredCell.col ? 1 : 0.45;
      else if (hovered) factor *= c.source === hovered.id || c.target === hovered.id ? 1.4 : 0.4;
      this.cellMesh.setColorAt(c.index, color.multiplyScalar(factor));
    }

    for (const mesh of [this.tileMesh, this.cellMesh]) if (mesh?.instanceColor) uploadAll(mesh.instanceColor);
    this.updateGuides();
    this.stage.invalidate();
  }

  /** Light strips across the row and column of the selected unit, or of the cell under the pointer. */
  updateGuides() {
    const rows = [];
    const cols = [];
    const primary = this.highlight?.primary && this.byId.get(this.highlight.primary);
    if (primary) rows.push(primary.index), cols.push(primary.index);
    else if (this.hoveredCell) rows.push(this.hoveredCell.row), cols.push(this.hoveredCell.col);
    else if (this.hovered) rows.push(this.hovered.index), cols.push(this.hovered.index);

    let k = 0;
    for (const i of rows) {
      matrix.makeScale(this.size, 1, CELL);
      matrix.setPosition(0, 0.04, this.at(i));
      this.guides.setMatrixAt(k++, matrix);
    }

    for (const j of cols) {
      matrix.makeScale(CELL, 1, this.size);
      matrix.setPosition(this.at(j), 0.04, 0);
      this.guides.setMatrixAt(k++, matrix);
    }

    this.guides.count = k;
    uploadAll(this.guides.instanceMatrix);
  }

  setHighlight(highlight) {
    this.highlight = highlight;
    this.recolor();
  }

  setHovered(id) {
    const unit = id ? this.byId?.get(id) ?? null : null;
    if (unit === this.hovered && !this.hoveredCell) return;
    this.hovered = unit;
    this.hoveredCell = null;
    this.recolor();
  }

  /** The dependency under the pointer (null: none); its row and column light up. */
  setHoveredCell(cell) {
    if (cell === this.hoveredCell) return;
    this.hoveredCell = cell;
    if (cell) this.hovered = null;
    this.recolor();
  }

  // ------------------------------------------------------------------ frame

  update() {
    let rising = false;
    if (this.riseStart !== null && this.riseStart !== undefined) {
      const t = (performance.now() - this.riseStart) / 1000;
      rising = t < 2;
      const rise = rising ? t : 1e6;
      this.tileMaterial.userData.rise.value = rise;
      this.cellMaterial.userData.rise.value = rise;
      if (!rising) this.riseStart = null;
    }

    if (this.options.labels && !rising) this.renderLabels();
    else this.labels.clear();
    return rising;
  }

  renderLabels() {
    const items = [];
    const h = this.highlight;
    const name = (u) => (u.node.kind === 'namespace' ? shortNamespace(u.node.name) : u.node.name);
    const tile = (u, cls, force) => items.push({ text: name(u), position: new Vector3(u.x, u.top + 0.5, u.z), cls, force, offsetY: 4 });
    const row = (u, cls, force) =>
      items.push({ text: name(u), position: new Vector3(-this.half - CELL * 0.3, 0.3, u.z), cls, force, align: 'right', offsetY: -7 });

    const primary = h?.primary && this.byId.get(h.primary);
    if (primary) tile(primary, 'l-selected', true), row(primary, 'l-selected', true);
    if (this.hovered) tile(this.hovered, 'l-selected', true), row(this.hovered, 'l-selected', true);
    if (this.hoveredCell) {
      row(this.units[this.hoveredCell.row], 'l-selected', true);
      tile(this.units[this.hoveredCell.col], 'l-selected', true);
    }

    this.layout.levels.forEach((band, i) => {
      const position = new Vector3(this.half + CELL * 0.4, 0.3, (this.at(band.from) + this.at(band.to)) / 2);
      items.push({ text: `Layer ${i}`, position, cls: 'l-district', align: 'left', offsetY: -10 });
    });

    if (h) for (const id of h.nodes) if (id !== h.primary && this.byId.has(id)) tile(this.byId.get(id), '', false);
    for (const u of this.units) row(u, '', false);
    let n = 0;
    for (const u of this.labelOrder) {
      if (n++ > (h ? 0 : 40)) break;
      tile(u, '', false);
    }

    this.labels.render(items, 260);
  }

  // ------------------------------------------------------------------ interaction

  /** What the pointer is over: a unit's tile or a dependency's column (the nearest). */
  pickAt(event) {
    const meshes = [this.tileMesh, this.cellMesh].filter((m) => m?.count);
    const hit = meshes.length ? this.stage.pick(event, meshes)[0] : null;
    if (!hit) return null;
    return hit.object === this.tileMesh ? { unit: this.units[hit.instanceId] } : { cell: this.cells[hit.instanceId] };
  }

  pick(event) {
    return this.pickAt(event)?.unit?.id ?? null;
  }

  pickCell(event) {
    return this.pickAt(event)?.cell ?? null;
  }

  /** AR reticle: the nearest tile a ray (the middle of the view) passes through. */
  pickAlong({ origin, direction }) {
    let best = null;
    let nearest = Infinity;
    for (const u of this.units) {
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

  positionOf(id) {
    const u = this.byId?.get(id);
    return u ? new Vector3(u.x, u.top, u.z) : null;
  }

  focus(id) {
    const u = this.byId?.get(id);
    if (!u) return;
    const target = new Vector3(u.x, 0, u.z);
    const distance = Math.max(60, CELL * 9);
    const position = target.clone().add(new Vector3(0, 0.95, 0.75).normalize().multiplyScalar(distance));
    this.stage.flyTo(target, position, 900);
  }

  fit(animate = true) {
    const size = this.size ?? 100;
    // A little to the left of the middle: the row names before the first column stay clear of the side panel.
    const target = new Vector3(-size * 0.1, 0, size * 0.04);
    const narrow = Math.max(1, 1.2 / Math.max(0.3, this.stage.camera.aspect));
    // From the front and above: rows run towards you, the diagonal from the far left to the near right.
    const position = new Vector3(-size * 0.08, size * 0.95, size * 0.95).multiplyScalar(narrow).add(new Vector3(0, 30, 30));
    if (this.stage.stereo) position.normalize().multiplyScalar(this.stage.arFit(size * 0.6));
    if (animate) this.stage.flyTo(target, position, 1000);
    else this.stage.jumpTo(target, position);
  }

  dispose() {
    this.stage.scene.remove(this.group);
    disposeObject(this.group);
    this.box.dispose();
    this.flat.dispose();
    this.units = [];
    this.links = [];
    this.cells = [];
  }
}

/** Layer tints from teal (foundation) to violet (top), as in the Layers view. */
function layerColor(index, count) {
  const t = count <= 1 ? 0 : index / (count - 1);
  return `hsl(${172 + t * 100}, 70%, 62%)`;
}
