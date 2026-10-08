import { EDGE_KINDS, KIND_COLORS } from '../data/palette.js';
import { MEMBER_KINDS, METRICS } from '../data/model.js';
import { LIFETIME_COLORS } from '../data/di.js';
import { entryMethodsOf, flowIndex } from '../data/flow.js';
import { clear, fmt, h, shortName } from './dom.js';
import { host } from '../data/host.js';

const METRICS_BY_LEVEL = {
  project: ['types', 'loc', 'complexity', 'files', 'lines', 'ca', 'ce', 'instability', 'abstractness', 'distance'],
  namespace: ['types', 'loc', 'complexity', 'ca', 'ce', 'instability', 'abstractness', 'distance'],
  type: ['loc', 'complexity', 'maxComplexity', 'members', 'methods', 'properties', 'fields', 'ca', 'ce', 'instability', 'dit', 'noc', 'commits', 'churn', 'authors', 'ageDays', 'hotspot'],
  member: ['loc', 'complexity', 'parameters', 'fanIn', 'fanOut'],
};

const METRIC_SHORT = {
  loc: 'LOC', complexity: 'complexity', maxComplexity: 'max cx', members: 'members', methods: 'methods', properties: 'props',
  fields: 'fields', ca: 'used by (Ca)', ce: 'uses (Ce)', instability: 'instability', dit: 'inheritance', noc: 'subclasses',
  commits: 'commits', churn: 'lines changed', authors: 'authors', ageDays: 'days since change', hotspot: 'hotspot',
  types: 'types', files: 'files', lines: 'lines', abstractness: 'abstractness', distance: 'distance', parameters: 'params',
  fanIn: 'callers', fanOut: 'callees',
};

/** Clipboard writes can be refused (sandboxed frames, old browsers): fall back to selecting the path. */
function copyText(event, text) {
  event.preventDefault();
  const link = event.currentTarget;
  const selectPath = () => {
    const code = link.parentElement?.querySelector('code');
    if (code) window.getSelection()?.selectAllChildren(code);
  };
  try {
    const result = navigator.clipboard?.writeText(text);
    if (result) result.then(() => (link.textContent = 'copied'), selectPath);
    else selectPath();
  } catch {
    selectPath();
  }
}

const TAG_CLASS = { 'in-cycle': 'danger', hotspot: 'danger', unused: 'warn', test: 'ok', 'test-project': 'ok', entrypoint: 'ok' };

/** Right-hand panel describing the selected node and its relationships. */
export class DetailsPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
  }

  hide() {
    this.el.classList.add('hidden');
    this.node = null;
  }

  show(node, unitLevel) {
    this.node = node;
    const app = this.app;
    const model = app.model;
    clear(this.el).classList.remove('hidden');

    const kindColor = KIND_COLORS[node.kind] ?? '#999';
    this.el.append(
      h('div', { class: 'head' },
        h('div', { class: 'kind' }, h('span', { class: 'dot', style: { background: kindColor, color: kindColor } }),
          [node.accessibility, node.modifiers?.join(' '), node.kind, node.external ? '(external)' : ''].filter(Boolean).join(' ')),
        h('h2', {}, shortName(node)),
        node.fullName && node.fullName !== node.name ? h('div', { class: 'full' }, node.fullName) : null,
        h('button', { class: 'close small', title: 'Close (Esc)', onClick: () => app.select(null) }, '✕'),
      ),
    );

    const body = h('div', { class: 'body' });
    this.el.append(body);

    if (node.signature) body.append(h('div', { class: 'sig' }, node.signature));
    if (node.doc) body.append(h('div', { class: 'doc' }, node.doc));
    if (node.baseType && node.kind !== 'interface') body.append(h('div', { class: 'small muted' }, 'base: ', h('code', {}, node.baseType)));

    if (node.location) {
      const root = model.doc.source?.root;
      const abs = root ? `${root.replace(/\\/g, '/').replace(/\/$/, '')}/${node.location.file}` : node.location.file;
      const open = (e) => {
        e.preventDefault();
        host.openFile(node.location.file, node.location.line);
      };
      body.append(
        host
          ? h('div', { class: 'loc-line' },
            h('a', { href: '#', class: 'code-link', title: 'Open in the editor (or double-click the node)', onClick: open }, h('code', {}, `${node.location.file}:${node.location.line}`)),
            h('a', { href: '#', title: 'Open in the editor', onClick: open }, 'Open'),
          )
          : h('div', { class: 'loc-line' },
            h('code', {}, `${node.location.file}:${node.location.line}`),
            root ? h('a', { href: `vscode://file/${encodeURI(abs)}:${node.location.line}`, title: 'Open in VS Code' }, 'VS Code') : null,
            h('a', { href: '#', title: 'Copy path', onClick: (e) => copyText(e, `${abs}:${node.location.line}`) }, 'copy'),
          ),
      );
      if (node.extraLocations?.length) body.append(h('div', { class: 'small faint' }, `+ ${node.extraLocations.length} more partial declaration(s): `, node.extraLocations.map((l) => l.file).join(', ')));
    }

    const chips = [...(node.tags ?? []), ...(node.attributes ?? []).map((a) => '[' + a + ']')];
    if (chips.length) body.append(h('div', { class: 'chips' }, chips.map((t) => h('span', { class: 'chip ' + (TAG_CLASS[t] ?? '') }, t))));

    const metricNames = (METRICS_BY_LEVEL[node.level] ?? []).filter((m) => node.metrics?.[m] !== undefined);
    if (metricNames.length) {
      body.append(
        h('div', { class: 'metrics' },
          metricNames.map((m) =>
            h('div', { class: 'metric', title: METRICS[m]?.label ?? m }, h('div', { class: 'v' }, fmt(node.metrics[m])), h('div', { class: 'n' }, METRIC_SHORT[m] ?? m)),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------- actions
    const isUnit = app.view.byId?.has(node.id);
    const buttons = [];
    if (isUnit) {
      buttons.push(h('button', { class: 'small', onClick: () => app.view.focus(node.id) }, '◎ Focus'));
      buttons.push(h('button', { class: 'small', title: 'Direct neighbours', onClick: () => app.highlightMode('neighbors') }, 'Neighbours'));
      buttons.push(h('button', { class: 'small', title: 'Everything this depends on, transitively', onClick: () => app.highlightMode('dependencies') }, 'Dependencies ↓'));
      buttons.push(h('button', { class: 'small', title: 'Everything that depends on this – what breaks if it changes', onClick: () => app.highlightMode('dependents') }, 'Impact ↑'));
      buttons.push(h('button', { class: 'small', title: 'Then click (or Shift+click) another node', onClick: () => app.startPath() }, 'Path to…'));
    }

    if (!node.external && (node.kind === 'method' || node.kind === 'constructor' || node.kind === 'property') && flowIndex(model).calls.has(node.id)) {
      buttons.push(h('button', { class: 'small', title: 'Follow what this method calls, step by step (E)', onClick: () => app.showFlow([node.id]) }, 'Call flow ↘'));
    } else if (node.level === 'type' && !node.external && entryMethodsOf(model, node).length) {
      buttons.push(h('button', { class: 'small', title: 'Follow the calls of its entry methods (actions, ExecuteAsync…)', onClick: () => app.showFlow([node.id]) }, 'Call flow ↘'));
    }

    if (node.level === 'project' && node.kind === 'project') buttons.push(h('button', { class: 'small', onClick: () => app.drill(node.id) }, 'Open namespaces ⤵'));
    if (node.level === 'namespace') buttons.push(h('button', { class: 'small', onClick: () => app.drill(node.id) }, 'Open types ⤵'));
    if (node.level === 'type' && !node.external && model.childrenOf(node.id).some((c) => MEMBER_KINDS.has(c.kind))) {
      buttons.push(h('button', { class: 'small', onClick: () => app.drill(node.id) }, 'Show members ⤵'));
    }

    if (buttons.length) body.append(h('div', { class: 'btns' }, buttons));
    if (app.statusLine) body.append(h('div', { class: 'small muted' }, app.statusLine));

    this.diSection(body, node);
    this.couplingSection(body, node);

    // ---------------------------------------------------------------- relationships
    const { outgoing, incoming } = model.relations(node.id, unitLevel ?? node.level);
    body.append(this.relationSection('Depends on →', outgoing));
    body.append(this.relationSection('← Used by', incoming));

    // ---------------------------------------------------------------- children
    const children = model.childrenOf(node.id).filter((c) => !c.external);
    if (children.length) {
      const groups = new Map();
      for (const c of children) {
        if (!groups.has(c.kind)) groups.set(c.kind, []);
        groups.get(c.kind).push(c);
      }

      const section = h('div', { class: 'section' }, h('h3', {}, node.level === 'type' ? 'Members' : 'Contains'));
      for (const [kind, list] of groups) {
        list.sort((a, b) => (b.metrics.loc ?? 0) - (a.metrics.loc ?? 0) || a.name.localeCompare(b.name));
        section.append(this.group(kind, KIND_COLORS[kind], list.map((n) => ({ node: n, weight: n.metrics.complexity ?? n.metrics.types ?? '' })), list.length < 12));
      }

      body.append(section);
    }
  }

  /** How the container builds this type: registrations, what its constructor receives, problems. */
  diSection(body, node) {
    const di = this.app.model.doc.analysis?.di;
    if (!di || node.level !== 'type') return;
    const model = this.app.model;
    const name = (id) => (model.get(id) ? shortName(model.get(id)) : String(id).split('<')[0].split('.').pop());
    const registrations = di.registrations.filter((r) => r.implementation === node.id || r.service === node.id);
    const dependencies = di.dependencies.filter((d) => d.consumer === node.id);
    const issues = di.issues.filter((i) => i.consumer === node.id);
    if (!registrations.length && !dependencies.length) return;

    const section = h('div', { class: 'section' }, h('h3', {}, 'Dependency injection'));
    for (const issue of issues) section.append(h('div', { class: `issue ${issue.severity}` }, h('div', { class: 'small' }, issue.message)));

    for (const r of registrations) {
      const asService = r.service === node.id && r.implementation && r.implementation !== node.id;
      const text = asService
        ? `implemented by ${name(r.implementation)}`
        : r.service === node.id || !r.service ? 'registered as itself' : `registered for ${r.external ? r.service.split('.').pop() : name(r.service)}`;
      const where = r.registeredIn ? ` · in ${name(r.registeredIn)}` : '';
      const target = r.registeredIn ?? (asService ? r.implementation : null);
      section.append(
        h('div', { class: 'di-row', title: r.location ? `${r.location.file}:${r.location.line}` : '', onClick: () => target && this.app.reveal(target) },
          h('span', { class: 'life', style: { color: LIFETIME_COLORS[r.lifetime] } }, r.lifetime),
          h('span', {}, text + where),
          r.kind !== 'type' ? h('span', { class: 'faint' }, r.kind) : null,
        ),
      );
    }

    if (dependencies.length) {
      section.append(h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Constructor receives'));
      for (const d of dependencies) {
        const implementations = d.implementations.map(name).join(', ');
        const issue = issues.find((i) => i.service === d.service);
        section.append(
          h('div', { class: 'di-row', onClick: () => !d.external && this.app.reveal(d.implementations[0] ?? d.service) },
            h('span', { class: 'life', style: { color: LIFETIME_COLORS[d.lifetime] ?? 'var(--faint)' } }, d.lifetime ?? (d.external ? 'framework' : '–')),
            h('span', {}, (d.many ? 'all ' : '') + (d.external ? d.service.split('<')[0].split('.').pop() : name(d.service))),
            implementations && implementations !== name(d.service) ? h('span', { class: 'faint' }, '→ ' + implementations) : null,
            issue ? h('span', { class: 'chip ' + (issue.severity === 'error' ? 'danger' : 'warn') }, issue.kind.replace('-', ' ')) : null,
          ),
        );
      }
    }

    body.append(section);
  }

  /** Types that change in the same commits (git history). */
  couplingSection(body, node) {
    const pairs = (this.app.model.doc.analysis?.changeCoupling ?? []).filter((c) => c.source === node.id || c.target === node.id);
    if (!pairs.length) return;
    const section = h('div', { class: 'section' }, h('h3', { title: 'Modified in the same commits' }, 'Changes together with'));
    for (const pair of pairs) {
      const other = this.app.model.get(pair.source === node.id ? pair.target : pair.source);
      if (!other) continue;
      section.append(
        h('div', { class: 'di-row', onClick: () => this.app.showCoupling(pair) },
          h('span', {}, shortName(other)),
          h('span', { class: 'faint' }, `${pair.sharedCommits} commits · ${Math.round(pair.strength * 100)}%`),
          pair.hidden ? h('span', { class: 'chip warn', title: 'Neither type references the other' }, 'no code dependency') : null,
        ),
      );
    }

    body.append(section);
  }

  relationSection(title, buckets) {
    const kinds = Object.keys(buckets).sort((a, b) => buckets[b].size - buckets[a].size);
    const section = h('div', { class: 'section' }, h('h3', {}, title));
    if (!kinds.length) {
      section.append(h('div', { class: 'small faint' }, 'nothing'));
      return section;
    }

    for (const kind of kinds) {
      const entries = [...buckets[kind].values()].sort((a, b) => b.weight - a.weight);
      section.append(this.group(EDGE_KINDS[kind]?.label ?? kind, EDGE_KINDS[kind]?.color, entries, entries.length <= 8));
    }

    return section;
  }

  group(title, swatch, entries, open) {
    const details = h('details', { class: 'rel-group', open },
      h('summary', {}, h('span', { class: 'swatch', style: { background: swatch ?? '#888' } }), title, h('span', { class: 'count' }, entries.length)),
    );
    for (const entry of entries.slice(0, 60)) {
      const n = entry.node;
      details.append(
        h('div', { class: 'rel-item', title: n.fullName ?? n.name, onClick: () => this.app.reveal(n.id) },
          h('span', { class: 'name' }, shortName(n)),
          entry.weight !== '' ? h('span', { class: 'w' }, entry.weight) : null,
        ),
      );
    }

    if (entries.length > 60) details.append(h('div', { class: 'small faint', style: { paddingLeft: '14px' } }, `… ${entries.length - 60} more`));
    return details;
  }
}
