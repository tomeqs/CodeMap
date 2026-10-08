/**
 * Adjacency of the links on screen in compressed form (CSR): for each unit, its outgoing and incoming
 * links as ranges of typed arrays. Walks over large graphs (dependencies, impact, paths) use integer
 * queues instead of arrays of objects.
 */
export class GraphIndex {
  /** links: [{ source, target }] (ids); a link's position in the array is its index. */
  constructor(links) {
    const index = new Map();
    const ids = [];
    const idOf = (id) => {
      let i = index.get(id);
      if (i === undefined) {
        i = ids.length;
        index.set(id, i);
        ids.push(id);
      }

      return i;
    };

    const source = new Int32Array(links.length);
    const target = new Int32Array(links.length);
    links.forEach((l, i) => {
      source[i] = idOf(l.source);
      target[i] = idOf(l.target);
    });

    this.index = index;
    this.ids = ids;
    this.out = csr(ids.length, source, target);
    this.in = csr(ids.length, target, source);
  }

  /** Number of links leaving / entering a unit. */
  degree(id, direction = 'out') {
    const i = this.index.get(id);
    if (i === undefined) return 0;
    const { start } = this[direction];
    return start[i + 1] - start[i];
  }

  /** Calls fn(neighbourId, linkIndex) for every link of the unit in the direction. */
  forEach(id, direction, fn) {
    const i = this.index.get(id);
    if (i === undefined) return;
    const { start, to, link } = this[direction];
    for (let k = start[i]; k < start[i + 1]; k++) fn(this.ids[to[k]], link[k]);
  }

  /** Everything reachable from `id` (breadth first): the units and the links walked. */
  reach(id, direction = 'out') {
    const nodes = new Set([id]);
    const links = new Set();
    const first = this.index.get(id);
    if (first === undefined) return { nodes, links };
    const { start, to, link } = this[direction];
    const seen = new Uint8Array(this.ids.length);
    const queue = new Int32Array(this.ids.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = first;
    seen[first] = 1;
    while (head < tail) {
      const i = queue[head++];
      for (let k = start[i]; k < start[i + 1]; k++) {
        links.add(link[k]);
        const j = to[k];
        if (seen[j]) continue;
        seen[j] = 1;
        nodes.add(this.ids[j]);
        queue[tail++] = j;
      }
    }

    return { nodes, links };
  }

  /** Shortest path along outgoing links: { nodes: [ids], links: [link indices] } or null. */
  path(from, to) {
    const a = this.index.get(from);
    const b = this.index.get(to);
    if (a === undefined || b === undefined) return null;
    const { start, to: next, link } = this.out;
    const previous = new Int32Array(this.ids.length).fill(-1);
    const via = new Int32Array(this.ids.length);
    const queue = new Int32Array(this.ids.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = a;
    previous[a] = a;
    while (head < tail && previous[b] < 0) {
      const i = queue[head++];
      for (let k = start[i]; k < start[i + 1]; k++) {
        const j = next[k];
        if (previous[j] >= 0) continue;
        previous[j] = i;
        via[j] = link[k];
        queue[tail++] = j;
      }
    }

    if (previous[b] < 0) return null;
    const nodes = [];
    const links = [];
    for (let i = b; ; i = previous[i]) {
      nodes.unshift(this.ids[i]);
      if (i === a) break;
      links.push(via[i]);
    }

    return { nodes, links };
  }
}

/** Groups link indices by `from` (counting sort): start[i]..start[i+1] are the links of unit i. */
function csr(count, from, to) {
  const start = new Int32Array(count + 1);
  for (let k = 0; k < from.length; k++) start[from[k] + 1]++;
  for (let i = 0; i < count; i++) start[i + 1] += start[i];
  const fill = start.slice(0, count);
  const neighbour = new Int32Array(from.length);
  const link = new Int32Array(from.length);
  for (let k = 0; k < from.length; k++) {
    const slot = fill[from[k]]++;
    neighbour[slot] = to[k];
    link[slot] = k;
  }

  return { start, to: neighbour, link };
}
