import { memberId } from '../ids.mjs';
import { complexity } from '../extract/complexity.mjs';
import { addTag, importOf, stringOf } from './imports.mjs';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

/**
 * Express: every `app.get('/path', …)`, `router.post(…)`, `router.route('/x').get(…)` becomes a route member of
 * its file (tagged route and entrypoint, so call flows start there): the code of inline handlers is the route's,
 * a named handler or middleware is called by it. The file is tagged controller.
 * `app.use('/prefix', router)` is remembered (ctx.express) so that, once every file is read, routes are named
 * with their full path (finishRoutes).
 */
export function expressRoutes(ctx, sf, info) {
  const { ts, graph } = ctx;
  const owners = [];
  const routers = ctx.express.routers; // declaration → is an Express app / router
  const used = new Set();

  /** The variable (or property) an app / router expression stands for. */
  const declarationOf = (expr) => {
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'route') {
      return declarationOf(expr.expression.expression);
    }

    if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return null;
    try {
      const symbol = ctx.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
      const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol;
      return target?.valueDeclaration ?? target?.declarations?.[0] ?? null;
    } catch {
      return null;
    }
  };

  const isRouter = (expr) => {
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'route') {
      return isRouter(expr.expression.expression);
    }

    if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) return isExpressFactory(expr);
    const decl = declarationOf(expr); // through imports: a router declared in another file
    if (!decl) return false;
    if (routers.has(decl)) return routers.get(decl);
    routers.set(decl, false);
    let result = false;
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) result = isRouter(decl.initializer);
    if (!result && (ts.isParameter(decl) || ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.type && ts.isTypeReferenceNode(decl.type)) {
      const source = importOf(ctx, decl.type.typeName); // Router, or express.Router
      result = source?.module === 'express' && /^(Router|IRouter|Express|Application)$/.test(source.name);
    }

    routers.set(decl, result);
    return result;
  };

  const isString = (expr) => {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const parts = type.isUnion() ? type.types : [type];
      return parts.every((t) => t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Undefined));
    } catch {
      return false;
    }
  };

  const isExpressFactory = (call) => {
    const source = importOf(ctx, call.expression);
    return source?.module === 'express' && (source.name === 'default' || source.name === '*' || source.name === 'Router');
  };

  const visit = (n) => {
    // app.use('/catalog', catalogRouter): the router's routes are under /catalog.
    // A path the code computes (app.use(base, router)) is unknown: those routes keep the path they declare.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'use' && isRouter(n.expression.expression)) {
      const first = n.arguments[0];
      const literal = first ? stringOf(ts, first) : null;
      const computed = literal === null && first && isString(first);
      const parent = declarationOf(n.expression.expression);
      for (const argument of n.arguments.slice(literal !== null || computed ? 1 : 0)) {
        const mounted = (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument)) && isRouter(argument) ? declarationOf(argument) : null;
        if (!mounted || mounted === parent) continue;
        if (!ctx.express.mounts.has(mounted)) ctx.express.mounts.set(mounted, []);
        ctx.express.mounts.get(mounted).push({ prefix: computed ? null : literal ?? '', parent });
      }
    }

    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && VERBS.has(n.expression.name.text)) {
      const receiver = n.expression.expression;
      // Chains: router.route('/x').get(a).post(b), app.get('/a', h).post('/b', h2) (each verb returns its receiver).
      let base = receiver;
      while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && VERBS.has(base.expression.name.text)) base = base.expression.expression;
      const routeCall = ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text === 'route' ? base : null;
      const router = routeCall ?? base;
      const routePath = routeCall ? stringOf(ts, routeCall.arguments[0]) : stringOf(ts, n.arguments[0]);
      const handlers = routeCall ? [...n.arguments] : n.arguments.slice(1);
      if (routePath !== null && handlers.length > 0 && isRouter(router)) {
        const verb = n.expression.name.text.toUpperCase();
        let name = `${verb} ${routePath}`;
        for (let i = 2; used.has(name); i++) name = `${verb} ${routePath} ~${i}`;
        used.add(name);
        const id = memberId(info.moduleId, `route:${name}`);
        // The line of the verb: in a chain over several lines, every call starts where the chain starts.
        const start = sf.getLineAndCharacterOfPosition(n.expression.name.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(n.end).line + 1;
        graph.addNode({
          id,
          kind: 'function',
          level: 'member',
          name,
          fullName: `${info.path}#route:${name}`,
          parent: info.moduleId,
          project: info.projectId,
          namespace: info.folder,
          accessibility: 'public',
          signature: `${(routeCall ? routeCall.expression.expression : router).getText(sf)}.${n.expression.name.text}('${routePath}', …)`.replace(/\s+/g, ' '),
          location: { file: info.rel, line: start, endLine: end },
          tags: ['route', 'entrypoint', ...(info.isTest ? ['test'] : [])],
          metrics: { loc: end - start + 1, complexity: handlers.reduce((sum, h) => sum + complexity(ts, h) - 1, 1) },
        });
        ctx.express.routes.push({ id, verb, path: routePath, router: declarationOf(router) });
        for (const handler of handlers) ctx.claimed.set(handler, id);
        owners.push({ id, node: n, code: handlers, kind: 'function' });
        addTag(graph.nodes.get(info.moduleId), 'controller');
      }
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);
  return owners;
}

/**
 * After every file: a route of a mounted router is named with its full path (`GET /catalog/:id`), when the router
 * is mounted at one place. Its id stays as it was declared, so selections and saved maps keep finding it.
 */
export function finishRoutes(ctx) {
  const { mounts, routes } = ctx.express;
  // Every path a router is reachable at; null for a part the code computes.
  const prefixesOf = (router, seen) => {
    const at = router && mounts.get(router);
    if (!at?.length || seen.has(router)) return [''];
    const path = new Set(seen).add(router);
    return [...new Set(at.flatMap((m) => prefixesOf(m.parent, path).map((p) => (p === null || m.prefix === null ? null : join(p, m.prefix)))))];
  };

  for (const route of routes) {
    const prefixes = prefixesOf(route.router, new Set());
    if (prefixes.length !== 1 || !prefixes[0] || prefixes[0] === '/') continue;
    const node = ctx.graph.nodes.get(route.id);
    const full = join(prefixes[0], route.path);
    node.name = node.name.replace(`${route.verb} ${route.path}`, `${route.verb} ${full}`);
    node.fullName = node.fullName.replace(/#route:.*$/, `#route:${node.name}`);
  }
}

function join(prefix, path) {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}
