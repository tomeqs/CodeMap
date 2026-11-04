import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { packageName } from './ids.mjs';
import { isComponent, isSource, toPosix } from './discover.mjs';

const CODE = /\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/;

/**
 * Where the source of a built path may be: dist/server.js → src/server; build/legacy/index.cjs → src/legacy/index,
 * then src/index (a build that writes one folder per format). Only the first folder within the package is
 * replaced, never a folder above it (a checkout in /opt/build/…).
 */
function sourceBases(dir, path) {
  const rel = relative(dir, path);
  const match = /^(dist|build|lib|out)[\\/](.*)$/.exec(rel);
  if (!match) return [];
  const rest = match[2].replace(CODE, '');
  const bases = [join(dir, 'src', rest)];
  const parts = rest.split(/[\\/]/);
  if (parts.length > 1) bases.push(join(dir, 'src', ...parts.slice(1)));
  return bases;
}

/**
 * Compiler options of a package: its tsconfig.json / jsconfig.json (or the nearest one above, up to the
 * analysis root; `extends` is followed), with what the analysis needs on top: JavaScript too, no emit, no
 * checking of libraries, no global @types packages (none are installed anyway).
 */
export function compilerOptions(ts, projectDir, root) {
  let options = {};
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const config = ['tsconfig.json', 'jsconfig.json'].map((c) => join(dir, c)).find(existsSync);
    if (config) {
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
      if (parsed) options = parsed.options;
      break;
    }

    if (dir === root || dir === dirname(dir) || !dir.startsWith(root)) break;
  }

  options = {
    ...options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    declaration: false,
    composite: false,
    incremental: false,
    allowImportingTsExtensions: true,
  };
  if (options.target === undefined) options.target = ts.ScriptTarget.ES2022;
  if (options.jsx === undefined) options.jsx = ts.JsxEmit.Preserve;
  if (options.moduleResolution === undefined || options.moduleResolution === ts.ModuleResolutionKind.Classic) {
    options.module = ts.ModuleKind.ESNext;
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
  }

  return options;
}

/**
 * Module resolution as the compiler does it (paths, baseUrl, package exports…), and imports of a sibling
 * workspace package resolved to its sources: without npm install there is no node_modules link to follow, and
 * with one the link leads to built .d.ts files rather than the code.
 */
export class Resolver {
  /**
   * @param isAnalyzed whether a file is one the analysis reads: a package's sources beat its built output.
   * @param links analyzed files that are symbolic links: imports through them stay on the link.
   */
  constructor(ts, packages, isAnalyzed = () => false, links = new Set()) {
    this.ts = ts;
    this.packages = packages;
    this.isAnalyzed = isAnalyzed;
    this.links = links;
    this.cache = new Map();
  }

  /**
   * The first candidate that is an analyzed file, else the first that exists. With forward slashes, as the
   * compiler writes file names (and as the analysis keys its files), also on Windows.
   */
  pick(candidates) {
    const existing = candidates.filter((c) => (isSource(c) || isComponent(c)) && existsSync(c));
    const file = existing.find(this.isAnalyzed) ?? existing[0];
    return file ? toPosix(file) : null;
  }

  /**
   * @param components whether the import may lead to a .vue / .svelte / .astro file: only for the edges of the map,
   *   never for the compiler, which cannot read them.
   */
  resolve(specifier, containingFile, options, mode, components = false) {
    const key = `${specifier}\u0000${dirname(containingFile)}\u0000${mode ?? ''}\u0000${options.configFilePath ?? ''}\u0000${components}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const ts = this.ts;
    let resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys, undefined, undefined, mode).resolvedModule;
    const local = (file) => ({ resolvedFileName: file, extension: isComponent(file) ? '' : ts.extensionFromPath(file), isExternalLibraryImport: false });
    if (!resolved && /^\$lib(\/|$)/.test(specifier)) {
      // SvelteKit: $lib is src/lib of the package (its tsconfig paths are generated into .svelte-kit/ by a build).
      const dir = this.packageDirOf(containingFile);
      const base = dir && join(dir, 'src', 'lib', specifier.slice('$lib/'.length));
      const file = base && this.pick([base, ...['.ts', '.js', '.svelte'].map((e) => base + e), ...['.ts', '.js'].map((e) => join(base, 'index' + e))]);
      if (file && (components || !isComponent(file))) resolved = local(file);
    } else if (!specifier.startsWith('.') && (!resolved || resolved.isExternalLibraryImport || /\.d\.[cm]?ts$/.test(resolved.resolvedFileName))) {
      const file = this.workspaceFile(specifier, containingFile);
      if (file) resolved = local(file);
    } else if (specifier.startsWith('.') && resolved) {
      if (/\.d\.[cm]?ts$/.test(resolved.resolvedFileName)) {
        // './port.js' finds port.d.ts first; the code is the analyzed port.js (or .ts) next to it.
        const base = resolved.resolvedFileName.replace(/\.d\.[cm]?ts$/, '');
        const file = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((e) => base + e).find((f) => this.isAnalyzed(f) && existsSync(f));
        if (file) resolved = local(toPosix(file));
      } else if (this.links.size) {
        // The compiler follows a symbolic link to its target (which may be outside the analysis); the import is of the link.
        const kept = ts.resolveModuleName(specifier, containingFile, { ...options, preserveSymlinks: true }, ts.sys, undefined, undefined, mode).resolvedModule;
        if (kept && this.links.has(toPosix(kept.resolvedFileName))) resolved = local(toPosix(kept.resolvedFileName));
      }
    }

    this.cache.set(key, resolved);
    return resolved;
  }

  /** The package (the nearest package.json with a name) a file is in. */
  packageOf(file) {
    const path = toPosix(file);
    let best = null;
    for (const pkg of this.packages.values()) {
      if (path.startsWith(toPosix(pkg.dir) + '/') && (!best || pkg.dir.length > best.dir.length)) best = pkg;
    }

    return best;
  }

  packageDirOf(file) {
    return this.packageOf(file)?.dir ?? null;
  }

  /** Is a file in a package that the workspace leaves out? */
  isOutside(file) {
    return this.packageOf(file)?.member === false;
  }

  /** The source behind a path package.json gives (main: dist/server.js → src/server.ts). */
  sourceFor(dir, field) {
    const path = resolve(dir, field);
    const bases = [path.replace(CODE, ''), ...sourceBases(dir, path)];
    const candidates = [path];
    for (const base of bases) {
      candidates.push(...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((e) => base + e), join(base, 'index.ts'), join(base, 'index.js'));
    }

    return this.pick(candidates);
  }

  /** The source file a workspace package import means: `@shop/domain` → packages/domain/src/index.ts. */
  workspaceFile(specifier, containingFile) {
    const name = packageName(specifier);
    const pkg = this.packages.get(name);
    // Only members of the workspace are linked to each other; a package outside it gets the npm one.
    if (!pkg || pkg.member === false || (containingFile && this.isOutside(containingFile))) return null;
    const sub = specifier.slice(name.length).replace(/^\//, '');
    const bases = [];
    if (sub) {
      bases.push(join(pkg.dir, sub), join(pkg.dir, 'src', sub));
    } else {
      for (const field of [pkg.json.source, pkg.json.types, pkg.json.typings, pkg.json.module, pkg.json.main]) {
        if (typeof field !== 'string') continue;
        const path = resolve(pkg.dir, field);
        bases.push(path.replace(CODE, ''), ...sourceBases(pkg.dir, path));
      }

      bases.push(join(pkg.dir, 'src', 'index'), join(pkg.dir, 'index'), join(pkg.dir, 'lib', 'index'));
    }

    const candidates = [];
    for (const base of bases) {
      candidates.push(base, ...['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'].map((e) => base + e), ...['.ts', '.tsx', '.js'].map((e) => join(base, 'index' + e)));
    }

    return this.pick(candidates);
  }
}

/**
 * A compiler host whose files are parsed once for all packages (a file imported by ten packages is one
 * SourceFile) and whose imports go through the {@link Resolver}.
 */
export function createHost(ts, options, cache, resolver) {
  const host = ts.createCompilerHost(options, true);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const version = typeof languageVersion === 'object' ? `${languageVersion.languageVersion}:${languageVersion.impliedNodeFormat ?? ''}` : languageVersion;
    const key = `${fileName}\u0000${version}`;
    let file = cache.get(key);
    if (!file) {
      file = read(fileName, languageVersion, onError, shouldCreate);
      if (file) cache.set(key, file);
    }

    return file;
  };
  host.resolveModuleNameLiterals = (literals, containingFile, _redirected, compilerOptions, containingSourceFile) =>
    literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(containingSourceFile, literal, compilerOptions);
      return { resolvedModule: resolver.resolve(literal.text, containingFile, compilerOptions, mode) };
    });
  return host;
}
