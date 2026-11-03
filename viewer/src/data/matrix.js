/**
 * Dependency structure matrix (DSM): the units on both axes in the same order; cell (row, column) means
 * "row uses column". The order partitions the graph the way DSM tools do:
 *
 * - every cycle (strongly connected component) is one contiguous block on the diagonal;
 * - blocks come in levels from the bottom up: level 0 uses nothing that is visible, every other level only
 *   uses lower ones. Dependencies between blocks therefore always fall below the diagonal;
 * - inside a cycle the units keep computeLayers' order (the one that cuts the fewest links), so only the
 *   links that close the cycle (computeLayers' `upward` links) end up above the diagonal.
 *
 * Within a level, units are grouped by their parent (project / namespace / folder), then by name.
 *
 * @param {object[]} units model nodes at one level
 * @param {{source:string, target:string, weight:number, kind:string}[]} links aggregated links between them
 * @param {{ order: string[], components: string[][], upward: Set<object> }} layering computeLayers(units, links)
 */
export function buildMatrix(units, links, layering) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const bottomUp = [...layering.order].reverse().filter((id) => byId.has(id));
  const position = new Map(bottomUp.map((id, i) => [id, i]));
  for (const u of units) if (!position.has(u.id)) position.set(u.id, position.size);

  // Components: the cycles, then every other unit on its own; members used-first.
  const componentOf = new Map();
  const components = [];
  for (const members of layering.components) {
    const present = members.filter((id) => byId.has(id)).sort((a, b) => position.get(a) - position.get(b));
    if (present.length < 2) continue;
    for (const id of present) componentOf.set(id, components.length);
    components.push(present);
  }

  for (const u of units) {
    if (componentOf.has(u.id)) continue;
    componentOf.set(u.id, components.length);
    components.push([u.id]);
  }

  // Levels of the components: what a component uses comes earlier in `bottomUp`.
  const uses = components.map(() => new Set());
  for (const l of links) {
    const a = componentOf.get(l.source);
    const b = componentOf.get(l.target);
    if (a !== undefined && b !== undefined && a !== b) uses[a].add(b);
  }

  const sequence = components.map((_, c) => c).sort((a, b) => position.get(components[a][0]) - position.get(components[b][0]));
  const level = new Int32Array(components.length).fill(-1);
  const levelOf = (c, stack = new Set()) => {
    if (level[c] >= 0) return level[c];
    stack.add(c);
    let height = 0;
    for (const d of uses[c]) if (!stack.has(d)) height = Math.max(height, levelOf(d, stack) + 1);
    stack.delete(c);
    return (level[c] = height);
  };
  for (const c of sequence) levelOf(c);

  const nameOf = (c) => byId.get(components[c][0]);
  const groupOf = (c) => nameOf(c).parent ?? '';
  const ordered = [...sequence].sort((a, b) =>
    level[a] - level[b] ||
    cmp(groupOf(a), groupOf(b)) ||
    cmp(nameOf(a).name ?? '', nameOf(b).name ?? '') ||
    position.get(components[a][0]) - position.get(components[b][0]));

  const order = [];
  const index = new Map();
  const blocks = [];
  const levels = [];
  for (const c of ordered) {
    const from = order.length;
    for (const id of components[c]) {
      index.set(id, order.length);
      order.push(byId.get(id));
    }

    if (components[c].length > 1) blocks.push({ from, to: order.length - 1, ids: components[c] });
    const last = levels[levels.length - 1];
    if (last && last.level === level[c]) last.to = order.length - 1;
    else levels.push({ level: level[c], from, to: order.length - 1 });
  }

  const cells = [];
  links.forEach((link, linkIndex) => {
    const row = index.get(link.source);
    const col = index.get(link.target);
    if (row === undefined || col === undefined || row === col) return;
    cells.push({ row, col, link, linkIndex, weight: link.weight, kind: link.kind, upward: layering.upward.has(link) });
  });

  return { order, index, cells, blocks, levels };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
