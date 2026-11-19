/**
 * What frameworks say about the code, from its own declarations and calls (nothing is run):
 * - entry points: `@main` types and their `main()`, app and scene delegates, SwiftUI's App;
 * - tests: XCTestCase subclasses with their test… methods and setUp / tearDown, Swift Testing's @Test and @Suite,
 *   PreviewProvider and #Preview;
 * - SwiftUI: views are components; @Environment and @EnvironmentObject properties are what the view needs (injects);
 * - UIKit / AppKit: view controllers, views and cells are components; @IBAction methods are handlers; @IBOutlet and
 *   @objc members may be used by Interface Builder and the Objective-C runtime;
 * - Vapor: `app.get("orders", ":id") { … }`, `routes.grouped(…)`, `group(…) { … }` and `use: handler` are routes with
 *   their full path; a RouteCollection's boot(routes:) is an entry point; middleware; Fluent models are entities.
 */

const UI_COMPONENT = /^(UI|NS)\w*(ViewController|View|Cell|Controller|Window|Button|Control)$/;
const DELEGATES = new Set(['UIApplicationDelegate', 'NSApplicationDelegate', 'UIWindowSceneDelegate', 'UISceneDelegate', 'WKApplicationDelegate', 'WKExtensionDelegate']);
const TEST_LIFECYCLE = new Set(['setUp', 'tearDown', 'setUpWithError', 'tearDownWithError']);
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'on', 'webSocket']);
const ENVIRONMENT = new Set(['Environment', 'EnvironmentObject', 'ObservedObject', 'Bindable']);

export function applyFrameworks(model, resolver, graph) {
  const tag = (id, ...tags) => {
    const node = id && graph.get(id);
    if (node) node.tags = [...new Set([...(node.tags ?? []), ...tags])].sort();
    return node;
  };

  for (const table of model.types.values()) {
    for (const entry of table.values()) {
      if (!entry.id || entry.external) continue;
      const bases = baseNames(entry, resolver);
      const attributes = new Set([...entry.decls, ...entry.extensions].flatMap((d) => d.decl.attributes));
      const ctx = resolver.ctxOf(entry);

      // Entry points.
      if (attributes.has('main') || attributes.has('UIApplicationMain') || attributes.has('NSApplicationMain')) {
        tag(entry.id, 'entrypoint');
        for (const m of entry.members) if (m.decl.name === 'main' && m.decl.modifiers.includes('static')) tag(m.id, 'entrypoint');
      }

      if ([...bases].some((b) => DELEGATES.has(b)) || bases.has('App') && imports(entry, 'SwiftUI')) tag(entry.id, 'entrypoint');

      // Tests.
      const xctest = bases.has('XCTestCase');
      if (xctest || attributes.has('Suite') || bases.has('PreviewProvider')) tag(entry.id, 'test');
      for (const m of entry.members) {
        const decl = m.decl;
        const testing = decl.attributes?.includes('Test');
        if (testing || (xctest && decl.kind === 'method' && (/^test/.test(decl.name) || TEST_LIFECYCLE.has(decl.name)))) {
          tag(m.id, 'test');
          tag(entry.id, 'test');
        }
      }

      // UI.
      if ((bases.has('View') && imports(entry, 'SwiftUI')) || [...bases].some((b) => UI_COMPONENT.test(b))) tag(entry.id, 'component');
      for (const m of entry.members) {
        const attrs = m.decl.attributes ?? [];
        if (attrs.includes('IBAction') || attrs.includes('IBSegueAction')) tag(m.id, 'handler');
        if (attrs.includes('IBOutlet') || attrs.includes('IBInspectable') || attrs.includes('objc') || attrs.includes('NSManaged')) tag(m.id, 'maybe-used');
        // @Environment(Store.self) var store, @EnvironmentObject var cart: Cart: what the view is given.
        if (attrs.some((a) => ENVIRONMENT.has(a)) && m.decl.type) for (const needed of resolver.typesIn(m.decl.type, ctx)) resolver.edge(entry.id, needed.id, 'injects');
      }

      // Vapor and Fluent.
      if (bases.has('Middleware') || bases.has('AsyncMiddleware')) tag(entry.id, 'middleware');
      if (bases.has('RouteCollection')) {
        tag(entry.id, 'controller');
        for (const m of entry.members) if (m.decl.name === 'boot' && (m.decl.labels ?? []).join(':') === 'routes') tag(m.id, 'entrypoint');
      }

      if (bases.has('Model') && (imports(entry, 'Fluent') || imports(entry, 'FluentKit'))) tag(entry.id, 'entity');
    }
  }

  for (const holder of model.holders.values()) {
    for (const m of holder.members) if (m.decl.attributes?.includes('Test')) tag(m.id, 'test');
  }

  routes(model, resolver, graph, tag);
}

/** Every base of a type: its own and its extensions', and through the map's classes and protocols, theirs. */
function baseNames(entry, resolver) {
  const names = new Set();
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    const ctx = resolver.ctxOf(current);
    for (const place of [...current.decls, ...current.extensions]) {
      for (const base of place.decl.bases) {
        names.add(base.name.split('.').pop());
        const found = resolver.lookupType(base.name, { ...ctx, file: place.file });
        if (found && !seen.has(found)) {
          seen.add(found);
          queue.push(found);
        }
      }
    }
  }

  return names;
}

function imports(entry, module) {
  return [...entry.decls, ...entry.extensions].some((d) => d.file.facts?.imports?.includes(module)) || !entry.decls.length;
}

// --------------------------------------------------------------------------------------------- Vapor

/**
 * Routes of files that import Vapor: a call of get / post / … on a routes builder with its path components, the path
 * of the builder before it (`grouped("api")`, `group("v1") { v1 in … }`). The handler `use: index` is a route; a
 * closure makes the function that registers it the route's entry point. Each gets `METHOD /path` at the top of its doc.
 */
function routes(model, resolver, graph, tag) {
  const visit = (member) => {
    if (!member.id) return;
    for (const place of member.places) {
      const decl = place.member;
      if (!decl.refs?.length || !place.file.facts?.imports?.includes('Vapor')) continue;
      for (const ref of decl.refs) {
        if (ref.ev !== 'call') continue;
        const [, fn, labels, args] = ref.e;
        if (fn[0] !== 'm' || !HTTP.has(fn[2])) continue;
        let method = fn[2].toUpperCase();
        const parts = [];
        let handler = null;
        let closure = false;
        args.forEach((arg, i) => {
          if (!arg) return;
          if (labels[i] === 'use') handler = arg;
          else if (fn[2] === 'on' && i === 0 && arg[0] === 'i') method = arg[1].toUpperCase();
          else {
            const part = component(arg);
            if (part !== null) parts.push(part);
          }
        });
        if (labels.includes('?')) closure = true;
        if (!handler && !closure) continue;
        const prefix = pathOf(fn[1], decl.locals ?? {}, 0);
        if (prefix === null) continue;
        const path = '/' + [...prefix, ...parts].filter(Boolean).join('/');
        const route = `${method === 'WEBSOCKET' ? 'WS' : method} ${path}`;
        const target = handler ? handlerOf(handler, member, resolver) : member;
        if (!target?.id) continue;
        const node = tag(target.id, 'route', 'entrypoint');
        if (node && !(node.doc ?? '').split('\n').includes(route)) node.doc = [route, ...(node.doc ? [node.doc] : [])].join('\n');
        if (handler && target !== member) resolver.edge(member.id, target.id, 'calls', ref.line);
      }
    }
  };
  for (const table of model.types.values()) for (const entry of table.values()) entry.members.forEach(visit);
  for (const holder of model.holders.values()) holder.members.forEach(visit);
}

/** A path component: "orders", ":id", "**", .catchall, .anything. */
function component(arg) {
  if (arg[0] === 'l' && arg[1] === 'String' && typeof arg[2] === 'string') return arg[2].replace(/^\/+|\/+$/g, '');
  if (arg[0] === 'i') return arg[1] === 'catchall' ? '**' : arg[1] === 'anything' ? '*' : `:${arg[1]}`;
  return null;
}

/** The path a routes builder stands for: grouped(…) and group(…) { builder in … } add to the one they are called on. */
function pathOf(e, locals, depth) {
  if (!e || depth > 16) return [];
  if (e[0] === 'v') return pathOf(locals[e[1]], locals, depth + 1);
  if (e[0] === 'c' && e[1][0] === 'm' && (e[1][2] === 'grouped' || e[1][2] === 'group')) {
    const base = pathOf(e[1][1], locals, depth + 1);
    const parts = (e[3] ?? []).map((a) => (a ? component(a) : null)).filter((p) => p !== null);
    return base === null ? null : [...base, ...parts];
  }

  if (e[0] === 'cl') {
    const call = e[1];
    if (call[1][0] === 'm' && call[1][2] === 'group') return pathOf(call, locals, depth + 1);
    return [];
  }

  return [];
}

/** `use: index`, `use: self.index`, `use: Controller.index`: the method of the type (or the function) it names. */
function handlerOf(e, member, resolver) {
  const name = e[0] === 'n' ? e[1] : e[0] === 'm' ? e[2] : null;
  if (!name) return null;
  const owner = member.entry && !member.entry.external ? member.entry : null;
  if (owner) {
    const found = resolver.membersNamed(owner, name).find((m) => m.decl.kind === 'method');
    if (found) return found;
  }

  const project = member.entry?.project ?? member.holder?.file.project;
  for (const p of project ? resolver.visible(project) : []) {
    const fn = resolver.functions.get(p.id)?.get(name)?.[0];
    if (fn) return fn;
  }

  return null;
}
