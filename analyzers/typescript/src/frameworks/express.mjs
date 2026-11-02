import { memberId } from '../ids.mjs';
import { complexity } from '../extract/complexity.mjs';
import { addTag, importOf, stringOf } from './imports.mjs';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

/**
 * Express: every `app.get('/path', …)`, `router.post(…)`, `router.route('/x').get(…)` becomes a route member of
 * its file (tagged route and entrypoint, so call flows start there): the code of inline handlers is the route's,
 * a named handler or middleware is called by it. The file is tagged controller.
 */
export function expressRoutes(ctx, sf, info) {
  const { ts, graph } = ctx;
  const owners = [];
  const routers = new Map(); // declaration → is an Express app / router
  const used = new Set();

  const isRouter = (expr) => {
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'route') {
      return isRouter(expr.expression.expression);
    }

    if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) return isExpressFactory(expr);
    let symbol;
    try {
      symbol = ctx.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    } catch {
      return false;
    }

    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl) return false;
    if (routers.has(decl)) return routers.get(decl);
    routers.set(decl, false);
    let result = false;
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) result = isRouter(decl.initializer);
    if (!result && (ts.isParameter(decl) || ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.type && ts.isTypeReferenceNode(decl.type)) {
      const source = importOf(ctx, decl.type.typeName.kind === ts.SyntaxKind.Identifier ? decl.type.typeName : decl.type.typeName.right);
      result = source?.module === 'express' && /^(Router|IRouter|Express|Application)$/.test(source.name);
    }

    routers.set(decl, result);
    return result;
  };

  const isExpressFactory = (call) => {
    const source = importOf(ctx, call.expression);
    return source?.module === 'express' && (source.name === 'default' || source.name === '*' || source.name === 'Router');
  };

  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && VERBS.has(n.expression.name.text)) {
      const receiver = n.expression.expression;
      const routePath = ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression) && receiver.expression.name.text === 'route'
        ? stringOf(ts, receiver.arguments[0])
        : stringOf(ts, n.arguments[0]);
      const handlers = routePath !== null && ts.isCallExpression(receiver) && receiver.expression.name?.text === 'route' ? [...n.arguments] : n.arguments.slice(1);
      if (routePath !== null && handlers.length > 0 && isRouter(receiver)) {
        const verb = n.expression.name.text.toUpperCase();
        let name = `${verb} ${routePath}`;
        for (let i = 2; used.has(name); i++) name = `${verb} ${routePath} ~${i}`;
        used.add(name);
        const id = memberId(info.moduleId, `route:${name}`);
        const start = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
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
          signature: `${n.expression.getText(sf)}('${routePath}', …)`.replace(/\s+/g, ' '),
          location: { file: info.rel, line: start, endLine: end },
          tags: ['route', 'entrypoint', ...(info.isTest ? ['test'] : [])],
          metrics: { loc: end - start + 1, complexity: handlers.reduce((sum, h) => sum + complexity(ts, h) - 1, 1) },
        });
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
