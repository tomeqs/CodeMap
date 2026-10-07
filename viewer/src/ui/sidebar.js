import { EDGE_KINDS, KIND_COLORS, TAG_COLORS, turboCss } from '../data/palette.js';
import { METRICS, defaultEdgeKinds } from '../data/model.js';
import { clear, fmt, h, shortName } from './dom.js';

/** Left panel: filters, insights (cycles, hotspots, dead code...) and data info. */
export class Sidebar {
  constructor(app) {
    this.app = app;
    this.filters = document.getElementById('tab-filters');
    this.insights = document.getElementById('tab-insights');
    this.about = document.getElementById('tab-about');

    document.querySelectorAll('#left .tabs button').forEach((button) =>
      button.addEventListener('click', () => {
        document.querySelectorAll('#left .tabs button').forEach((b) => b.classList.toggle('active', b === button));
        for (const tab of ['filters', 'insights', 'about']) document.getElementById('tab-' + tab).classList.toggle('hidden', tab !== button.dataset.tab);
      }),
    );
  }

  render() {
    this.renderFilters();
    this.renderInsights();
    this.renderAbout();
  }

  // ------------------------------------------------------------------ filters

  renderFilters() {
    const { app } = this;
    const { model, state } = app;
    const el = clear(this.filters);
    const metricOptions = Object.entries(METRICS).filter(([key]) => model.nodes.some((n) => n.metrics[key] !== undefined));

    const select = (value, options, onChange) =>
      h('select', { onChange: (e) => onChange(e.target.value) }, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));

    const colorOptions = [
      ['project', 'Project / namespace'],
      ['kind', 'Kind (class, interface…)'],
      ['role', 'Role (controller, repository…)'],
      ['cycles', 'Cycles & unused code'],
      ...metricOptions.map(([k, m]) => [k, m.label]),
    ];

    const appearance = h('div', { class: 'section' }, h('h3', {}, 'Appearance'));
    appearance.append(h('div', { class: 'row' }, h('label', {}, 'Colour'), select(state.colorMode, colorOptions, (v) => app.setState({ colorMode: v }, 'recolor'))));
    if (state.view === 'galaxy') {
      appearance.append(h('div', { class: 'row' }, h('label', {}, 'Size'), select(state.sizeMetric, metricOptions.map(([k, m]) => [k, m.label]), (v) => app.setState({ sizeMetric: v }))));
    } else {
      appearance.append(h('div', { class: 'row' }, h('label', {}, 'Height'), select(state.heightMetric, metricOptions.map(([k, m]) => [k, m.label]), (v) => app.setState({ heightMetric: v }))));
      appearance.append(h('div', { class: 'row' }, h('label', {}, 'Footprint'), select(state.footprintMetric, metricOptions.map(([k, m]) => [k, m.label]), (v) => app.setState({ footprintMetric: v }))));
    }

    const toggle = (label, checked, onChange, title) =>
      h('label', { class: 'toggle-row', title }, h('span', {}, label), h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }));

    appearance.append(toggle('Labels', state.labels, (v) => app.setState({ labels: v }, 'options')));
    if (state.view === 'galaxy') {
      appearance.append(toggle('Flow particles on all links', state.flowAll, (v) => app.setState({ flowAll: v }, 'options')));
      appearance.append(toggle('Auto-rotate', state.autoRotate, (v) => app.setState({ autoRotate: v }, 'options')));
    } else {
      appearance.append(toggle('Show all relationships as arcs', state.allArcs, (v) => app.setState({ allArcs: v }, 'options')));
    }

    if (model.hasTests) appearance.append(toggle('Include tests', state.showTests, (v) => app.setState({ showTests: v })));
    if (model.hasExternal || model.hasPackages) appearance.append(toggle('Include external (BCL / NuGet)', state.showExternal, (v) => app.setState({ showExternal: v })));
    el.append(appearance);

    // relationship kinds
    const kinds = Object.keys(EDGE_KINDS).filter((k) => model.edgeKindCounts[k]);
    const edges = h('div', { class: 'section' },
      h('h3', {}, 'Relationships',
        h('span', { class: 'links' },
          h('button', { onClick: () => app.setState({ edgeKinds: new Set(kinds) }, 'full') }, 'all'),
          h('button', { onClick: () => app.setState({ edgeKinds: defaultEdgeKinds(model) }, 'full') }, 'default'),
          h('button', { onClick: () => app.setState({ edgeKinds: new Set() }, 'full') }, 'none'),
        ),
      ),
    );
    for (const kind of kinds) {
      const info = EDGE_KINDS[kind];
      edges.append(
        h('label', { class: 'check', title: info.hint },
          h('input', {
            type: 'checkbox',
            checked: state.edgeKinds.has(kind),
            onChange: (e) => {
              const next = new Set(state.edgeKinds);
              if (e.target.checked) next.add(kind);
              else next.delete(kind);
              app.setState({ edgeKinds: next });
            },
          }),
          h('span', { class: 'swatch', style: { background: info.color, color: info.color } }),
          h('span', { class: 'name' }, info.label),
          h('span', { class: 'count' }, fmt(model.edgeKindCounts[kind])),
        ),
      );
    }

    edges.append(
      h('div', { class: 'row', title: 'Hide weak links (number of occurrences in code)' },
        h('label', {}, `Min. strength: ${state.minWeight}`),
        h('input', { type: 'range', min: 1, max: 20, value: state.minWeight, onChange: (e) => app.setState({ minWeight: Number(e.target.value) }) }),
      ),
    );
    el.append(edges);

    // projects
    if (model.projects.length > 1) {
      const projects = h('div', { class: 'section' },
        h('h3', {}, 'Projects',
          h('span', { class: 'links' },
            h('button', { onClick: () => app.setState({ hiddenProjects: new Set() }) }, 'all'),
            h('button', { onClick: () => app.setState({ hiddenProjects: new Set(model.projects.map((p) => p.id)) }) }, 'none'),
          ),
        ),
      );
      for (const project of model.projects) {
        const css = '#' + project.baseColor.getHexString();
        projects.append(
          h('label', { class: 'check', title: project.fullName },
            h('input', {
              type: 'checkbox',
              checked: !state.hiddenProjects.has(project.id),
              onChange: (e) => {
                const next = new Set(state.hiddenProjects);
                if (e.target.checked) next.delete(project.id);
                else next.add(project.id);
                app.setState({ hiddenProjects: next });
              },
            }),
            h('span', { class: 'swatch', style: { background: css, color: css } }),
            h('span', { class: 'name' }, project.name),
            h('span', { class: 'count' }, fmt(project.metrics.types)),
          ),
        );
      }

      el.append(projects);
    }

    el.append(
      h('div', { class: 'section small faint' },
        h('div', {}, 'Drag – rotate · right-drag – pan · wheel – zoom'),
        h('div', {}, 'Click – select · double-click – drill in · Shift+click – path'),
        h('div', {}, 'Keys: / search · 1-4 level · G/C view · F fit · Esc back'),
      ),
    );
  }

  // ------------------------------------------------------------------ insights

  renderInsights() {
    const { app } = this;
    const { model } = app;
    const analysis = model.doc.analysis ?? {};
    const el = clear(this.insights);

    const cycles = analysis.cycles ?? [];
    const cycleSection = h('div', { class: 'section' }, h('h3', {}, `Dependency cycles (${cycles.length})`));
    if (!cycles.length) cycleSection.append(h('div', { class: 'small faint' }, 'No cycles – nice layering!'));
    for (const cycle of cycles.slice(0, 40)) {
      const names = cycle.nodes.map((id) => shortName(model.get(id)) || id);
      cycleSection.append(
        h('div', { class: 'cycle', onClick: () => app.showCycle(cycle) },
          h('div', {}, h('b', {}, cycle.level), ` · ${cycle.nodes.length} nodes`),
          h('div', { class: 'members' }, names.slice(0, 6).join(' ⇄ ') + (names.length > 6 ? ' …' : '')),
        ),
      );
    }

    el.append(cycleSection);

    const ranking = (title, items, hint, render = (i) => fmt(i.score)) => {
      if (!items?.length) return;
      const section = h('div', { class: 'section' }, h('h3', { title: hint }, title));
      for (const item of items.slice(0, 15)) {
        const node = model.get(item.id);
        if (!node) continue;
        section.append(
          h('div', { class: 'insight', title: node.fullName, onClick: () => app.reveal(node.id) },
            h('span', { class: 'swatch', style: { width: '8px', height: '8px', borderRadius: '50%', background: KIND_COLORS[node.kind], flex: 'none' } }),
            h('span', { class: 'name' }, shortName(node)),
            h('span', { class: 'score' }, render(item)),
          ),
        );
      }

      el.append(section);
    };

    ranking('Hotspots', analysis.hotspots, 'Complex code that changes often – the best refactoring candidates', (i) => (i.score * 100).toFixed(0) + '%');
    if (!analysis.hotspots?.length && !model.hasGit) el.append(h('div', { class: 'section small faint' }, 'Hotspots need git history (run codemap inside a git repository).'));
    ranking('Most complex types', analysis.mostComplex, 'Sum of cyclomatic complexity of members');
    ranking('Most depended upon', analysis.mostDepended, 'Afferent coupling: number of types that use it');

    const unused = analysis.unusedCandidates ?? [];
    if (unused.length) {
      const section = h('div', { class: 'section' }, h('h3', { title: 'Non-public symbols nothing refers to' }, `Possibly unused (${unused.length})`));
      for (const id of unused.slice(0, 40)) {
        const node = model.get(id);
        if (!node) continue;
        section.append(
          h('div', { class: 'insight', title: node.fullName, onClick: () => app.reveal(id) },
            h('span', { class: 'name' }, shortName(node)),
            h('span', { class: 'score' }, node.kind),
          ),
        );
      }

      el.append(section);
    }

    const roles = new Map();
    for (const node of model.nodes) {
      if (node.level !== 'type' || node.external) continue;
      for (const tag of node.tags) if (TAG_COLORS[tag]) roles.set(tag, (roles.get(tag) ?? 0) + 1);
    }

    if (roles.size) {
      const section = h('div', { class: 'section' }, h('h3', {}, 'Recognised roles'));
      section.append(
        h('div', { class: 'chips' },
          [...roles.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) =>
            h('span', { class: 'chip', style: { cursor: 'pointer', borderColor: TAG_COLORS[tag] }, onClick: () => app.setState({ colorMode: 'role' }, 'recolor') }, `${tag} ${count}`),
          ),
        ),
      );
      el.append(section);
    }
  }

  // ------------------------------------------------------------------ data

  renderAbout() {
    const { model } = this.app;
    const doc = model.doc;
    const el = clear(this.about);
    const stats = doc.stats ?? {};
    const kv = (pairs) => h('div', { class: 'kv' }, pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [h('div', { class: 'k' }, k), h('div', {}, v)]));

    el.append(
      h('div', { class: 'section' }, h('h3', {}, 'Source'),
        kv([
          ['name', doc.source?.name],
          ['kind', doc.source?.kind],
          ['path', h('code', { style: { wordBreak: 'break-all' } }, doc.source?.path ?? '')],
          ['generated', doc.generatedAt ? new Date(doc.generatedAt).toLocaleString() : ''],
          ['generator', `${doc.generator?.name ?? ''} ${doc.generator?.version ?? ''}`],
          ['format', `${doc.format} ${doc.version}`],
          ['git', doc.source?.git ? `${doc.source.git.branch} @ ${(doc.source.git.commit ?? '').slice(0, 8)} (${doc.source.git.commitsAnalyzed} commits)` : ''],
        ]),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Statistics'),
        kv(Object.entries(stats).filter(([k]) => !k.startsWith('edges.')).map(([k, v]) => [k, fmt(v)])),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Relationships'),
        kv(Object.entries(stats).filter(([k]) => k.startsWith('edges.')).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k.slice(6), fmt(v)])),
      ),
      h('div', { class: 'section' },
        h('button', {
          class: 'small',
          onClick: () => {
            const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: `${doc.source?.name ?? 'codemap'}.codemap.json` });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          },
        }, 'Download JSON'),
      ),
    );

    if (doc.analysis?.warnings?.length) {
      el.append(h('div', { class: 'section' }, h('h3', {}, `Warnings (${doc.analysis.warnings.length})`), doc.analysis.warnings.slice(0, 30).map((w) => h('div', { class: 'small faint' }, w))));
    }
  }
}

/** Bottom legend for the current colour mode. */
export function renderLegend(el, app) {
  const { model, state } = app;
  clear(el);
  const item = (color, label) => h('span', { class: 'li' }, h('span', { class: 'sw', style: { background: color, boxShadow: `0 0 6px ${color}` } }), label);
  switch (state.colorMode) {
    case 'project':
      for (const p of model.projects.slice(0, 14)) if (!state.hiddenProjects.has(p.id)) el.append(item('#' + p.baseColor.getHexString(), p.name));
      break;
    case 'kind': {
      const present = new Set(model.nodes.filter((n) => n.level === state.level || (state.view === 'city' && n.level === 'type')).map((n) => n.kind));
      for (const [kind, color] of Object.entries(KIND_COLORS)) if (present.has(kind)) el.append(item(color, kind));
      break;
    }
    case 'role':
      for (const [tag, color] of Object.entries(TAG_COLORS)) if (model.nodes.some((n) => n.tags.includes(tag))) el.append(item(color, tag));
      el.append(item('#3a4560', 'other'));
      break;
    case 'cycles':
      el.append(item('#ff5252', 'in a dependency cycle'), item('#ffd54f', 'possibly unused'), item('#35435f', 'other'));
      break;
    default: {
      const stops = Array.from({ length: 11 }, (_, i) => turboCss(0.08 + 0.92 * (i / 10))).join(',');
      el.append(
        h('span', { class: 'li' }, METRICS[state.colorMode]?.label ?? state.colorMode),
        h('span', { class: 'li' }, 'low', h('span', { class: 'ramp', style: { background: `linear-gradient(90deg, ${stops})` } }), 'high'),
      );
    }
  }

  const shapes = state.view === 'galaxy' && state.level !== 'project' && state.level !== 'namespace'
    ? (state.level === 'member' ? '● method · ◆ ctor · ■ property · ▲ field' : '● class · ◆ interface · ■ struct · ⬟ record · ▲ enum')
    : state.view === 'city' ? `height = ${METRICS[state.heightMetric]?.label ?? state.heightMetric} · footprint = ${METRICS[state.footprintMetric]?.label ?? state.footprintMetric}` : '';
  if (shapes) el.append(h('span', { class: 'li faint' }, shapes));
}
