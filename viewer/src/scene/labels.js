import { Vector3 } from 'three';

/**
 * Lightweight HTML labels that follow 3D positions. A pool of divs is reused every frame;
 * callers hand over a prioritised list and the layer hides labels that would overlap.
 *
 * In stereo (AR glasses, side by side) every label is drawn twice, once per eye at that eye's projection,
 * in two containers that each cover half the screen; half SBS squeezes the text, the glasses stretch it.
 */
export class LabelLayer {
  constructor(container, stage) {
    this.container = container;
    this.stage = stage;
    this.pool = [];
    this.tmp = new Vector3();
    this.occupied = [];
    this.eyes = null; // { left: { el, pool }, right: { el, pool } } once stereo was used
  }

  /** items: [{ text, position: Vector3, cls, priority, offsetY }] – highest priority first. */
  render(items, maxLabels = 120) {
    if (this.stage.stereo) return this.renderStereo(items, maxLabels);
    if (this.eyes) this.hideEyes();
    const placed = [];
    let used = 0;
    for (const item of items) {
      if (used >= maxLabels) break;
      const p = this.stage.project(item.position, this.tmp);
      if (!p || p.x < -50 || p.y < -20 || p.x > this.stage.width + 50 || p.y > this.stage.height + 20) continue;

      const { width, height } = labelSize(item);
      const x = p.x - width / 2;
      const y = p.y - (item.offsetY ?? 0) - height;
      if (!item.force && overlaps(placed, x, y, width, height)) continue;
      placed.push({ x, y, w: width, h: height });
      show(this.element(this.pool, this.container, used++), item, x, y);
    }

    hideFrom(this.pool, used);
  }

  /** Both eyes: culling on the left eye's layout, each copy at its own eye's projection. */
  renderStereo(items, maxLabels) {
    const eyes = this.eyeContainers();
    hideFrom(this.pool, 0);
    const squeeze = this.stage.stereo.sbs === 'half' ? 0.5 : 1;
    const half = this.stage.width / 2;
    const height = this.stage.height;
    const placed = [];
    let used = 0;
    for (const item of items) {
      if (used >= maxLabels) break;
      const left = this.stage.projectEye(item.position, 'left', this.tmp);
      if (!left || left.x < -50 || left.y < -20 || left.x > half + 50 || left.y > height + 20) continue;
      const lx = left.x;
      const ly = left.y;
      const right = this.stage.projectEye(item.position, 'right', this.tmp);
      if (!right) continue;

      const size = labelSize(item);
      const width = size.width * squeeze;
      const x = lx - width / 2;
      const y = ly - (item.offsetY ?? 0) - size.height;
      if (!item.force && overlaps(placed, x, y, width, size.height)) continue;
      placed.push({ x, y, w: width, h: size.height });
      show(this.element(eyes.left.pool, eyes.left.el, used), item, x, y, squeeze);
      show(this.element(eyes.right.pool, eyes.right.el, used), item, right.x - width / 2, right.y - (item.offsetY ?? 0) - size.height, squeeze);
      used++;
    }

    hideFrom(eyes.left.pool, used);
    hideFrom(eyes.right.pool, used);
  }

  clear() {
    hideFrom(this.pool, 0);
    if (this.eyes) this.hideEyes();
  }

  hideEyes() {
    hideFrom(this.eyes.left.pool, 0);
    hideFrom(this.eyes.right.pool, 0);
  }

  eyeContainers() {
    if (!this.eyes) {
      const make = (side) => {
        const el = document.createElement('div');
        el.className = `eye-labels eye-${side}`;
        this.container.appendChild(el);
        return { el, pool: [] };
      };
      this.eyes = { left: make('left'), right: make('right') };
    }

    return this.eyes;
  }

  element(pool, container, index) {
    while (pool.length <= index) {
      const el = document.createElement('div');
      el.className = 'label';
      container.appendChild(el);
      pool.push(el);
    }

    return pool[index];
  }
}

function labelSize(item) {
  return {
    width: Math.min(260, 7 * item.text.length + 8),
    height: item.cls === 'l-project' || item.cls === 'l-district' ? 20 : 15,
  };
}

function overlaps(placed, x, y, width, height) {
  const pad = 3;
  return placed.some((r) => x < r.x + r.w + pad && x + width + pad > r.x && y < r.y + r.h + pad && y + height + pad > r.y);
}

function show(el, item, x, y, squeeze = 1) {
  if (el.textContent !== item.text) el.textContent = item.text;
  const cls = 'label ' + (item.cls ?? '');
  if (el.className !== cls) el.className = cls;
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)${squeeze !== 1 ? ` scaleX(${squeeze})` : ''}`;
  el.style.opacity = item.opacity ?? 1;
  el.style.display = '';
}

function hideFrom(pool, start) {
  for (let i = start; i < pool.length; i++) pool[i].style.display = 'none';
}
