import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/**
 * A small reader of CMakeLists.txt (not an interpreter): targets (add_library, add_executable and Qt's
 * qt_add_*), their sources (lists, target_sources, file(GLOB)), include directories, the libraries they link,
 * and which are tests. It follows add_subdirectory and include(), expands simple variables (set, list(APPEND),
 * the CMAKE_*_DIR ones) and reads every branch of if(); functions and macros are not run.
 */

const LIBRARY_KINDS = new Set(['STATIC', 'SHARED', 'MODULE', 'OBJECT', 'INTERFACE', 'UNKNOWN']);
const SCOPES = new Set(['PUBLIC', 'PRIVATE', 'INTERFACE']);
const TEST_LIBRARIES = /^(GTest::|gtest|gmock|Catch2::|Catch2?$|doctest|Boost::unit_test_framework|Boost::unit_test|Qt\d?::Test$|Qt\d?Test$)/i;
const MAX_FILES = 200;
const UNKNOWN = '\u0000';
/** Folder listings for file(GLOB): a project globs the same folders from many CMakeLists.txt. */
const LISTINGS = new Map();

/**
 * @returns {{ targets: Target[], projectName: string|null, visited: Set<string> }} where Target is
 *   { name, kind: 'library'|'executable', dir, file, line, sources: string[] (absolute), includeDirs: string[],
 *     links: string[], test: boolean, interface: boolean }
 */
export function readCMake(rootDir) {
  LISTINGS.clear();
  const state = { targets: new Map(), aliases: new Map(), tests: new Set(), visited: new Set(), files: 0, projectName: null };
  const vars = new Map([
    ['CMAKE_SOURCE_DIR', rootDir],
    ['PROJECT_SOURCE_DIR', rootDir],
    ['CMAKE_CURRENT_SOURCE_DIR', rootDir],
    ['CMAKE_CURRENT_LIST_DIR', rootDir],
    ['CMAKE_BINARY_DIR', join(rootDir, 'build')],
    ['CMAKE_CURRENT_BINARY_DIR', join(rootDir, 'build')],
  ]);
  readList(join(rootDir, 'CMakeLists.txt'), rootDir, vars, [], state);

  const targets = [...state.targets.values()];
  for (const target of targets) {
    target.links = target.links.map((name) => state.aliases.get(name) ?? name);
    if (state.tests.has(target.name) || target.links.some((l) => TEST_LIBRARIES.test(l))) target.test = true;
  }

  return { targets, projectName: state.projectName, visited: state.visited };
}

function readList(file, dir, vars, includeDirs, state) {
  if (state.visited.has(file) || !existsSync(file) || ++state.files > MAX_FILES) return includeDirs;
  state.visited.add(file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return includeDirs;
  }

  let directoryIncludes = [...includeDirs];
  const defined = new Set();
  for (const { name, args: rawArgs, line } of commands(text)) {
    const command = name.toLowerCase();
    if (command === 'function' || command === 'macro') {
      defined.add((rawArgs[0]?.value ?? '').toLowerCase());
      continue;
    }

    const args = expand(rawArgs, vars);
    switch (command) {
      case 'project':
        if (args[0]) {
          vars.set('PROJECT_NAME', args[0]);
          vars.set('PROJECT_SOURCE_DIR', dir);
          vars.set(`${args[0]}_SOURCE_DIR`, dir);
          state.projectName ??= args[0];
        }
        break;
      case 'set':
        if (args.length) vars.set(args[0], args.slice(1).filter((a) => !['CACHE', 'PARENT_SCOPE', 'FORCE', 'INTERNAL', 'STRING', 'PATH', 'FILEPATH', 'BOOL'].includes(a)).join(';'));
        break;
      case 'list':
        if ((args[0] === 'APPEND' || args[0] === 'PREPEND') && args[1]) {
          const current = vars.get(args[1]);
          const added = args.slice(2).join(';');
          vars.set(args[1], args[0] === 'APPEND' ? [current, added].filter(Boolean).join(';') : [added, current].filter(Boolean).join(';'));
        }
        break;
      case 'file':
        if ((args[0] === 'GLOB' || args[0] === 'GLOB_RECURSE') && args[1]) vars.set(args[1], glob(args, dir, vars.get('CMAKE_SOURCE_DIR')).join(';'));
        break;
      case 'include_directories':
        directoryIncludes = [...directoryIncludes, ...paths(args.filter((a) => !['BEFORE', 'AFTER', 'SYSTEM'].includes(a)), dir)];
        break;
      case 'add_subdirectory':
        if (args[0] && !args[0].includes(UNKNOWN)) {
          const child = resolve(dir, args[0]);
          const childVars = new Map(vars);
          childVars.set('CMAKE_CURRENT_SOURCE_DIR', child);
          childVars.set('CMAKE_CURRENT_LIST_DIR', child);
          readList(join(child, 'CMakeLists.txt'), child, childVars, directoryIncludes, state);
        }
        break;
      case 'include':
        if (args[0] && /\.cmake$/i.test(args[0])) {
          const included = resolve(dir, args[0]);
          if (included.startsWith(vars.get('CMAKE_SOURCE_DIR'))) directoryIncludes = readList(included, dir, vars, directoryIncludes, state);
        }
        break;
      case 'add_library':
      case 'add_executable':
      case 'qt_add_executable':
      case 'qt5_add_executable':
      case 'qt6_add_executable':
      case 'qt_add_library':
      case 'qt6_add_library':
      case 'qt_add_qml_module':
        addTarget(command, args, dir, file, line, directoryIncludes, state);
        break;
      case 'target_sources': {
        const target = state.targets.get(args[0]);
        if (target) target.sources.push(...paths(args.slice(1).filter((a) => !SCOPES.has(a) && !['FILE_SET', 'TYPE', 'HEADERS', 'BASE_DIRS', 'FILES', 'CXX_MODULES'].includes(a)), dir));
        break;
      }
      case 'target_include_directories': {
        const target = state.targets.get(args[0]);
        if (target) target.includeDirs.push(...paths(args.slice(1).filter((a) => !SCOPES.has(a) && !['SYSTEM', 'BEFORE', 'AFTER'].includes(a)), dir));
        break;
      }
      case 'target_link_libraries': {
        const target = state.targets.get(args[0]);
        if (target) target.links.push(...args.slice(1).filter((a) => !SCOPES.has(a) && !a.includes(UNKNOWN) && !a.startsWith('$<') && !['LINK_PUBLIC', 'LINK_PRIVATE', 'LINK_INTERFACE_LIBRARIES', 'debug', 'optimized', 'general'].includes(a) && !a.startsWith('-')));
        break;
      }
      case 'add_test': {
        const command = args.indexOf('COMMAND');
        if (command >= 0 && args[command + 1]) state.tests.add(args[command + 1]);
        else if (args[1]) state.tests.add(args[1]);
        break;
      }
      case 'gtest_discover_tests':
      case 'gtest_add_tests':
      case 'catch_discover_tests':
      case 'doctest_discover_tests':
        if (args[0]) state.tests.add(args[0]);
        break;
      default:
        break;
    }
  }

  return directoryIncludes;
}

function addTarget(command, args, dir, file, line, includeDirs, state) {
  const name = args[0];
  if (!name || state.targets.has(name)) return;
  const rest = args.slice(1);
  if (rest.includes('IMPORTED')) return;
  const alias = rest.indexOf('ALIAS');
  if (alias >= 0) {
    if (rest[alias + 1]) state.aliases.set(name, rest[alias + 1]);
    return;
  }

  const executable = command.includes('executable');
  const iface = rest.includes('INTERFACE');
  const sources = paths(rest.filter((a) => !LIBRARY_KINDS.has(a) && !['WIN32', 'MACOSX_BUNDLE', 'EXCLUDE_FROM_ALL', 'MANUAL_FINALIZATION', 'URI', 'VERSION', 'QML_FILES', 'SOURCES', 'RESOURCES'].includes(a)), dir);
  state.targets.set(name, { name, kind: executable ? 'executable' : 'library', dir, file, line, sources, includeDirs: [...includeDirs], links: [], test: false, interface: iface });
}

/** Arguments as paths: generator expressions unwrapped ($<BUILD_INTERFACE:x> → x), install-time ones dropped. */
function paths(args, dir) {
  const out = [];
  for (let arg of args) {
    if (!arg || arg.includes(UNKNOWN)) continue;
    if (/^\$<INSTALL_INTERFACE:/.test(arg) || /^\$<TARGET_OBJECTS:/.test(arg)) continue;
    while (/^\$<[^:>]+:(.*)>$/.test(arg)) arg = arg.replace(/^\$<[^:>]+:(.*)>$/, '$1');
    if (arg.includes('$<') || arg.includes('${')) continue;
    out.push(normalize(isAbsolute(arg) ? arg : resolve(dir, arg)));
  }

  return out;
}

/** file(GLOB var [LIST_DIRECTORIES x] [RELATIVE dir] [CONFIGURE_DEPENDS] patterns…) against the disk. */
function glob(args, dir, root) {
  const recursive = args[0] === 'GLOB_RECURSE';
  const patterns = [];
  let relativeTo = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === 'RELATIVE') relativeTo = args[++i];
    else if (args[i] === 'LIST_DIRECTORIES') i++;
    else if (args[i] !== 'CONFIGURE_DEPENDS' && args[i] !== 'FOLLOW_SYMLINKS') patterns.push(args[i]);
  }

  const out = [];
  for (const pattern of patterns) {
    if (pattern.includes(UNKNOWN)) continue;
    const absolute = isAbsolute(pattern) ? pattern : resolve(dir, pattern);
    const base = absolute.slice(0, absolute.search(/[*?[]/) === -1 ? absolute.length : absolute.search(/[*?[]/));
    const baseDir = base.endsWith(sep) ? base : dirname(base);
    const re = globRegex(absolute, recursive);
    if (!baseDir.startsWith(root)) continue; // only the project's own folders
    const key = `${recursive ? 'r' : 'f'}|${baseDir}`;
    if (!LISTINGS.has(key)) LISTINGS.set(key, listFiles(baseDir, recursive));
    for (const file of LISTINGS.get(key)) if (re.test(file)) out.push(file);
  }

  return relativeTo ? out.map((f) => relative(relativeTo, f)) : out;
}

function globRegex(pattern, recursive) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += pattern[i + 1] === '*' ? (i++, '.*') : recursive ? '.*' : '[^/\\\\]*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

function listFiles(dir, recursive, out = [], depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) out.push(path);
    else if (recursive && entry.isDirectory() && !entry.name.startsWith('.') && depth < 20) listFiles(path, true, out, depth + 1);
  }

  return out;
}

/** ${VAR} references expanded; unquoted arguments split on `;` as CMake does. */
function expand(args, vars) {
  const out = [];
  for (const arg of args) {
    let value = arg.value;
    for (let guard = 0; guard < 10 && value.includes('${'); guard++) {
      // An unknown variable (set by the build, a function, the environment) leaves a mark: a path or a glob with
      // it is not used (`${fmt_DIR}/*.cmake` is not a glob of the whole disk).
      value = value.replace(/\$\{([A-Za-z0-9_.+-]+)\}/g, (_, name) => vars.get(name) ?? UNKNOWN);
    }

    if (arg.quoted) out.push(value);
    else out.push(...value.split(';').filter((v) => v !== ''));
  }

  return out;
}

/** The commands of a CMake file: name, arguments ({value, quoted}) and line. */
export function commands(text) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
    } else if (c === '#') {
      const bracket = /^#\[(=*)\[/.exec(text.slice(i, i + 20));
      if (bracket) {
        const end = text.indexOf(`]${bracket[1]}]`, i);
        const stop = end === -1 ? n : end + bracket[1].length + 2;
        line += count(text, i, stop);
        i = stop;
      } else {
        while (i < n && text[i] !== '\n') i++;
      }
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
      const name = text.slice(start, i);
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      if (text[i] !== '(') continue;
      const commandLine = line;
      i++;
      const args = [];
      let depth = 1;
      while (i < n && depth > 0) {
        const d = text[i];
        if (d === '\n') {
          line++;
          i++;
        } else if (d === ' ' || d === '\t' || d === '\r') {
          i++;
        } else if (d === '#') {
          const bracket = /^#\[(=*)\[/.exec(text.slice(i, i + 20));
          if (bracket) {
            const end = text.indexOf(`]${bracket[1]}]`, i);
            const stop = end === -1 ? n : end + bracket[1].length + 2;
            line += count(text, i, stop);
            i = stop;
          } else {
            while (i < n && text[i] !== '\n') i++;
          }
        } else if (d === '(') {
          depth++;
          i++;
        } else if (d === ')') {
          depth--;
          i++;
        } else if (d === '"') {
          let value = '';
          i++;
          while (i < n && text[i] !== '"') {
            if (text[i] === '\\' && i + 1 < n) {
              value += text[i + 1] === 'n' ? '\n' : text[i + 1];
              i += 2;
            } else {
              if (text[i] === '\n') line++;
              value += text[i++];
            }
          }

          i++;
          args.push({ value, quoted: true });
        } else if (d === '[' && /^\[(=*)\[/.test(text.slice(i, i + 20))) {
          const eq = /^\[(=*)\[/.exec(text.slice(i, i + 20))[1];
          const end = text.indexOf(`]${eq}]`, i);
          const stop = end === -1 ? n : end;
          const value = text.slice(i + eq.length + 2, stop);
          line += count(text, i, stop);
          i = stop + eq.length + 2;
          args.push({ value, quoted: true });
        } else {
          let value = '';
          while (i < n && !/[\s()#"]/.test(text[i])) {
            if (text[i] === '\\' && i + 1 < n) {
              value += text[i + 1];
              i += 2;
            } else if (text[i] === '$' && text[i + 1] === '<') {
              // A generator expression may hold spaces in quotes and nested <>; keep it whole.
              let angle = 0;
              do {
                if (text[i] === '<') angle++;
                else if (text[i] === '>') angle--;
                value += text[i++];
              } while (i < n && angle > 0);
            } else {
              value += text[i++];
            }
          }

          args.push({ value, quoted: false });
        }
      }

      out.push({ name, args, line: commandLine });
    } else {
      i++;
    }
  }

  return out;
}

function count(text, from, to) {
  let lines = 0;
  for (let k = from; k < to; k++) if (text.charCodeAt(k) === 10) lines++;
  return lines;
}

export { statSync };
