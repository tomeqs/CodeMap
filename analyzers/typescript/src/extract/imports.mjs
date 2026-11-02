import { builtinModules } from 'node:module';
import { packageId, packageName, projectId } from '../ids.mjs';

const BUILTINS = new Set(builtinModules);
const ASSET = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|eot|otf|mp3|mp4|webm|wav|json|html?|md|txt|wasm|glsl|wgsl|vert|frag|graphql|gql|ya?ml)(\?.*)?$/i;

/**
 * File → file `imports` (as written: through a barrel index.ts the edge goes to the barrel); `import type`
 * only describes types, so it is a `uses`. Imports of npm packages reference the package from the importing
 * package (packageReference), imports of sibling workspace packages reference that package
 * (projectReference). Relative imports that lead nowhere are counted for a warning.
 */
export function collectImports(ctx, sf, info) {
  const { ts, graph } = ctx;
  for (const literal of sf.imports ?? []) {
    const specifier = literal.text;
    if (!specifier) continue;
    let resolved;
    try {
      const mode = ts.getModeForUsageLocation(sf, literal, ctx.options);
      resolved = ctx.program.getResolvedModule?.(sf, specifier, mode)?.resolvedModule ?? ctx.resolver.resolve(specifier, sf.fileName, ctx.options, mode);
    } catch {
      resolved = null;
    }

    const target = resolved && ctx.files.get(resolved.resolvedFileName);
    if (target) {
      graph.addEdge(info.moduleId, target.moduleId, isTypeOnly(ts, literal.parent) ? 'uses' : 'imports');
      if (target.projectId !== info.projectId) graph.addEdge(info.projectId, target.projectId, 'projectReference');
      continue;
    }

    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!resolved && !ASSET.test(specifier)) ctx.stats.unresolved++; // styles, images, JSON: not code
      continue;
    }

    if (BUILTINS.has(specifier) || specifier.startsWith('node:') || specifier.startsWith('bun:') || BUILTINS.has(specifier.split('/')[0])) continue;
    const name = packageName(specifier);
    const workspace = ctx.projectsByName.get(name);
    if (workspace) {
      graph.addEdge(info.projectId, projectId(workspace.name), 'projectReference');
    } else {
      ctx.ensurePackage(name);
      graph.addEdge(info.projectId, packageId(name), 'packageReference');
    }
  }
}

function isTypeOnly(ts, node) {
  if (!node) return false;
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const named = clause.namedBindings;
    return !clause.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
  }

  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  return ts.isLiteralTypeNode(node) || ts.isImportTypeNode(node);
}
