/**
 * Inside the VS Code extension the map runs in a webview: the extension sends the graph, and file links,
 * downloads and the clipboard go back to it (a webview cannot open editors, save files or always reach
 * the clipboard on its own). Outside VS Code `host` is null and the viewer works as a normal page.
 */
function detectHost() {
  if (typeof acquireVsCodeApi !== 'function') return null;
  const api = acquireVsCodeApi();
  const listeners = new Set();
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && typeof message.type === 'string') for (const listener of listeners) listener(message);
  });

  return {
    kind: 'vscode',
    post: (type, payload = {}) => api.postMessage({ type, ...payload }),
    onMessage: (listener) => listeners.add(listener),
    /** Opens a source file (path relative to the analyzed root) at a line in the editor. */
    openFile: (file, line) => api.postMessage({ type: 'openFile', file, line }),
    /** Asks the extension to save a file (save dialog in VS Code). */
    save: (name, content, mime) => api.postMessage({ type: 'save', name, content, mime }),
    copy: (text) => api.postMessage({ type: 'copy', text }),
  };
}

export const host = detectHost();
