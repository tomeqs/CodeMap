import { sequenceOf, toMermaid } from '../data/flow.js';
import { clear, h, shortName } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const ROW = 30;
const HEADER = 44;
const CHAR = 7.1; // approximate width of a 12px UI font character

/** Bottom drawer with the sequence diagram of the current call flow (SVG), exportable as Mermaid / SVG. */
export class SequencePanel {
  constructor(app) {
    this.app = app;
    this.el = h('div', { id: 'sequence', class: 'hidden', role: 'dialog', 'aria-label': 'Sequence diagram' });
    document.getElementById('app').append(this.el);
    this.flow = null;
    this.rootIndex = 0;
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  show(flow, rootIndex = 0) {
    this.flow = flow;
    this.rootIndex = Math.min(rootIndex, Math.max(0, flow.tree.length - 1));
    this.el.classList.remove('hidden');
    this.render();
  }

  /** Keeps the drawer in sync when the flow is rebuilt (depth / filters / live reload). */
  update(flow) {
    if (!this.visible) return;
    if (!flow?.tree.length) return this.hide();
    const current = this.flow?.tree[this.rootIndex]?.id;
    this.flow = flow;
    const index = flow.tree.findIndex((t) => t.id === current);
    this.rootIndex = index >= 0 ? index : 0;
    this.render();
  }

  hide() {
    this.el.classList.add('hidden');
  }

  render() {
    const root = this.flow.tree[this.rootIndex];
    if (!root) return this.hide();
    const mermaid = toMermaid(root);
    const name = `${root.node.typeNode?.name ?? ''}.${root.node.name}`.replace(/^\./, '');
    const fileBase = name.replace(/[^\w.-]+/g, '_');

    const picker = this.flow.tree.length > 1
      ? h('select', { onChange: (e) => ((this.rootIndex = Number(e.target.value)), this.render()), title: 'Entry method' },
        this.flow.tree.map((t, i) => h('option', { value: i, selected: i === this.rootIndex }, `${t.node.name}()`)))
      : null;

    const svg = this.renderSvg(root);
    const canDownload = window.self === window.top; // downloads are blocked in sandboxed frames
    clear(this.el).append(
      h('div', { class: 'seq-head' },
        h('b', {}, 'Sequence'),
        h('span', { class: 'muted' }, name + '()'),
        picker,
        h('span', { class: 'spacer' }),
        h('button', { class: 'small', title: 'Mermaid sequenceDiagram: paste into GitHub, GitLab, Notion, docs…', onClick: (e) => copy(e.currentTarget, mermaid) }, 'Copy Mermaid'),
        canDownload && h('button', { class: 'small', onClick: () => download(`${fileBase}.mmd`, mermaid, 'text/plain') }, '.mmd'),
        canDownload && h('button', { class: 'small', onClick: () => download(`${fileBase}.svg`, standalone(svg), 'image/svg+xml') }, '.svg'),
        h('button', { class: 'small', title: 'Close', 'aria-label': 'Close', onClick: () => this.hide() }, '✕'),
      ),
      h('div', { class: 'seq-body' }, svg),
    );
  }

  renderSvg(root) {
    const { participants, steps } = sequenceOf(root);
    const widths = participants.map((p) => Math.max(120, p.name.length * CHAR + 28));
    const x = [];
    let cursor = 16;
    widths.forEach((w, i) => {
      x.push(cursor + w / 2);
      cursor += w + 18;
    });

    // Message labels can be wider than the columns they span: widen the gaps if needed.
    let number = 0;
    const rows = [];
    let y = HEADER + 18;
    const frames = [];
    const open = [];
    const activations = participants.map(() => []);
    const bars = [];
    for (const step of steps) {
      switch (step.type) {
        case 'start':
          rows.push({ step, y });
          y += ROW;
          break;
        case 'call':
        case 'create':
          number++;
          rows.push({ step, y, number });
          if (open.length) for (const f of open) f.cols.add(step.from).add(step.to);
          y += step.from === step.to ? ROW + 12 : ROW;
          break;
        case 'activate':
          activations[step.at].push(y - ROW / 2);
          break;
        case 'deactivate': {
          const start = activations[step.at].pop();
          if (start !== undefined) bars.push({ col: step.at, y1: start, y2: y - 8, depth: activations[step.at].length });
          break;
        }
        case 'alt':
        case 'loop':
          open.push({ type: step.type, label: step.label, y1: y - 4, cols: new Set(), separators: [] });
          y += 22;
          break;
        case 'else':
          open.at(-1)?.separators.push({ y: y - 4, label: step.label });
          y += 22;
          break;
        case 'end': {
          const frame = open.pop();
          if (frame) {
            frame.y2 = y;
            frames.push(frame);
          }

          y += 8;
          break;
        }
      }
    }

    const height = y + 20;
    const width = cursor;
    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'seq-svg' });
    svg.append(el('defs', {},
      marker('arrow', 'M0,0 L10,5 L0,10 z', '#cfd8ff'),
      marker('arrow-open', 'M0,0 L10,5 L0,10', 'none', '#cfd8ff'),
    ));

    // lifelines and headers
    participants.forEach((p, i) => {
      svg.append(el('line', { x1: x[i], y1: HEADER, x2: x[i], y2: height - 8, class: 'seq-life' }));
      const color = '#' + (p.node.baseColor?.getHexString?.() ?? '8a96b8');
      const box = el('g', { class: 'seq-actor', 'data-id': p.id });
      box.append(
        el('rect', { x: x[i] - widths[i] / 2, y: 8, width: widths[i], height: 28, rx: 7, style: `stroke:${color}` }),
        text(p.name, x[i], 26, { 'text-anchor': 'middle', class: 'seq-actor-text' }),
      );
      box.addEventListener('click', () => this.app.reveal(p.id));
      svg.append(box);
    });

    for (const bar of bars) {
      svg.append(el('rect', { x: x[bar.col] - 5 + bar.depth * 4, y: bar.y1, width: 10, height: Math.max(6, bar.y2 - bar.y1), class: 'seq-bar' }));
    }

    for (const f of frames) {
      const cols = [...f.cols];
      const left = cols.length ? Math.min(...cols.map((c) => x[c] - widths[c] / 2)) : 8;
      const right = cols.length ? Math.max(...cols.map((c) => x[c] + widths[c] / 2)) : width - 8;
      svg.append(el('rect', { x: left - 6, y: f.y1, width: right - left + 12, height: f.y2 - f.y1, class: 'seq-frame' }));
      const tag = `${f.type} ${f.label}`;
      svg.append(
        el('path', { d: `M${left - 6},${f.y1} h${tag.length * 6.4 + 14} v12 l-6,6 h${-(tag.length * 6.4 + 8)} z`, class: 'seq-frame-tag' }),
        text(tag, left, f.y1 + 13, { class: 'seq-frame-text' }),
      );
      for (const s of f.separators) {
        svg.append(el('line', { x1: left - 6, y1: s.y, x2: right + 6, y2: s.y, class: 'seq-sep' }), text(`[${s.label}]`, left + 4, s.y + 14, { class: 'seq-frame-text' }));
      }
    }

    for (const row of rows) {
      const s = row.step;
      if (s.type === 'start') {
        svg.append(text(`▶ ${s.label}`, x[s.at] + 10, row.y + 4, { class: 'seq-start' }));
        continue;
      }

      const g = el('g', { class: 'seq-msg' + (s.type === 'create' ? ' create' : '') + (s.note ? ' noted' : ''), 'data-id': s.id, tabindex: 0 });
      const x1 = x[s.from];
      const x2 = x[s.to];
      const label = `${row.number}. ${s.label}${s.via ? `  ·  ${s.via}` : ''}${s.note ? `  (${s.note})` : ''}`;
      if (s.from === s.to) {
        g.append(
          el('path', { d: `M${x1 + 5},${row.y} h34 v14 h-29`, class: 'seq-line', 'marker-end': 'url(#arrow)' }),
          text(label, x1 + 46, row.y + 10, { class: 'seq-label' }),
        );
      } else {
        const dir = Math.sign(x2 - x1);
        g.append(
          el('line', { x1: x1 + dir * 5, y1: row.y, x2: x2 - dir * 6, y2: row.y, class: 'seq-line', 'marker-end': s.type === 'create' ? 'url(#arrow-open)' : 'url(#arrow)' }),
          text(label, dir > 0 ? x1 + 10 : x2 + 12, row.y - 6, { class: 'seq-label' }),
        );
      }

      // A thin arrow is hard to hit: the whole row (arrow and label) is clickable.
      const labelStart = s.from === s.to ? x1 + 46 : Math.sign(x2 - x1) > 0 ? x1 + 10 : x2 + 12;
      const left = Math.min(x1, x2, labelStart);
      const right = Math.max(x1, x2, labelStart + label.length * CHAR) + (s.from === s.to ? 40 : 0);
      g.prepend(el('rect', { x: left, y: row.y - 20, width: right - left, height: s.from === s.to ? 38 : 26, class: 'seq-hit' }));
      g.append(el('title', {}, s.type === 'create' ? s.label : `${shortName(this.app.model.get(s.id))}${s.via ? ` via ${s.via}` : ''}`));
      const choose = () => this.app.selectInFlow(s.id);
      g.addEventListener('click', choose);
      g.addEventListener('keydown', (e) => e.key === 'Enter' && choose());
      svg.append(g);
    }

    return svg;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
}

function text(content, x, y, attrs = {}) {
  const node = el('text', { x, y, ...attrs });
  node.textContent = content;
  return node;
}

function marker(id, d, fill, stroke) {
  return el('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' },
    el('path', { d, fill, stroke: stroke ?? 'none', 'stroke-width': 1.4 }));
}

/** An SVG file that renders on its own (styles inlined, dark background). */
function standalone(svg) {
  const copy = svg.cloneNode(true);
  copy.setAttribute('xmlns', SVG);
  const style = document.createElementNS(SVG, 'style');
  style.textContent = `
    svg { background: #0b1020; font: 12px Inter, 'Segoe UI', Roboto, sans-serif; }
    .seq-life { stroke: #3b4766; stroke-dasharray: 4 4; }
    .seq-actor rect { fill: #121a30; stroke-width: 1.5; }
    .seq-actor-text { fill: #e6ecff; font-weight: 600; }
    .seq-bar { fill: #24304f; stroke: #6ea8ff; }
    .seq-line { stroke: #cfd8ff; fill: none; stroke-width: 1.3; }
    .seq-msg.create .seq-line { stroke-dasharray: 5 4; }
    .seq-label { fill: #e6ecff; }
    .seq-msg.noted .seq-label { fill: #ffb74d; }
    .seq-start { fill: #35c9a5; font-weight: 600; }
    .seq-frame { fill: rgba(110,168,255,0.04); stroke: #56617f; }
    .seq-frame-tag { fill: #1a2440; stroke: #56617f; }
    .seq-frame-text { fill: #8a96b8; font-size: 11px; }
    .seq-sep { stroke: #56617f; stroke-dasharray: 5 4; }
    .seq-hit { fill: none; }`;
  copy.prepend(style);
  return new XMLSerializer().serializeToString(copy);
}

function download(name, content, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([content], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Clipboard writes can be refused (sandboxed frames): fall back to showing the text to copy by hand. */
function copy(button, content) {
  const done = () => {
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy Mermaid'), 1500);
  };
  const fallback = () => {
    const area = h('textarea', { class: 'seq-copy', readonly: true }, content);
    button.closest('#sequence').querySelector('.seq-body').prepend(area);
    area.select();
  };
  try {
    const result = navigator.clipboard?.writeText(content);
    if (result) result.then(done, fallback);
    else fallback();
  } catch {
    fallback();
  }
}
