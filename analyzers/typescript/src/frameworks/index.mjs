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
  // The handlers' decisions are the routes' now, not the top-level code's.
  const topLevel = ctx.graph.nodes.get(`${info.moduleId}#(top-level)`);
  if (topLevel?.metrics && routes.length) {
    const moved = routes.reduce((sum, r) => sum + (ctx.graph.nodes.get(r.id)?.metrics?.complexity ?? 1) - 1, 0);
    topLevel.metrics.complexity = Math.max(1, topLevel.metrics.complexity - moved);
  }

  nest(ctx, sf, info, owners);
  angular(ctx, sf, info, owners);
  return routes;
}

export { finishRoutes };

/** After every file: registrations whose lifetime comes from their class' scope. */
export function finishDi(ctx) {
  for (const registration of ctx.di.registrations) {
    if (!registration.lifetime) registration.lifetime = ctx.nestScopes.get(registration.scopeOf) ?? 'singleton';
    delete registration.scopeOf;
  }

  return ctx.di.registrations.length || ctx.di.dependencies.length ? ctx.di : undefined;
}
