import { closeSync, openSync, writeSync } from 'node:fs';

/**
 * Writes the fragment a node at a time: one JSON.stringify of a big monorepo's graph can exceed the longest
 * string V8 allows.
 */
export function writeFragment(path, { source, nodes, edges, analysis }) {
  const fd = openSync(path, 'w');
  try {
    const write = (text) => writeSync(fd, text);
    write(`{"format":"codemap","version":"1.1","source":${JSON.stringify(source)},"nodes":[`);
    writeList(write, nodes);
    write('],"edges":[');
    writeList(write, edges);
    write(`],"analysis":${JSON.stringify(analysis)}}`);
  } finally {
    closeSync(fd);
  }
}

function writeList(write, items) {
  let chunk = '';
  let first = true;
  for (const item of items) {
    chunk += (first ? '' : ',') + JSON.stringify(item);
    first = false;
    if (chunk.length > 1 << 20) {
      write(chunk);
      chunk = '';
    }
  }

  if (chunk) write(chunk);
}
