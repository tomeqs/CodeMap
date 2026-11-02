'use strict';

const path = require('path');

/**
 * Path of a file relative to the analyzed root with forward slashes, the way the graph stores locations;
 * null when the file is outside the root.
 */
function relativeToRoot(root, file, platform = process.platform) {
  if (!root) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const relative = p.relative(root, file);
  if (!relative || relative.startsWith('..') || p.isAbsolute(relative)) return null;
  return relative.split(p.sep).join('/');
}

/** The innermost node (member before type before namespace) declared at a line of a file. */
function nodeAt(doc, relativeFile, line, { ignoreCase = process.platform === 'win32' } = {}) {
  const same = ignoreCase ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  let best = null;
  for (const node of doc.nodes) {
    if (node.external) continue;
    for (const location of [node.location, ...(node.extraLocations ?? [])]) {
      if (!location || !same(location.file, relativeFile)) continue;
      const end = location.endLine ?? location.line;
      if (line < location.line || line > end) continue;
      const span = end - location.line;
      if (!best || span < best.span) best = { node, span };
    }
  }

  return best?.node ?? null;
}

// Declarations a flow starts from: C# methods, constructors and properties, TypeScript / JavaScript functions.
const FLOW_MEMBERS = new Set(['method', 'constructor', 'property', 'function']);
// Declarations whose entry methods start the flow: classes and the like, and TypeScript / JavaScript files (modules).
const FLOW_OWNERS = new Set(['class', 'struct', 'record', 'recordStruct', 'interface', 'module']);

/**
 * Ids to start a call flow from: the method or function under the cursor, otherwise the class or file it is in
 * (the map follows that one's entry methods: routes, controller actions, public methods...).
 */
function flowRootsFor(doc, node) {
  if (!node) return [];
  if (FLOW_MEMBERS.has(node.kind) || FLOW_OWNERS.has(node.kind)) return [node.id];
  const parent = node.parent && doc.nodes.find((n) => n.id === node.parent);
  return parent && FLOW_OWNERS.has(parent.kind) ? [parent.id] : [];
}

/** Absolute path of a graph location, refusing anything that would leave the analyzed root. */
function resolveInRoot(root, relativeFile, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const full = p.resolve(root, relativeFile);
  const relative = p.relative(root, full);
  if (!relative || relative.startsWith('..') || p.isAbsolute(relative)) return null;
  return full;
}

module.exports = { flowRootsFor, nodeAt, relativeToRoot, resolveInRoot };
