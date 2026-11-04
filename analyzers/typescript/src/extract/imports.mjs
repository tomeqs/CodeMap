import { builtinModules } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { isComponent, toPosix } from '../discover.mjs';
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
  const { ts } = ctx;
  // The compiler lists require() calls of JavaScript files with the imports; in TypeScript they are only calls.
  const requires = /\.[cm]?tsx?$/.test(sf.fileName) && sf.text.includes('require(') ? requireCalls(ts, sf) : [];
  for (const literal of [...(sf.imports ?? []), ...requires]) {
    const specifier = literal.text;
    if (!specifier) continue;
    let resolved;
    try {
      const mode = requires.includes(literal) ? ts.ModuleKind.CommonJS : ts.getModeForUsageLocation(sf, literal, ctx.options);
      resolved = ctx.program.getResolvedModule?.(sf, specifier, mode)?.resolvedModule ?? ctx.resolver.resolve(specifier, sf.fileName, ctx.options, mode, true);
    } catch {
      resolved = null;
    }

    linkImport(ctx, sf.fileName, info, specifier, resolved, isTypeOnly(ts, literal.parent));
  }
}

/** The imports in the <script> blocks of a .vue / .svelte file and the frontmatter of an .astro file. */
export function collectComponentImports(ctx, file, text, info) {
  const { ts } = ctx;
  const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const frontmatter = file.endsWith('.astro') ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(text) : null;
  if (frontmatter) scripts.push(frontmatter[1]);
  for (const script of scripts) {
    for (const ref of ts.preProcessFile(script, true, true).importedFiles) {
      let resolved;
      try {
        resolved = ctx.resolver.resolve(ref.fileName, file, ctx.options, undefined, true);
      } catch {
        resolved = null;
      }

      linkImport(ctx, file, info, ref.fileName, resolved, false);
    }
  }
}

/** The edge one import makes: to the file it reaches, to a sibling package, or to an npm package. */
function linkImport(ctx, file, info, specifier, resolved, typeOnly) {
  const { graph } = ctx;
  // './Panel.vue': the compiler resolves no component, the analysis has it as a file.
  const target = (resolved && ctx.files.get(resolved.resolvedFileName)) ||
    (specifier.startsWith('.') && isComponent(specifier) ? ctx.files.get(toPosix(resolvePath(dirname(file), specifier))) : null);
  if (target) {
    graph.addEdge(info.moduleId, target.moduleId, typeOnly ? 'uses' : 'imports');
    if (target.projectId !== info.projectId) graph.addEdge(info.projectId, target.projectId, 'projectReference');
    return;
  }

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    if (!resolved && !ASSET.test(specifier)) { // styles, images, JSON: not code
      ctx.stats.unresolved++;
      if (ctx.stats.unresolvedExamples.length < 5) ctx.stats.unresolvedExamples.push(`${info.rel} → ${specifier}`);
    }
    return;
  }

  if (BUILTINS.has(specifier) || specifier.startsWith('node:') || specifier.startsWith('bun:') || BUILTINS.has(specifier.split('/')[0])) return;
  const name = packageName(specifier);
  const workspace = ctx.projectsByName.get(name);
  if (workspace && workspace.member && info.member) {
    graph.addEdge(info.projectId, projectId(workspace.name), 'projectReference');
  } else if (resolved && !resolved.isExternalLibraryImport) {
    // A file of this repository that the analysis leaves out (generated, a test, outside the packages),
    // reached through a path alias: not an npm package.
  } else if (!resolved && isAlias(specifier, ctx.options)) {
    // A path alias the compiler could not follow (no tsconfig that declares it, or a missing file).
  } else {
    ctx.ensurePackage(name);
    graph.addEdge(info.projectId, packageId(name), 'packageReference');
  }
}

/** The module names of the `require('x')` calls in a file. */
function requireCalls(ts, sf) {
  const literals = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require' && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])) {
      literals.push(n.arguments[0]);
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);
  return literals;
}

/**
 * `@/x`, `~/x`, `#x` (package.json imports), `$lib`, `$app/…` (SvelteKit's modules; `$` is no npm name) or a tsconfig
 * `paths` pattern: local code, never an npm package.
 */
function isAlias(specifier, options) {
  if (/^(@\/|~\/|#|\$)/.test(specifier)) return true;
  return Object.keys(options?.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf('*');
    if (star < 0) return specifier === pattern;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
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
