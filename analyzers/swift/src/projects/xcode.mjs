import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parsePlist } from './plist.mjs';
import { packageNameOfUrl } from './swiftpm.mjs';

const TESTS = /\.bundle\.(unit-test|ui-testing)$/;
const EXECUTABLES = /\.(application(\..*)?|tool|app-extension|extensionkit-extension|watchkit2-extension|xpc-service)$/;

/**
 * An Xcode project (App.xcodeproj) from its project.pbxproj:
 *   { bundle, dir, name, file, targets: [{ name, productType, test, executable, files, folders, dependencies,
 *     products, frameworks, line }] }
 * `files` are the Swift files of a target's sources build phase, found through the group tree; `folders` are Xcode
 * 16's synchronized folders, { dir, excluded, included } (files the folder's exceptions take out of, or add to, the
 * target). `dependencies` names other targets of the project; `products` are Swift package products, { product,
 * package } with the package's name, or `path` for a local package; `frameworks` the frameworks it links (Kingfisher
 * for Kingfisher.framework), which may be built by another project of the workspace.
 */
export function readXcodeProject(bundle) {
  const file = join(bundle, 'project.pbxproj');
  const text = readFileSync(file, 'utf8');
  const plist = parsePlist(text);
  const objects = plist.objects ?? {};
  const project = objects[plist.rootObject];
  if (!project) return null;
  const sourceRoot = resolve(dirname(bundle), project.projectDirPath ?? '');
  const paths = groupPaths(objects, project.mainGroup, sourceRoot);
  const lineOf = (id) => {
    const at = text.indexOf(`${id} /*`);
    const index = at >= 0 ? at : text.indexOf(`${id} =`);
    return index < 0 ? 1 : text.slice(0, index).split('\n').length;
  };

  const targets = [];
  const ids = (project.targets ?? []).filter((id) => objects[id]?.isa === 'PBXNativeTarget');
  // Every synchronized folder, with the targets that list it: one no target lists can still add files to a target
  // through its exceptions (Ice Cubes' notification extension).
  const syncOf = new Map();
  for (const [id, item] of Object.entries(objects)) if (item?.isa === 'PBXFileSystemSynchronizedRootGroup') syncOf.set(id, new Set());
  for (const id of ids) for (const group of objects[id].fileSystemSynchronizedGroups ?? []) {
    if (!syncOf.has(group)) syncOf.set(group, new Set());
    syncOf.get(group).add(id);
  }

  for (const id of ids) {
    const target = objects[id];
    const productType = target.productType ?? '';
    const files = new Set();
    const frameworks = [];
    for (const phaseId of target.buildPhases ?? []) {
      const phase = objects[phaseId];
      if (phase?.isa === 'PBXFrameworksBuildPhase') {
        for (const buildFileId of phase.files ?? []) {
          const reference = objects[objects[buildFileId]?.fileRef];
          const name = basename(reference?.path ?? reference?.name ?? '');
          if (/\.framework$/i.test(name)) frameworks.push(name.replace(/\.framework$/i, ''));
        }
      }

      if (phase?.isa !== 'PBXSourcesBuildPhase') continue;
      for (const buildFileId of phase.files ?? []) {
        const path = paths.get(objects[buildFileId]?.fileRef);
        if (path && extname(path) === '.swift') files.add(path);
      }
    }

    const folders = [];
    for (const groupId of target.fileSystemSynchronizedGroups ?? []) {
      const dir = paths.get(groupId);
      if (!dir) continue;
      folders.push({ dir, excluded: exceptionsFor(objects, groupId, id, dir), included: null });
    }

    // A synchronized folder of another target whose exceptions add some of its files to this one.
    for (const [groupId, owners] of syncOf) {
      if (owners.has(id)) continue;
      const dir = paths.get(groupId);
      const added = dir ? exceptionsFor(objects, groupId, id, dir) : null;
      if (added?.size) for (const path of added) if (extname(path) === '.swift') files.add(path);
    }

    const dependencies = [];
    for (const dependencyId of target.dependencies ?? []) {
      const dependency = objects[dependencyId];
      const other = objects[dependency?.target] ?? objects[objects[dependency?.targetProxy]?.remoteGlobalIDString];
      if (other?.name) dependencies.push(other.name);
    }

    const products = [];
    for (const productId of target.packageProductDependencies ?? []) {
      const product = objects[productId];
      if (!product?.productName) continue;
      const reference = objects[product.package];
      if (reference?.isa === 'XCLocalSwiftPackageReference') products.push({ product: product.productName, path: resolve(sourceRoot, reference.relativePath ?? '') });
      else if (reference?.repositoryURL) products.push({ product: product.productName, package: packageNameOfUrl(reference.repositoryURL) });
      else products.push({ product: product.productName, package: null });
    }

    targets.push({
      name: target.name ?? target.productName ?? id,
      productType,
      test: TESTS.test(productType),
      executable: EXECUTABLES.test(productType) && !TESTS.test(productType),
      files: [...files],
      folders,
      dependencies,
      products,
      frameworks,
      line: lineOf(id),
    });
  }

  return { bundle, file, dir: dirname(bundle), sourceRoot, name: basename(bundle).replace(/\.xcodeproj$/i, ''), targets };
}

/** The folder or file every group and file reference of the project stands for, from the main group down. */
function groupPaths(objects, mainGroup, sourceRoot) {
  const paths = new Map();
  const visit = (id, parentPath, depth) => {
    const item = objects[id];
    if (!item || depth > 64) return;
    let path = null;
    const tree = item.sourceTree ?? '<group>';
    if (tree === '<group>') path = item.path ? resolve(parentPath, item.path) : parentPath;
    else if (tree === 'SOURCE_ROOT') path = item.path ? resolve(sourceRoot, item.path) : sourceRoot;
    else if (tree === '<absolute>') path = item.path ?? null;
    if (path) paths.set(id, path);
    for (const child of item.children ?? []) visit(child, path ?? parentPath, depth + 1);
  };
  visit(mainGroup, sourceRoot, 0);
  return paths;
}

/** The files the exception sets of a synchronized folder name for a target, as full paths. */
function exceptionsFor(objects, groupId, targetId, dir) {
  const out = new Set();
  for (const exceptionId of objects[groupId]?.exceptions ?? []) {
    const exception = objects[exceptionId];
    if (exception?.isa !== 'PBXFileSystemSynchronizedBuildFileExceptionSet' || exception.target !== targetId) continue;
    for (const path of exception.membershipExceptions ?? []) out.add(resolve(dir, path));
  }

  return out;
}

/**
 * The projects and packages an Xcode workspace (App.xcworkspace) lists, from contents.xcworkspacedata:
 *   { projects: [bundle paths], packages: [folders with a Package.swift] }
 * Locations are `group:` (relative to the enclosing group), `container:` (relative to the workspace's folder) or
 * `absolute:`.
 */
export function readWorkspace(bundle) {
  const text = readFileSync(join(bundle, 'contents.xcworkspacedata'), 'utf8');
  const base = dirname(bundle);
  const stack = [base];
  const projects = [];
  const folders = [];
  for (const match of text.matchAll(/<(\/?)(Group|FileRef)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attributes, selfClosing] = match;
    if (closing) {
      if (tag === 'Group' && stack.length > 1) stack.pop();
      continue;
    }

    const location = /location\s*=\s*"([^"]*)"/.exec(attributes)?.[1] ?? '';
    const path = locate(location, stack[stack.length - 1], base);
    if (tag === 'Group') {
      if (!selfClosing) stack.push(path ?? stack[stack.length - 1]);
    } else if (path) {
      if (/\.xcodeproj$/i.test(path)) projects.push(path);
      else if (!/\.(xcworkspace|playground)$/i.test(path)) folders.push(path);
    }
  }

  return { projects, folders };
}

function locate(location, group, base) {
  const colon = location.indexOf(':');
  const kind = location.slice(0, colon);
  const path = location.slice(colon + 1);
  if (kind === 'group') return resolve(group, path);
  if (kind === 'container') return resolve(base, path);
  if (kind === 'absolute') return path;
  return null;
}
