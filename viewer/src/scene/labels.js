import { Vector3 } from 'three';

/**
 * Lightweight HTML labels that follow 3D positions. A pool of divs is reused every frame;
 * callers hand over a prioritised list and the layer hides labels that would overlap.
 */
export class LabelLayer {
  constructor(container, stage) {
    this.container = container;
    this.stage = stage;
    this.pool = [];
    this.tmp = new Vector3();
    this.occupied = [];
  }

  /** items: [{ text, position: Vector3, cls, priority, offsetY }] – highest priority first. */
  render(items, maxLabels = 120) {
    const placed = [];
    let used = 0;
    for (const item of items) {
      if (used >= maxLabels) break;
      const p = this.stage.project(item.position, this.tmp);
      if (!p || p.x < -50 || p.y < -20 || p.x > this.stage.width + 50 || p.y > this.stage.height + 20) continue;

      const width = Math.min(260, 7 * item.text.length + 8);
      const height = item.cls === 'l-project' || item.cls === 'l-district' ? 20 : 15;
      const x = p.x - width / 2;
      const y = p.y - (item.offsetY ?? 0) - height;
      const pad = 3;
      if (!item.force && placed.some((r) => x < r.x + r.w + pad && x + width + pad > r.x && y < r.y + r.h + pad && y + height + pad > r.y)) continue;
      placed.push({ x, y, w: width, h: height });

      const el = this.element(used++);
      if (el.textContent !== item.text) el.textContent = item.text;
      const cls = 'label ' + (item.cls ?? '');
      if (el.className !== cls) el.className = cls;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.opacity = item.opacity ?? 1;
      el.style.display = '';
    }

    for (let i = used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  clear() {
    for (const el of this.pool) el.style.display = 'none';
  }

  element(index) {
    while (this.pool.length <= index) {
      const el = document.createElement('div');
      el.className = 'label';
      this.container.appendChild(el);
      this.pool.push(el);
    }

    return this.pool[index];
  }
}
