/**
 * Layers a dependency graph so that dependencies point down (same algorithm as the analyzer's
 * Layering.cs): strongly connected components in topological order, a weighted greedy feedback-arc-set
 * ordering inside each cycle, longest-path layers, then a pull-up pass that places every node right
 * below its lowest user. Edges that still do not point down are "upward" – cutting them removes all cycles.
 * Nodes are numbered in name order (every tie goes to the first name) and the work runs on typed arrays:
 * 100k types take well under a second.
 *
 * @param {string[]} nodes
 * @param {{source:string, target:string, weight:number}[]} links  source depends on target
 * @returns {{ layerOf: Map<string, number>, count: number, upward: Set<object> }}
 */
export function computeLayers(nodes, links) {
  const ids = [...new Set(nodes)].sort();
  const n = ids.length;
  const at = new Map(ids.map((id, i) => [id, i]));

  // Every link's ends as node numbers (-1: not a node, or a self-reference).
  const L = links.length;
  const linkSource = new Int32Array(L);
  const linkTarget = new Int32Array(L);
  const rawStart = new Int32Array(n + 1);
  links.forEach((l, k) => {
    const s = at.get(l.source) ?? -1;
    const t = at.get(l.target) ?? -1;
    const valid = s >= 0 && t >= 0 && s !== t;
    linkSource[k] = valid ? s : -1;
    linkTarget[k] = valid ? t : -1;
    if (valid) rawStart[s + 1]++;
  });
  for (let i = 0; i < n; i++) rawStart[i + 1] += rawStart[i];
  const rawFill = rawStart.slice(0, n);
  const rawLink = new Int32Array(rawStart[n]);
  for (let k = 0; k < L; k++) if (linkSource[k] >= 0) rawLink[rawFill[linkSource[k]]++] = k;

  // One edge per (source, target) with the summed weight; each node's targets in order, then its sources.
  const graph = {
    n,
    outStart: new Int32Array(n + 1),
    outNode: new Int32Array(rawStart[n]),
    outWeight: new Float64Array(rawStart[n]),
    inStart: new Int32Array(n + 1),
    inNode: null,
    inWeight: null,
  };
  const seenBy = new Int32Array(n).fill(-1);
  const sum = new Float64Array(n);
  let m = 0;
  for (let s = 0; s < n; s++) {
    const first = m;
    for (let r = rawStart[s]; r < rawStart[s + 1]; r++) {
      const k = rawLink[r];
      const t = linkTarget[k];
      if (seenBy[t] !== s) {
        seenBy[t] = s;
        sum[t] = 0;
        graph.outNode[m++] = t;
      }

      sum[t] += links[k].weight ?? 1;
    }

    graph.outNode.subarray(first, m).sort();
    for (let e = first; e < m; e++) {
      const t = graph.outNode[e];
      graph.outWeight[e] = sum[t];
      graph.inStart[t + 1]++;
    }

    graph.outStart[s + 1] = m;
  }

  for (let i = 0; i < n; i++) graph.inStart[i + 1] += graph.inStart[i];
  graph.inNode = new Int32Array(m);
  graph.inWeight = new Float64Array(m);
  const inFill = graph.inStart.slice(0, n);
  for (let s = 0; s < n; s++) {
    for (let e = graph.outStart[s]; e < graph.outStart[s + 1]; e++) {
      const f = inFill[graph.outNode[e]]++; // sources come in order
      graph.inNode[f] = s;
      graph.inWeight[f] = graph.outWeight[e];
    }
  }

  const order = orderNodes(graph);
  const position = new Int32Array(n);
  order.forEach((v, i) => (position[v] = i));

  const layer = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const v = order[i];
    let height = 0;
    for (let e = graph.outStart[v]; e < graph.outStart[v + 1]; e++) {
      const t = graph.outNode[e];
      if (position[t] > i && layer[t] + 1 > height) height = layer[t] + 1;
    }

    layer[v] = height;
  }

  for (const v of order) {
    let lowestUser = Infinity;
    for (let e = graph.inStart[v]; e < graph.inStart[v + 1]; e++) {
      const s = graph.inNode[e];
      if (position[s] < position[v] && layer[s] < lowestUser) lowestUser = layer[s];
    }

    if (lowestUser !== Infinity && lowestUser - 1 > layer[v]) layer[v] = lowestUser - 1;
  }

  const layerOf = new Map();
  let count = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = order[i];
    layerOf.set(ids[v], layer[v]);
    if (layer[v] + 1 > count) count = layer[v] + 1;
  }

  const upward = new Set();
  for (let k = 0; k < L; k++) if (linkSource[k] >= 0 && layer[linkTarget[k]] >= layer[linkSource[k]]) upward.add(links[k]);

  return { layerOf, count, upward };
}

function orderNodes(graph) {
  const components = stronglyConnected(graph);
  const componentOf = new Int32Array(graph.n);
  components.forEach((members, c) => members.forEach((v) => (componentOf[v] = c)));

  const indegree = new Int32Array(components.length);
  const successors = components.map(() => []);
  const seen = new Set();
  for (let s = 0; s < graph.n; s++) {
    const a = componentOf[s];
    for (let e = graph.outStart[s]; e < graph.outStart[s + 1]; e++) {
      const b = componentOf[graph.outNode[e]];
      if (a === b || seen.has(a * components.length + b)) continue;
      seen.add(a * components.length + b);
      successors[a].push(b);
      indegree[b]++;
    }
  }

  // Components without remaining dependencies, the one with the smallest name first.
  const ready = new Heap((a, b) => components[a][0] - components[b][0]);
  components.forEach((_, c) => indegree[c] === 0 && ready.push(c));
  const order = [];
  const local = new Int32Array(graph.n).fill(-1);
  while (ready.size) {
    const next = ready.pop();
    const members = components[next];
    if (members.length === 1) order.push(members[0]);
    else for (const v of greedyOrder(members, graph, local)) order.push(v);
    for (const c of successors[next]) if (--indegree[c] === 0) ready.push(c);
  }

  return order;
}

/**
 * Eades–Lin–Smyth inside one strongly connected component (`members` sorted). Rounds of: every sink in
 * name order to the back, then every source in name order to the front, as long as there are any; then
 * the node with the most outgoing over incoming weight (the first by name on a tie) to the front. A node
 * that becomes a sink (source) while its round runs joins it if it comes later by name, else the next
 * round. Heaps keep this O((nodes + edges) log nodes); a big cycle used to take quadratic time.
 * `local`: -1 for every node, a scratch map from node to member index (left as it was found).
 */
function greedyOrder(members, graph, local) {
  const k = members.length;
  members.forEach((v, i) => (local[v] = i));
  // Edges within the component, by member index.
  const succ = [];
  const pred = [];
  const outW = new Float64Array(k);
  const inW = new Float64Array(k);
  members.forEach((v, i) => {
    const out = [];
    for (let e = graph.outStart[v]; e < graph.outStart[v + 1]; e++) {
      const t = local[graph.outNode[e]];
      if (t < 0) continue;
      out.push(t, graph.outWeight[e]);
      outW[i] += graph.outWeight[e];
    }

    const into = [];
    for (let e = graph.inStart[v]; e < graph.inStart[v + 1]; e++) {
      const s = local[graph.inNode[e]];
      if (s < 0) continue;
      into.push(s, graph.inWeight[e]);
      inW[i] += graph.inWeight[e];
    }

    succ.push(out);
    pred.push(into);
  });
  for (const v of members) local[v] = -1;

  const remaining = new Uint8Array(k).fill(1);
  let left = k;
  const byIndex = (a, b) => a - b;
  // The node with the highest out − in weight, the lowest index on a tie; stale entries are skipped.
  const best = new BestHeap();
  const sinks = { heap: new Heap(byIndex), next: [], cursor: -1, active: false };
  const sources = { heap: new Heap(byIndex), next: [], cursor: -1, active: false };
  const became = (round, i) => (round.active && i > round.cursor ? round.heap.push(i) : round.next.push(i));
  for (let i = 0; i < k; i++) {
    if (outW[i] === 0) sinks.next.push(i);
    if (inW[i] === 0) sources.next.push(i);
    best.push(outW[i] - inW[i], i);
  }

  const remove = (v) => {
    remaining[v] = 0;
    left--;
    const out = succ[v];
    for (let j = 0; j < out.length; j += 2) {
      const t = out[j];
      if (!remaining[t]) continue;
      inW[t] -= out[j + 1];
      if (inW[t] === 0) became(sources, t);
      else if (outW[t] !== 0) best.push(outW[t] - inW[t], t); // sinks and sources never get to be the best
    }

    const into = pred[v];
    for (let j = 0; j < into.length; j += 2) {
      const s = into[j];
      if (!remaining[s]) continue;
      outW[s] -= into[j + 1];
      if (outW[s] === 0) became(sinks, s);
      else if (inW[s] !== 0) best.push(outW[s] - inW[s], s);
    }
  };

  const round = (state, isEnd, list) => {
    for (const i of state.next) state.heap.push(i);
    state.next = [];
    state.active = true;
    state.cursor = -1;
    let removed = false;
    while (state.heap.size) {
      const v = state.heap.pop();
      if (!remaining[v] || !isEnd(v)) continue;
      state.cursor = v;
      list.push(v);
      remove(v);
      removed = true;
    }

    state.active = false;
    return removed;
  };

  const front = [];
  const back = [];
  while (left) {
    let changed = true;
    while (changed && left) {
      const a = round(sinks, (v) => outW[v] === 0, back);
      const b = round(sources, (v) => inW[v] === 0, front);
      changed = a || b;
    }

    if (!left) break;
    for (;;) {
      const key = best.topKey();
      const v = best.pop();
      if (remaining[v] && key === outW[v] - inW[v]) {
        front.push(v);
        remove(v);
        break;
      }
    }
  }

  return [...front, ...back.reverse()].map((i) => members[i]);
}

/** Iterative Tarjan over node numbers (neighbours in order); returns every component, members sorted. */
function stronglyConnected(graph) {
  const n = graph.n;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = [];
  const result = [];
  const workNode = new Int32Array(n);
  const workEdge = new Int32Array(n);
  let counter = 0;

  for (let start = 0; start < n; start++) {
    if (index[start] >= 0) continue;
    index[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = 1;
    workNode[0] = start;
    workEdge[0] = graph.outStart[start];
    let depth = 1;

    while (depth) {
      const node = workNode[depth - 1];
      if (workEdge[depth - 1] < graph.outStart[node + 1]) {
        const next = graph.outNode[workEdge[depth - 1]++];
        if (index[next] < 0) {
          index[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = 1;
          workNode[depth] = next;
          workEdge[depth] = graph.outStart[next];
          depth++;
        } else if (onStack[next] && index[next] < low[node]) {
          low[node] = index[next];
        }

        continue;
      }

      depth--;
      if (depth) {
        const parent = workNode[depth - 1];
        if (low[node] < low[parent]) low[parent] = low[node];
      }

      if (low[node] === index[node]) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack[member] = 0;
          component.push(member);
        } while (member !== node);
        result.push(component.sort((a, b) => a - b));
      }
    }
  }

  return result;
}

/** Binary min-heap. */
class Heap {
  constructor(compare) {
    this.compare = compare;
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.compare(items[l], items[m]) < 0) m = l;
        if (r < items.length && this.compare(items[r], items[m]) < 0) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }

    return top;
  }
}

/** Max-heap of (key, node): the highest key first, the lowest node on a tie. Parallel arrays, no objects. */
class BestHeap {
  constructor() {
    this.keys = [];
    this.nodes = [];
  }

  /** a before b? */
  before(a, b) {
    const ka = this.keys[a];
    const kb = this.keys[b];
    return ka > kb || (ka === kb && this.nodes[a] < this.nodes[b]);
  }

  swap(a, b) {
    const { keys, nodes } = this;
    const key = keys[a];
    keys[a] = keys[b];
    keys[b] = key;
    const node = nodes[a];
    nodes[a] = nodes[b];
    nodes[b] = node;
  }

  push(key, node) {
    this.keys.push(key);
    this.nodes.push(node);
    for (let i = this.keys.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  topKey() {
    return this.keys[0];
  }

  pop() {
    const { keys, nodes } = this;
    const top = nodes[0];
    const lastKey = keys.pop();
    const lastNode = nodes.pop();
    if (keys.length) {
      keys[0] = lastKey;
      nodes[0] = lastNode;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < keys.length && this.before(l, m)) m = l;
        if (r < keys.length && this.before(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }

    return top;
  }
}
