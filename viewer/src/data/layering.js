/**
 * Layers a dependency graph so that dependencies point down (same algorithm as the analyzer's
 * Layering.cs): strongly connected components in topological order, a weighted greedy feedback-arc-set
 * ordering inside each cycle, longest-path layers, then a pull-up pass that places every node right
 * below its lowest user. Edges that still do not point down are "upward" – cutting them removes all cycles.
 *
 * @param {string[]} nodes
 * @param {{source:string, target:string, weight:number}[]} links  source depends on target
 * @returns {{ layerOf: Map<string, number>, count: number, upward: Set<object> }}
 */
export function computeLayers(nodes, links) {
  const ids = [...new Set(nodes)].sort();
  const out = new Map(ids.map((id) => [id, new Map()]));
  const inc = new Map(ids.map((id) => [id, new Map()]));
  for (const l of links) {
    if (l.source === l.target || !out.has(l.source) || !out.has(l.target)) continue;
    const w = l.weight ?? 1;
    out.get(l.source).set(l.target, (out.get(l.source).get(l.target) ?? 0) + w);
    inc.get(l.target).set(l.source, (inc.get(l.target).get(l.source) ?? 0) + w);
  }

  const order = orderNodes(ids, out, inc);
  const position = new Map(order.map((id, i) => [id, i]));

  const layer = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    let height = 0;
    for (const target of out.get(node).keys()) if (position.get(target) > i) height = Math.max(height, layer.get(target) + 1);
    layer.set(node, height);
  }

  for (const node of order) {
    let lowestUser = Infinity;
    for (const source of inc.get(node).keys()) if (position.get(source) < position.get(node)) lowestUser = Math.min(lowestUser, layer.get(source));
    if (lowestUser !== Infinity && lowestUser - 1 > layer.get(node)) layer.set(node, lowestUser - 1);
  }

  const upward = new Set(links.filter((l) => layer.has(l.source) && layer.has(l.target) && l.source !== l.target && layer.get(l.target) >= layer.get(l.source)));
  let count = 0;
  for (const value of layer.values()) if (value + 1 > count) count = value + 1; // no spread: it overflows the stack on big graphs
  return { layerOf: layer, count, upward };
}

function orderNodes(ids, out, inc) {
  const components = stronglyConnected(ids, out);
  const componentOf = new Map();
  components.forEach((members, i) => members.forEach((m) => componentOf.set(m, i)));

  const indegree = new Array(components.length).fill(0);
  const successors = components.map(() => new Set());
  for (const [source, targets] of out) {
    for (const target of targets.keys()) {
      const a = componentOf.get(source);
      const b = componentOf.get(target);
      if (a !== b && !successors[a].has(b)) {
        successors[a].add(b);
        indegree[b]++;
      }
    }
  }

  // Components without remaining dependencies, the one with the smallest name first.
  const ready = new Heap((a, b) => cmp(components[a][0], components[b][0]));
  components.forEach((_, i) => indegree[i] === 0 && ready.push(i));
  const order = [];
  while (ready.size) {
    const next = ready.pop();
    const members = components[next];
    if (members.length === 1) order.push(members[0]);
    else for (const m of greedyOrder(members, out, inc)) order.push(m);
    for (const s of successors[next]) if (--indegree[s] === 0) ready.push(s);
  }

  return order;
}

/** Eades–Lin–Smyth inside one strongly connected component (`members` is sorted). */
function greedyOrder(members, out, inc) {
  const remaining = new Set(members);
  const outW = new Map();
  const inW = new Map();
  for (const m of members) {
    let o = 0;
    let i = 0;
    for (const [t, w] of out.get(m)) if (remaining.has(t)) o += w;
    for (const [s, w] of inc.get(m)) if (remaining.has(s)) i += w;
    outW.set(m, o);
    inW.set(m, i);
  }

  const front = [];
  const back = [];
  const remove = (node) => {
    remaining.delete(node);
    for (const [t, w] of out.get(node)) if (remaining.has(t)) inW.set(t, inW.get(t) - w);
    for (const [s, w] of inc.get(node)) if (remaining.has(s)) outW.set(s, outW.get(s) - w);
  };

  // The remaining nodes in name order, compacted now and then (instead of sorting them on every pass).
  let sorted = members;
  while (remaining.size) {
    if (sorted.length > remaining.size * 2) sorted = sorted.filter((n) => remaining.has(n));
    let changed = true;
    while (changed && remaining.size) {
      changed = false;
      for (const n of sorted) {
        if (remaining.has(n) && outW.get(n) === 0) {
          back.push(n);
          remove(n);
          changed = true;
        }
      }

      for (const n of sorted) {
        if (remaining.has(n) && inW.get(n) === 0) {
          front.push(n);
          remove(n);
          changed = true;
        }
      }
    }

    if (!remaining.size) break;
    let best = null;
    for (const n of sorted) if (remaining.has(n) && (best === null || outW.get(n) - inW.get(n) > outW.get(best) - inW.get(best))) best = n;
    front.push(best);
    remove(best);
  }

  return [...front, ...back.reverse()];
}

/** Iterative Tarjan; returns every component (singletons included), members sorted. */
function stronglyConnected(ids, out) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;

  for (const start of ids) {
    if (index.has(start)) continue;
    const work = [[start, [...out.get(start).keys()].sort(), 0]];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1];
      const [node, neighbours] = frame;
      if (frame[2] < neighbours.length) {
        const next = neighbours[frame[2]++];
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter++);
          stack.push(next);
          onStack.add(next);
          work.push([next, [...out.get(next).keys()].sort(), 0]);
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node), index.get(next)));
        }

        continue;
      }

      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }

      if (low.get(node) === index.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        result.push(component.sort());
      }
    }
  }

  return result;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
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
