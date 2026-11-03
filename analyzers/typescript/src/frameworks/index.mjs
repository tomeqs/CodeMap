import { expressRoutes, finishRoutes } from './express.mjs';
import { nest } from './nest.mjs';
import { angular } from './angular.mjs';

/**
 * What frameworks add to a file: roles (controller, service, component…), entry points (routes, handlers) and
 * the DI container's registrations and dependencies (ctx.di). Express routes become members of their own,
 * returned so their code is read as theirs.
 */
export function applyFrameworks(ctx, sf, info, owners) {
  const routes = expressRoutes(ctx, sf, info);
  // The handlers' decisions are the routes' now, not those of the code that registers them: the top-level
  // code, or the function a route is registered in (register(app) { app.get(…) }).
  for (const route of routes) {
    const moved = (ctx.graph.nodes.get(route.id)?.metrics?.complexity ?? 1) - 1;
    const metrics = moved > 0 && ctx.graph.nodes.get(innermostOwner(owners, route.node)?.id)?.metrics;
    if (metrics?.complexity !== undefined) metrics.complexity = Math.max(1, metrics.complexity - moved);
  }

  nest(ctx, sf, info, owners);
  angular(ctx, sf, info, owners);
  return routes;
}

export { finishRoutes };

/** The declaration whose code holds a node: the smallest one around it. */
function innermostOwner(owners, node) {
  let best = null;
  let size = Infinity;
  for (const owner of owners) {
    for (const code of owner.code ? [].concat(owner.code) : []) {
      if (code.pos <= node.pos && node.end <= code.end && code.end - code.pos < size) {
        best = owner;
        size = code.end - code.pos;
      }
    }
  }

  return best;
}

/** After every file: registrations whose lifetime comes from their class' scope. */
export function finishDi(ctx) {
  for (const registration of ctx.di.registrations) {
    if (!registration.lifetime) registration.lifetime = ctx.nestScopes.get(registration.scopeOf) ?? 'singleton';
    delete registration.scopeOf;
  }

  return ctx.di.registrations.length || ctx.di.dependencies.length ? ctx.di : undefined;
}
