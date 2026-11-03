import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { packageName } from './ids.mjs';
import { isSource, toPosix } from './discover.mjs';

const CODE = /\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/;

/**
 * Where the source of a built path is: dist/server.js → src/server.ts. Only the first folder within the
 * package is replaced, never a folder above it (a checkout in /opt/build/…).
 */
function sourceBase(dir, path) {
  const rel = relative(dir, path);
  const mapped = rel.replace(/^(dist|build|lib|out)([\\/])/, 'src$2');
  return mapped === rel ? null : join(dir, mapped).replace(CODE, '');
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
  /** @param isAnalyzed whether a file is one the analysis reads: a package's sources beat its built output. */
  constructor(ts, packages, isAnalyzed = () => false) {
    this.ts = ts;
    this.packages = packages;
    this.isAnalyzed = isAnalyzed;
    this.cache = new Map();
  }

  /**
   * The first candidate that is an analyzed file, else the first that exists. With forward slashes, as the
   * compiler writes file names (and as the analysis keys its files), also on Windows.
   */
  pick(candidates) {
    const existing = candidates.filter((c) => isSource(c) && existsSync(c));
    const file = existing.find(this.isAnalyzed) ?? existing[0];
    return file ? toPosix(file) : null;
  }

  resolve(specifier, containingFile, options, mode) {
    const key = `${specifier}\u0000${dirname(containingFile)}\u0000${mode ?? ''}\u0000${options.configFilePath ?? ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const ts = this.ts;
    let resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys, undefined, undefined, mode).resolvedModule;
    if (!specifier.startsWith('.') && (!resolved || resolved.isExternalLibraryImport || /\.d\.[cm]?ts$/.test(resolved.resolvedFileName))) {
      const file = this.workspaceFile(specifier);
      if (file) resolved = { resolvedFileName: file, extension: ts.extensionFromPath(file), isExternalLibraryImport: false };
    }

    this.cache.set(key, resolved);
    return resolved;
  }

  /** The source behind a path package.json gives (main: dist/server.js → src/server.ts). */
  sourceFor(dir, field) {
    const path = resolve(dir, field);
    const bases = [path.replace(CODE, ''), sourceBase(dir, path)].filter(Boolean);
    const candidates = [path];
    for (const base of bases) {
      candidates.push(...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((e) => base + e), join(base, 'index.ts'), join(base, 'index.js'));
    }

    return this.pick(candidates);
  }

  /** The source file a workspace package import means: `@shop/domain` → packages/domain/src/index.ts. */
  workspaceFile(specifier) {
    const name = packageName(specifier);
    const pkg = this.packages.get(name);
    if (!pkg) return null;
    const sub = specifier.slice(name.length).replace(/^\//, '');
    const bases = [];
    if (sub) {
      bases.push(join(pkg.dir, sub), join(pkg.dir, 'src', sub));
    } else {
      for (const field of [pkg.json.source, pkg.json.types, pkg.json.typings, pkg.json.module, pkg.json.main]) {
        if (typeof field !== 'string') continue;
        const path = resolve(pkg.dir, field);
        bases.push(path.replace(CODE, ''));
        const source = sourceBase(pkg.dir, path);
        if (source) bases.push(source);
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
