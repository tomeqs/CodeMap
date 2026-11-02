/** Nodes, and edges counted per (source, target, kind) with the first line they occur on. */
export class Graph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  addNode(node) {
    const existing = this.nodes.get(node.id);
    if (existing) return existing;
    this.nodes.set(node.id, node);
    return node;
  }

  has(id) {
    return this.nodes.has(id);
  }

  addEdge(source, target, kind, line = 0) {
    if (!source || !target || (source === target && kind !== 'calls')) return;
    const key = `${source}\u0000${target}\u0000${kind}`;
    const edge = this.edges.get(key);
    if (edge) {
      edge.weight++;
      if (line && (!edge.line || line < edge.line)) edge.line = line;
    } else {
      this.edges.set(key, line ? { source, target, kind, weight: 1, line } : { source, target, kind, weight: 1 });
    }
  }

  /** Edges whose ends are both nodes of the graph (others pointed at code that was not analyzed). */
  connectedEdges() {
    return [...this.edges.values()].filter((e) => this.nodes.has(e.source) && this.nodes.has(e.target));
  }
}
