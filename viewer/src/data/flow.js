/**
 * Call flow: what happens when an entry point runs. Follows `calls` edges in source order (edges carry the
 * line of the first call), through interface and abstract members to their implementations. When the DI
 * analysis knows which implementation the caller receives, only that one is followed.
 */

const ROLE_ENTRIES = [
  { role: 'controller', title: 'Controllers', methods: (m) => isPublicInstance(m) },
  { role: 'hub', title: 'SignalR hubs', methods: (m) => isPublicInstance(m) },
  { role: 'hosted-service', title: 'Background services', methods: (m) => /^(ExecuteAsync|StartAsync|StopAsync)$/.test(m.name) },
  { role: 'handler', title: 'Handlers', methods: (m) => /^(Handle|HandleAsync|Consume|ConsumeAsync|Execute|ExecuteAsync)$/.test(m.name) },
  { role: 'middleware', title: 'Middleware', methods: (m) => /^(Invoke|InvokeAsync)$/.test(m.name) },
  { role: 'entrypoint', title: 'Program entry', methods: (m) => m.tags.includes('entrypoint') },
];

function isPublicInstance(m) {
  return m.kind === 'method' && m.accessibility === 'public' && !m.modifiers?.includes('static');
}

/** Indexes the model once: calls in source order, implementations of abstract members, DI wiring. */
export function flowIndex(model) {
  if (model._flowIndex) return model._flowIndex;
  const calls = new Map();
  const implementors = new Map();
  for (const e of model.edges) {
    if (e.kind === 'calls' || e.kind === 'instantiates') {
      if (!calls.has(e.source)) calls.set(e.source, []);
      calls.get(e.source).push(e);
    } else if ((e.kind === 'implements' || e.kind === 'overrides') && e.source.startsWith('M:')) {
      if (!implementors.has(e.target)) implementors.set(e.target, []);
      implementors.get(e.target).push(e.source);
    }
  }

  for (const list of calls.values()) {
    list.sort((a, b) => (a.line || 1e9) - (b.line || 1e9) || (a.kind === b.kind ? 0 : a.kind === 'instantiates' ? -1 : 1) || cmp(a.target, b.target));
  }

  const injected = new Map();
  for (const d of model.doc.analysis?.di?.dependencies ?? []) {
    if (d.implementations?.length) injected.set(d.consumer + '\u0000' + d.service, { implementations: d.implementations, many: !!d.many });
  }

  model._flowIndex = { calls, implementors, injected };
  return model._flowIndex;
}

function isAbstractMember(node) {
  return node.typeNode?.kind === 'interface' || !!node.modifiers?.includes('abstract');
}

/**
 * @param roots method ids (a type id expands to its entry methods)
 * @returns {{ roots: object[], tree: object[], nodes: Map, links: object[], depthOf: Map, stats: object }}
 *   tree nodes: { id, node, kind: 'call'|'create', line, children, dispatch?, repeat?, recursive?, truncated? }
 */
export function buildCallFlow(model, rootIds, { maxDepth = 8, maxNodes = 600, showTests = true, hiddenProjects = new Set() } = {}) {
  const index = flowIndex(model);
  const roots = expandRoots(model, rootIds);
  const visible = (n) => n && !n.external && (showTests || !n.isTest) && !hiddenProjects.has(n.projectNode?.id);
  const expanded = new Set();
  let count = 0;
  let truncated = false;

  const implementationsOf = (target, caller) => {
    const all = (index.implementors.get(target.id) ?? []).filter((id) => visible(model.get(id)));
    if (!all.length || !isAbstractMember(target)) return null;
    const wired = caller?.typeNode && index.injected.get(caller.typeNode.id + '\u0000' + target.typeNode?.id);
    if (wired) {
      const allowed = new Set(wired.implementations);
      const narrowed = all.filter((id) => allowed.has(model.get(id)?.typeNode?.id));
      // IEnumerable<T>: the caller gets every implementation and typically calls each one.
      if (narrowed.length) return { ids: narrowed, narrowed: true, many: wired.many, total: all.length };
    }

    return { ids: all.slice(0, 6), narrowed: false, many: false, total: all.length };
  };

  const expand = (id, depth, path, line = 0) => {
    const node = model.get(id);
    const t = { id, node, kind: 'call', line, children: [] };
    count++;
    const outgoing = index.calls.get(id) ?? [];
    if (path.has(id)) return Object.assign(t, { recursive: true });
    if (expanded.has(id)) return Object.assign(t, { repeat: outgoing.length > 0 });
    if (!outgoing.length) return t;
    if (depth >= maxDepth || count >= maxNodes) {
      truncated = true;
      return Object.assign(t, { truncated: true });
    }

    expanded.add(id);
    path.add(id);
    for (const call of outgoing) {
      const target = model.get(call.target);
      if (!visible(target)) continue;
      if (call.kind === 'instantiates') {
        t.children.push({ id: target.id, node: target, kind: 'create', line: call.line ?? 0, children: [] });
        continue;
      }

      const implementations = implementationsOf(target, node);
      if (implementations) {
        count++;
        t.children.push({
          id: target.id,
          node: target,
          kind: 'call',
          line: call.line ?? 0,
          children: [],
          dispatch: { ...implementations, targets: implementations.ids.map((impl) => expand(impl, depth + 1, path, call.line ?? 0)) },
        });
      } else {
        t.children.push(expand(target.id, depth + 1, path, call.line ?? 0));
      }
    }

    path.delete(id);
    return t;
  };

  const tree = roots.map((root) => expand(root.id, 0, new Set()));
  const graph = flowGraph(tree);
  const types = new Set([...graph.nodes.values()].map((n) => n.typeNode?.id).filter(Boolean));
  return {
    roots,
    tree,
    ...graph,
    stats: { methods: graph.nodes.size, types: types.size, depth: Math.max(0, ...graph.depthOf.values()), truncated, maxDepth },
  };
}

function expandRoots(model, rootIds) {
  const result = [];
  for (const id of rootIds) {
    const node = model.get(id);
    if (!node) continue;
    if (node.level === 'member') result.push(node);
    else result.push(...entryMethodsOf(model, node));
  }

  return result;
}

/** The methods of a type that start a flow: actions of a controller, ExecuteAsync of a hosted service... */
export function entryMethodsOf(model, type) {
  const members = model.childrenOf(type.id).filter((m) => m.kind === 'method');
  for (const entry of ROLE_ENTRIES) {
    if (!type.tags.includes(entry.role)) continue;
    const methods = members.filter(entry.methods);
    if (methods.length) return methods;
  }

  const outgoing = flowIndex(model).calls;
  const publicMethods = members.filter((m) => m.accessibility === 'public' && outgoing.has(m.id));
  return publicMethods.length ? publicMethods : members.filter((m) => outgoing.has(m.id));
}

/** Unique methods and call / dispatch links of a flow tree, with the shortest call depth of each method. */
function flowGraph(tree) {
  const nodes = new Map();
  const links = new Map();
  const depthOf = new Map();
  const link = (source, target, kind, recursive) => {
    const key = source + '\u0000' + target;
    const existing = links.get(key);
    if (existing) return existing.weight++;
    links.set(key, { source, target, kind, kinds: { [kind]: 1 }, weight: 1, recursive });
  };

  const visit = (t, depth) => {
    if (t.kind === 'create') return;
    nodes.set(t.id, t.node);
    if (!(depthOf.get(t.id) <= depth)) depthOf.set(t.id, depth);
    for (const child of t.children) {
      if (child.kind === 'create') continue;
      link(t.id, child.id, 'calls', !!child.recursive);
      visit(child, depth + 1);
    }

    for (const target of t.dispatch?.targets ?? []) {
      link(t.id, target.id, 'implements', !!target.recursive);
      visit(target, depth); // dispatch is not a call level: the implementation sits next to its interface
    }
  };

  for (const root of tree) visit(root, 0);
  return { nodes, links: [...links.values()], depthOf };
}

/** Likely entry points, best first: controllers, hubs, background services, handlers, middleware, Main. */
export function findEntryPoints(model, { limit = 40 } = {}) {
  const index = flowIndex(model);
  const result = [];
  for (const type of model.nodes) {
    if (type.level !== 'type' || type.external || type.isTest) continue;
    const entry = ROLE_ENTRIES.find((e) => type.tags.includes(e.role));
    if (!entry) continue;
    const methods = entryMethodsOf(model, type).filter((m) => index.calls.has(m.id));
    if (!methods.length) continue;
    result.push({ node: type, role: entry.role, title: entry.title, methods });
  }

  for (const r of result) r.reach = buildCallFlow(model, [r.node.id], { maxDepth: 12, maxNodes: 400 }).nodes.size;
  const order = new Map(ROLE_ENTRIES.map((e, i) => [e.role, i]));
  result.sort((a, b) => order.get(a.role) - order.get(b.role) || b.reach - a.reach || cmp(a.node.name, b.node.name));
  return result.slice(0, limit);
}

// ---------------------------------------------------------------------- sequence diagram

/**
 * Flattens one flow tree into sequence-diagram steps. Participants are types; a call through an
 * interface goes straight to the implementation (labelled with the interface), several possible
 * implementations become an `alt` block. Object creation is shown only for types that also take part.
 */
export function sequenceOf(root) {
  const participants = [];
  const indexOf = new Map();
  const participant = (node) => {
    const type = node.typeNode ?? node;
    if (!indexOf.has(type.id)) {
      indexOf.set(type.id, participants.length);
      participants.push({ id: type.id, node: type, name: type.name });
    }

    return indexOf.get(type.id);
  };

  // Participants first, so creations can be filtered to types that are called.
  const called = new Set();
  const collect = (t) => {
    if (t.kind === 'create') return;
    called.add((t.node.typeNode ?? t.node).id);
    t.children.forEach(collect);
    t.dispatch?.targets.forEach(collect);
  };
  collect(root);

  const steps = [];
  const walk = (t, from) => {
    for (const child of t.children) {
      if (child.kind === 'create') {
        if (called.has(child.node.id)) steps.push({ type: 'create', from, to: participant(child.node), label: `new ${child.node.name}`, id: child.id });
        continue;
      }

      if (child.dispatch) {
        const targets = child.dispatch.targets;
        const via = child.node.typeNode?.name ?? '';
        if (targets.length === 1) {
          message(targets[0], from, `${child.node.name}()`, via);
        } else if (child.dispatch.many) {
          steps.push({ type: 'loop', label: `each ${via}` });
          for (const target of targets) message(target, from, `${child.node.name}()`, via);
          steps.push({ type: 'end' });
        } else {
          targets.forEach((target, i) => {
            steps.push({ type: i === 0 ? 'alt' : 'else', label: target.node.typeNode?.name ?? target.node.name });
            message(target, from, `${child.node.name}()`, via);
          });
          steps.push({ type: 'end' });
        }

        continue;
      }

      message(child, from, `${child.node.name}()`);
    }
  };

  const message = (t, from, label, via) => {
    const to = participant(t.node);
    const note = t.recursive ? 'recursion' : t.repeat ? 'see above' : t.truncated ? '…' : null;
    steps.push({ type: 'call', from, to, label, via, id: t.id, note });
    if (t.children.length) {
      const mark = steps.length;
      steps.push({ type: 'activate', at: to });
      walk(t, to);
      // Only hidden creations inside: no activation bar.
      if (steps.length === mark + 1) steps.pop();
      else steps.push({ type: 'deactivate', at: to });
    }
  };

  const start = participant(root.node);
  steps.push({ type: 'start', at: start, label: `${root.node.name}()`, id: root.id });
  walk(root, start);
  return { participants, steps };
}

/** Mermaid `sequenceDiagram` text for one flow tree. */
export function toMermaid(root) {
  const { participants, steps } = sequenceOf(root);
  const esc = (text) => text.replace(/[<>;#"]/g, (c) => `#${c.charCodeAt(0)};`);
  const lines = ['sequenceDiagram', '    autonumber'];
  participants.forEach((p, i) => lines.push(`    participant P${i} as ${esc(p.name)}`));
  let indent = '    ';
  for (const s of steps) {
    switch (s.type) {
      case 'start':
        lines.push(`${indent}Note over P${s.at}: ${esc(s.label)}`);
        break;
      case 'call':
        lines.push(`${indent}P${s.from}->>P${s.to}: ${esc(s.label + (s.via ? ` [${s.via}]` : '') + (s.note ? ` (${s.note})` : ''))}`);
        break;
      case 'create':
        lines.push(`${indent}P${s.from}-)P${s.to}: ${esc(s.label)}`);
        break;
      case 'activate':
        lines.push(`${indent}activate P${s.at}`);
        break;
      case 'deactivate':
        lines.push(`${indent}deactivate P${s.at}`);
        break;
      case 'alt':
      case 'loop':
        lines.push(`${indent}${s.type} ${esc(s.label)}`);
        indent += '    ';
        break;
      case 'else':
        lines.push(`${indent.slice(4)}else ${esc(s.label)}`);
        break;
      case 'end':
        indent = indent.slice(4);
        lines.push(`${indent}end`);
        break;
    }
  }

  return lines.join('\n') + '\n';
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
