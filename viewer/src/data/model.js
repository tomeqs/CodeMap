import { Color } from 'three';
import { EDGE_KINDS, KIND_COLORS, TAG_COLORS, projectColor, turbo, vary } from './palette.js';
import { LIFETIME_COLORS } from './di.js';

export const LEVELS = ['project', 'namespace', 'type', 'member'];
export const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'record', 'recordStruct', 'enum', 'delegate']);
export const MEMBER_KINDS = new Set(['method', 'constructor', 'property', 'field', 'event']);

/** Metrics the user can colour / size / extrude by. `scale` decides normalisation. */
export const METRICS = {
  loc: { label: 'Lines of code', scale: 'log' },
  complexity: { label: 'Cyclomatic complexity', scale: 'log' },
  members: { label: 'Members', scale: 'log' },
  methods: { label: 'Methods', scale: 'log' },
  ca: { label: 'Afferent coupling (used by)', scale: 'log' },
  ce: { label: 'Efferent coupling (uses)', scale: 'log' },
  instability: { label: 'Instability Ce/(Ca+Ce)', scale: 'linear' },
  fanIn: { label: 'Fan-in (callers)', scale: 'log' },
  fanOut: { label: 'Fan-out (callees)', scale: 'log' },
  dit: { label: 'Depth of inheritance', scale: 'linear' },
  commits: { label: 'Commits (churn)', scale: 'log' },
  churn: { label: 'Lines changed', scale: 'log' },
  authors: { label: 'Authors', scale: 'linear' },
  hotspot: { label: 'Hotspot (complexity × churn)', scale: 'linear' },
  abstractness: { label: 'Abstractness', scale: 'linear' },
  distance: { label: 'Distance from main sequence', scale: 'linear' },
};

export function levelOf(node) {
  switch (node.kind) {
    case 'project':
    case 'package':
    case 'assembly':
      return 'project';
    case 'namespace':
      return 'namespace';
    default:
      if (TYPE_KINDS.has(node.kind)) return 'type';
      if (MEMBER_KINDS.has(node.kind)) return 'member';
      return 'type';
  }
}

/**
 * Indexed, query-friendly wrapper around a CodeMap graph document.
 * "Units" are the nodes shown at a given level; every node maps to the unit that represents it.
 */
export class CodeModel {
  constructor(doc) {
    if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw new Error('Not a CodeMap document (missing nodes/edges).');
    this.doc = doc;
    this.nodes = doc.nodes;
    this.edges = doc.edges.filter((e) => e.source !== e.target || e.kind === 'calls');
    this.byId = new Map();
    this.children = new Map();

    this.nodes.forEach((node, i) => {
      node.level = levelOf(node);
      node.levelIndex = LEVELS.indexOf(node.level);
      node.metrics ??= {};
      node.tags ??= [];
      node.idx = i; // dense number: typed-array bookkeeping instead of string keys on big graphs
      this.byId.set(node.id, node);
    });

    for (const node of this.nodes) {
      if (node.parent && !this.byId.has(node.parent)) node.parent = undefined;
      if (node.parent) {
        if (!this.children.has(node.parent)) this.children.set(node.parent, []);
        this.children.get(node.parent).push(node);
      }
    }

    // Derived from the parent chain, each node from its (already resolved) parent:
    // anc[level] = the deepest node on the chain whose level <= that level (else the root).
    const count = this.nodes.length;
    const rootOf = new Array(count);
    const projectOf = new Array(count);
    const state = new Uint8Array(count); // 0 = not yet, 1 = resolving, 2 = done
    const resolve = (node) => {
      const i = node.idx;
      if (state[i] === 2) return;
      state[i] = 1;
      let parent = node.parent ? this.byId.get(node.parent) : null;
      if (parent && state[parent.idx] === 1) parent = null; // a loop in the parent links: stop here
      const li = node.levelIndex;
      const isProject = node.kind === 'project';
      if (parent) {
        resolve(parent);
        const pa = parent.anc;
        node.anc = [li <= 0 ? node : pa[0], li <= 1 ? node : pa[1], li <= 2 ? node : pa[2], li <= 3 ? node : pa[3]];
        rootOf[i] = rootOf[parent.idx];
        projectOf[i] = isProject ? node : projectOf[parent.idx];
        node.namespaceNode = node.kind === 'namespace' ? node : parent.namespaceNode;
        node.typeNode = TYPE_KINDS.has(node.kind) ? node : parent.typeNode;
      } else {
        node.anc = [node, node, node, node];
        rootOf[i] = node;
        projectOf[i] = isProject ? node : null;
        node.namespaceNode = node.kind === 'namespace' ? node : null;
        node.typeNode = TYPE_KINDS.has(node.kind) ? node : null;
      }

      state[i] = 2;
    };

    for (const node of this.nodes) resolve(node);
    for (const node of this.nodes) {
      node.projectNode = projectOf[node.idx] ?? (node.project ? this.byId.get(node.project) : null) ?? rootOf[node.idx];
      node.isTest = !!(node.projectNode?.tags?.includes('test-project') || node.tags.includes('test'));
    }

    // Depth-first entry/exit numbers: "is a inside b" is two comparisons.
    this.enter = new Int32Array(count);
    this.exit = new Int32Array(count);
    let clock = 0;
    const stack = [];
    for (const top of this.nodes) {
      if (top.parent) continue;
      stack.push({ node: top, kids: this.children.get(top.id) ?? [], next: 0 });
      this.enter[top.idx] = clock++;
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.next < frame.kids.length) {
          const kid = frame.kids[frame.next++];
          this.enter[kid.idx] = clock++;
          stack.push({ node: kid, kids: this.children.get(kid.id) ?? [], next: 0 });
        } else {
          this.exit[frame.node.idx] = clock++;
          stack.pop();
        }
      }
    }

    // Edge endpoints as node numbers (-1: not in the graph), resolved once.
    this.edgeSource = new Int32Array(this.edges.length);
    this.edgeTarget = new Int32Array(this.edges.length);
    this.edges.forEach((e, k) => {
      this.edgeSource[k] = this.byId.get(e.source)?.idx ?? -1;
      this.edgeTarget[k] = this.byId.get(e.target)?.idx ?? -1;
    });

    this.projects = this.nodes.filter((n) => n.kind === 'project');
    this.projects.forEach((p, i) => (p.baseColor = projectColor(i)));
    const externalColor = new Color('#8d8d99');
    for (const node of this.nodes) {
      if (node.kind === 'package' || node.kind === 'assembly' || node.external) node.baseColor ??= externalColor;
    }

    // namespaces get a variation of their project's colour, types inherit their namespace colour.
    const nsIndex = new Map();
    for (const node of this.nodes) {
      if (node.kind !== 'namespace') continue;
      const project = node.projectNode;
      const i = nsIndex.get(project) ?? 0;
      nsIndex.set(project, i + 1);
      node.baseColor = vary(project?.baseColor ?? externalColor, i);
    }

    for (const node of this.nodes) {
      if (node.baseColor) continue;
      node.baseColor = (node.namespaceNode ?? node.projectNode)?.baseColor ?? externalColor;
    }

    this.edgeKindCounts = {};
    for (const e of this.edges) this.edgeKindCounts[e.kind] = (this.edgeKindCounts[e.kind] ?? 0) + 1;

    this.hasExternal = this.nodes.some((n) => n.external && n.kind !== 'package');
    this.hasPackages = this.nodes.some((n) => n.kind === 'package');
    this.hasTests = this.nodes.some((n) => n.isTest);
    this.hasGit = this.nodes.some((n) => n.metrics.commits > 0);
    this.metricMax = {};
    for (const node of this.nodes) {
      for (const [k, v] of Object.entries(node.metrics)) {
        const key = `${node.level}:${k}`;
        if (!(this.metricMax[key] >= v)) this.metricMax[key] = v;
      }
    }
  }

  get(id) {
    return this.byId.get(id);
  }

  childrenOf(id) {
    return this.children.get(id) ?? [];
  }

  unitOf(node, level) {
    return node.anc[LEVELS.indexOf(level)];
  }

  /** True when `node` is `ancestorId` or inside it. */
  isDescendant(node, ancestorId) {
    const a = this.byId.get(ancestorId);
    if (!a || !node) return false;
    return this.enter[a.idx] <= this.enter[node.idx] && this.exit[node.idx] <= this.exit[a.idx];
  }

  /** Normalised [0..1] value of a metric for a node, relative to its level's maximum. */
  norm(node, metric) {
    const v = node.metrics?.[metric] ?? 0;
    const max = this.metricMax[`${node.level}:${metric}`] ?? 0;
    if (max <= 0) return 0;
    return METRICS[metric]?.scale === 'linear' ? v / max : Math.log1p(v) / Math.log1p(max);
  }

  /** Lifetime per node; a project or namespace takes the most common lifetime of its types (red if any has a DI problem). */
  lifetimeSummary() {
    if (this._lifetimes) return this._lifetimes;
    const counts = new Map();
    for (const node of this.nodes) {
      const lifetime = ['singleton', 'scoped', 'transient'].find((t) => node.tags?.includes(t));
      const issue = node.tags?.includes('di-issue');
      if (!lifetime && !issue) continue;
      for (let n = node; n; n = n.parent ? this.byId.get(n.parent) : null) {
        let c = counts.get(n.id);
        if (!c) counts.set(n.id, (c = { issue: false, singleton: 0, scoped: 0, transient: 0 }));
        if (issue) c.issue = true;
        if (lifetime) c[lifetime]++;
      }
    }

    this._lifetimes = new Map();
    for (const [id, c] of counts) {
      const lifetime = ['singleton', 'scoped', 'transient'].reduce((best, l) => (c[l] > c[best] ? l : best), 'singleton');
      this._lifetimes.set(id, { issue: c.issue, lifetime });
    }

    return this._lifetimes;
  }

  colorOf(node, mode, target = new Color()) {
    switch (mode) {
      case 'project':
        return target.copy(node.baseColor);
      case 'kind':
        return target.set(KIND_COLORS[node.kind] ?? '#9e9e9e');
      case 'role': {
        const tag = node.tags.find((t) => TAG_COLORS[t]);
        return tag ? target.set(TAG_COLORS[tag]) : target.set('#3a4560');
      }
      case 'lifetime': {
        const summary = this.lifetimeSummary().get(node.id);
        if (!summary) return target.set('#2c3550');
        if (summary.issue) return target.set('#ff4545');
        return target.set(LIFETIME_COLORS[summary.lifetime]);
      }
      case 'cycles':
        if (node.tags.includes('in-cycle')) return target.set('#ff5252');
        if (node.tags.includes('unused')) return target.set('#ffd54f');
        return target.set('#35435f');
      default:
        if (node.metrics?.[mode] === undefined && node.level !== 'project') return target.set('#2c3550');
        return turbo(0.08 + 0.92 * this.norm(node, mode), target);
    }
  }

  /**
   * Nodes visible at the requested level after filters.
   * state: { level, scope, hiddenProjects:Set, showExternal, showTests, focusIds?:Set }
   */
  units(state) {
    const result = [];
    const scope = state.scope ? this.byId.get(state.scope) : null;
    for (const node of this.nodes) {
      if (!this.isUnitCandidate(node, state)) continue;
      if (scope && !(this.enter[scope.idx] <= this.enter[node.idx] && this.exit[node.idx] <= this.exit[scope.idx])) continue;
      result.push(node);
    }

    return result;
  }

  isUnitCandidate(node, state) {
    const level = state.level;
    if (node.kind === 'package') return level === 'project' && state.showExternal && this.hasPackages;
    if (node.kind === 'assembly') return false;
    if (node.external) return state.showExternal && level === 'type' && node.level === 'type';
    if (node.level !== level) return false;
    if (!state.showTests && node.isTest) return false;
    if (state.hiddenProjects?.has(node.projectNode?.id)) return false;
    return true;
  }

  /**
   * Aggregates raw edges between the given units. Edges whose endpoints are outside the unit set are
   * either dropped or, when `ghosts` is true, pulled in as "ghost" neighbours (used when drilled into a scope).
   */
  aggregate(units, state, { ghosts = false } = {}) {
    const level = state.level;
    const li = LEVELS.indexOf(level);
    const isUnit = new Uint8Array(this.nodes.length);
    for (const u of units) isUnit[u.idx] = 1;
    const ghostSet = new Map();
    const links = new Map();
    const kinds = state.edgeKinds;
    const ghostState = ghosts ? { ...state, scope: null } : null;
    const n = this.nodes.length;

    for (let k = 0; k < this.edges.length; k++) {
      const e = this.edges[k];
      if (!kinds.has(e.kind)) continue;
      const si = this.edgeSource[k];
      const ti = this.edgeTarget[k];
      if (si < 0 || ti < 0) continue;
      const s = this.nodes[si];
      const t = this.nodes[ti];
      let su = isUnit[s.anc[li].idx] ? s.anc[li] : null;
      let tu = isUnit[t.anc[li].idx] ? t.anc[li] : null;
      if (!su && !tu) continue;
      if (!su || !tu) {
        if (!ghosts) continue;
        // pull the outside endpoint in as a ghost, at the same level if possible
        const outside = su ? t : s;
        const ghost = outside.anc[li];
        if (!ghost || ghost.levelIndex !== li && !ghost.external) continue;
        if (!this.isUnitCandidate(ghost, ghostState)) continue;
        ghostSet.set(ghost.id, ghost);
        if (!su) su = ghost;
        else tu = ghost;
      }

      if (su === tu) continue;
      addLink(links, su.idx * n + tu.idx, su.id, tu.id, e);
    }

    return { links: finishLinks(links, state), ghosts: [...ghostSet.values()] };
  }

  /**
   * Like aggregate(), for units of mixed levels (semantic zoom: a namespace next to the types of another one):
   * each endpoint goes to its deepest ancestor-or-self that is a unit.
   */
  aggregateMixed(unitIds, state) {
    const n = this.nodes.length;
    const isUnit = new Uint8Array(n);
    for (const id of unitIds) {
      const node = this.byId.get(id);
      if (node) isUnit[node.idx] = 1;
    }

    // resolved[idx]: 0 = not yet, -1 = no unit above, else unit idx + 1
    const resolved = new Int32Array(n);
    const resolve = (node) => {
      const memo = resolved[node.idx];
      if (memo) return memo > 0 ? this.nodes[memo - 1] : null;
      let unit = null;
      if (isUnit[node.idx]) unit = node;
      else if (node.parent) unit = resolve(this.byId.get(node.parent));
      resolved[node.idx] = unit ? unit.idx + 1 : -1;
      return unit;
    };

    const links = new Map();
    const kinds = state.edgeKinds;
    for (let k = 0; k < this.edges.length; k++) {
      const e = this.edges[k];
      if (!kinds.has(e.kind)) continue;
      const si = this.edgeSource[k];
      const ti = this.edgeTarget[k];
      if (si < 0 || ti < 0) continue;
      const s = this.nodes[si];
      const t = this.nodes[ti];
      const su = resolve(s);
      const tu = resolve(t);
      if (!su || !tu || su === tu) continue;
      addLink(links, su.idx * n + tu.idx, su.id, tu.id, e);
    }

    return finishLinks(links, state);
  }

  /** Edges by the type their ends belong to (type number -> edge numbers), built on first use. */
  edgesByType() {
    if (this._edgesByType) return this._edgesByType;
    const map = new Map();
    const add = (type, k) => {
      if (!type) return;
      let list = map.get(type.idx);
      if (!list) map.set(type.idx, (list = []));
      if (list[list.length - 1] !== k) list.push(k);
    };
    for (let k = 0; k < this.edges.length; k++) {
      const si = this.edgeSource[k];
      const ti = this.edgeTarget[k];
      if (si < 0 || ti < 0) continue;
      add(this.nodes[si].typeNode, k);
      add(this.nodes[ti].typeNode, k);
    }

    this._edgesByType = map;
    return map;
  }

  /** Raw relationships of a node grouped by direction and kind, resolved to units of the given level (or raw nodes). */
  relations(id, level) {
    const node = this.byId.get(id);
    if (!node) return { outgoing: {}, incoming: {} };
    const li = LEVELS.indexOf(level ?? node.level);
    const from = this.enter[node.idx];
    const to = this.exit[node.idx];
    const inside = (n) => from <= this.enter[n.idx] && this.exit[n.idx] <= to;
    const outgoing = {};
    const incoming = {};
    const add = (bucket, kind, other, weight) => {
      const unit = other.anc[li] ?? other;
      bucket[kind] ??= new Map();
      const entry = bucket[kind].get(unit.id) ?? { node: unit, weight: 0 };
      entry.weight += weight;
      bucket[kind].set(unit.id, entry);
    };

    for (let k = 0; k < this.edges.length; k++) {
      const e = this.edges[k];
      const si = this.edgeSource[k];
      const ti = this.edgeTarget[k];
      if (si < 0 || ti < 0) continue;
      const s = this.nodes[si];
      const t = this.nodes[ti];
      const sIn = inside(s);
      const tIn = inside(t);
      if (sIn && !tIn) add(outgoing, e.kind, t, e.weight ?? 1);
      else if (tIn && !sIn) add(incoming, e.kind, s, e.weight ?? 1);
    }

    return { outgoing, incoming };
  }

  search(query, limit = 30) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const node of this.nodes) {
      if (node.kind === 'assembly') continue;
      const name = node.name.toLowerCase();
      let score = -1;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if ((node.searchText ??= `${node.name} ${node.fullName ?? ''} ${node.location?.file ?? ''}`.toLowerCase()).includes(q)) score = 30;
      else if (fuzzy(name, q)) score = 15;
      if (score < 0) continue;
      score += node.level === 'type' ? 8 : node.level === 'member' ? 0 : 5;
      score += Math.min(6, Math.log1p(node.metrics.loc ?? 0));
      if (node.external) score -= 20;
      scored.push({ node, score });
    }

    scored.sort((a, b) => b.score - a.score || a.node.name.length - b.node.name.length);
    return scored.slice(0, limit).map((s) => s.node);
  }
}

function addLink(links, key, source, target, edge) {
  let link = links.get(key);
  if (!link) {
    link = { source, target, weight: 0, kinds: {} };
    links.set(key, link);
  }

  link.weight += edge.weight ?? 1;
  link.kinds[edge.kind] = (link.kinds[edge.kind] ?? 0) + (edge.weight ?? 1);
}

/** Drops weak links and names each by its strongest relationship kind. */
function finishLinks(links, state) {
  const minWeight = state.minWeight ?? 1;
  const result = [];
  for (const link of links.values()) {
    if (link.weight < minWeight) continue;
    let best = null;
    for (const [k, w] of Object.entries(link.kinds)) if (!best || w > link.kinds[best] || (w === link.kinds[best] && priority(k) > priority(best))) best = k;
    link.kind = best;
    result.push(link);
  }

  return result;
}

const PRIORITY = { inherits: 9, implements: 8, injects: 7, calls: 6, instantiates: 5, subscribes: 5, holds: 4, throws: 4, extends: 3, projectReference: 9 };
function priority(kind) {
  return PRIORITY[kind] ?? 0;
}

function fuzzy(text, query) {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i === query.length && query.length > 2;
}

/**
 * aggregateMixed() for the semantic zoom without going over every edge each time clusters open or close.
 * Built once from the links between the laid-out types (aggregated with minWeight 1): those links are summed
 * per pair of namespaces; a closed namespace (or project) then takes its pairs whole, only links of open
 * namespaces are regrouped one by one, and only the edges of open types (members on screen) are resolved
 * from the raw graph. Same result as aggregateMixed().
 */
export class MixedLinks {
  constructor(model, typeLinks) {
    this.model = model;
    const n = model.nodes.length;
    this.typeLinks = typeLinks.map((l) => ({ s: model.get(l.source), t: model.get(l.target), weight: l.weight, kinds: l.kinds }));
    const groups = new Map();
    this.byNamespace = new Map(); // namespace number -> links touching it
    this.loose = []; // links with an end outside any namespace: always one by one
    this.typeLinks.forEach((l) => {
      const ns = l.s?.namespaceNode;
      const nt = l.t?.namespaceNode;
      if (!ns || !nt) {
        this.loose.push(l);
        return;
      }

      for (const space of ns === nt ? [ns] : [ns, nt]) {
        let list = this.byNamespace.get(space.idx);
        if (!list) this.byNamespace.set(space.idx, (list = []));
        list.push(l);
      }

      const key = ns.idx * n + nt.idx;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { s: ns, t: nt, weight: 0, kinds: {} }));
      group.weight += l.weight;
      for (const kind in l.kinds) group.kinds[kind] = (group.kinds[kind] ?? 0) + l.kinds[kind];
    });
    this.groups = [...groups.values()];
    // Edges between projects or namespaces themselves (project references…) are not in the type links.
    this.upper = [];
    for (let k = 0; k < model.edges.length; k++) {
      const si = model.edgeSource[k];
      const ti = model.edgeTarget[k];
      if (si >= 0 && ti >= 0 && (model.nodes[si].levelIndex < 2 || model.nodes[ti].levelIndex < 2)) this.upper.push(k);
    }
  }

  /** Links between the given units (ids); `openTypes`: types whose members are among them. */
  links(unitIds, openTypes, state) {
    const model = this.model;
    const n = model.nodes.length;
    const isUnit = new Uint8Array(n);
    for (const id of unitIds) {
      const node = model.get(id);
      if (node) isUnit[node.idx] = 1;
    }

    const resolved = new Int32Array(n);
    const resolve = (node) => {
      const memo = resolved[node.idx];
      if (memo) return memo > 0 ? model.nodes[memo - 1] : null;
      let unit = null;
      if (isUnit[node.idx]) unit = node;
      else if (node.parent) unit = resolve(model.get(node.parent));
      resolved[node.idx] = unit ? unit.idx + 1 : -1;
      return unit;
    };

    const links = new Map();
    const merge = (su, tu, weight, kinds) => {
      const key = su.idx * n + tu.idx;
      let link = links.get(key);
      if (!link) links.set(key, (link = { source: su.id, target: tu.id, weight: 0, kinds: {} }));
      link.weight += weight;
      for (const kind in kinds) link.kinds[kind] = (link.kinds[kind] ?? 0) + kinds[kind];
    };

    // A namespace is closed when it or its project is a unit; open ones show their types.
    const open = (ns) => !resolve(ns);
    for (const g of this.groups) {
      if (open(g.s) || open(g.t)) continue;
      const su = resolve(g.s);
      const tu = resolve(g.t);
      if (su !== tu) merge(su, tu, g.weight, g.kinds);
    }

    const single = new Set(this.loose);
    for (const [idx, list] of this.byNamespace) if (open(model.nodes[idx])) for (const l of list) single.add(l);
    for (const l of single) {
      if (!l.s || !l.t || openTypes.has(l.s.id) || openTypes.has(l.t.id)) continue;
      const su = resolve(l.s);
      const tu = resolve(l.t);
      if (su && tu && su !== tu) merge(su, tu, l.weight, l.kinds);
    }

    // Edges resolved from the graph: those above the type level, and those of open types (members are units).
    const byType = model.edgesByType();
    const seen = new Set();
    const kinds = state.edgeKinds;
    for (const k of this.upper) {
      seen.add(k);
      const e = model.edges[k];
      if (!kinds.has(e.kind)) continue;
      const su = resolve(model.nodes[model.edgeSource[k]]);
      const tu = resolve(model.nodes[model.edgeTarget[k]]);
      if (su && tu && su !== tu) addLink(links, su.idx * n + tu.idx, su.id, tu.id, e);
    }

    for (const id of openTypes) {
      const type = model.get(id);
      for (const k of (type && byType.get(type.idx)) ?? []) {
        if (seen.has(k)) continue;
        seen.add(k);
        const e = model.edges[k];
        if (!kinds.has(e.kind)) continue;
        const su = resolve(model.nodes[model.edgeSource[k]]);
        const tu = resolve(model.nodes[model.edgeTarget[k]]);
        if (su && tu && su !== tu) addLink(links, su.idx * n + tu.idx, su.id, tu.id, e);
      }
    }

    return finishLinks(links, state);
  }
}

/** Fields the model adds to the graph's nodes at runtime (ancestors, colours…): not part of the file format. */
const RUNTIME_NODE_KEYS = new Set(['level', 'levelIndex', 'idx', 'anc', 'projectNode', 'namespaceNode', 'typeNode', 'isTest', 'searchText', 'baseColor']);

/** The loaded graph as CodeMap JSON again (the nodes hold circular runtime references). */
export function serializeDoc(doc) {
  const nodes = new Set(doc.nodes);
  return JSON.stringify(doc, function (key, value) {
    return nodes.has(this) && RUNTIME_NODE_KEYS.has(key) ? undefined : value;
  });
}

export function defaultEdgeKinds(model) {
  const kinds = new Set();
  for (const [kind, info] of Object.entries(EDGE_KINDS)) if (info.on) kinds.add(kind);
  // Tiny graphs read better with every relation; huge ones need the noise removed.
  if (model.edges.length < 150) for (const kind of Object.keys(model.edgeKindCounts)) kinds.add(kind);
  return kinds;
}
