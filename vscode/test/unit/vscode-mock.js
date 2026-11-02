'use strict';

// A small stand-in for the `vscode` module: enough of the API for the controller, recording what it does.
const path = require('path');
const Module = require('module');

class Emitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
    };
  }

  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = 'file';
  }

  static file(p) {
    return new Uri(p);
  }

  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath, ...parts));
  }

  toString() {
    return 'file://' + this.fsPath;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

/** The glob subset CodeMap passes to findFiles: `**`, `*` and `{a,b}`. */
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      source += '(?:/.*)?';
      i += 2;
    } else if (c === '*') source += '[^/]*';
    else if (c === '{') source += '(?:';
    else if (c === '}') source += ')';
    else if (c === ',') source += '|';
    else source += c.replace(/[.+^$()|[\]\\?]/g, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

function createMock({ workspaceRoot, settings = {}, files = [] } = {}) {
  const log = { panels: [], posted: [], opened: [], errors: [], infos: [], warnings: [], clipboard: [], saved: [], external: [], executed: [], commands: new Map(), quickPicks: [] };
  const saveEmitter = new Emitter();

  const vscode = {
    Uri,
    Position,
    Range,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    ProgressLocation: { Notification: 15, Window: 10 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    env: {
      clipboard: { writeText: async (text) => log.clipboard.push(text) },
      openExternal: async (uri) => void log.external.push(uri.fsPath),
    },
    commands: {
      registerCommand: (id, fn) => {
        log.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => void log.executed.push(id),
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: () => ({ lines: [], appendLine(line) { this.lines.push(line); }, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
      createWebviewPanel: (viewType, title, showOptions, options) => {
        const received = new Emitter();
        const disposed = new Emitter();
        const viewState = new Emitter();
        const panel = {
          active: true,
          onDidChangeViewState: (listener) => viewState.event(listener),
          viewType,
          title,
          showOptions,
          options,
          visible: true,
          revealed: [],
          webview: {
            html: '',
            options: {},
            cspSource: 'vscode-webview://test',
            postMessage: async (message) => log.posted.push(message),
            onDidReceiveMessage: (listener) => received.event(listener),
          },
          reveal(column, preserveFocus) {
            this.revealed.push({ column, preserveFocus });
            this.visible = true;
            this.active = !preserveFocus;
            setTimeout(() => viewState.fire({ webviewPanel: this }), 10);
          },
          onDidDispose: (listener) => disposed.event(listener),
          dispose: () => disposed.fire(),
          /** test helper: a message from the viewer */
          receive: (message) => received.fire(message),
        };
        log.panels.push(panel);
        return panel;
      },
      registerWebviewPanelSerializer: () => ({ dispose() {} }),
      withProgress: async (options, task) => task({ report() {} }, { onCancellationRequested() {} }),
      showErrorMessage: async (message) => void log.errors.push(message),
      showInformationMessage: async (message) => void log.infos.push(message),
      showWarningMessage: async (message) => void log.warnings.push(message),
      setStatusBarMessage: () => ({ dispose() {} }),
      showQuickPick: async (items) => {
        log.quickPicks.push(items);
        return items[0];
      },
      showSaveDialog: async ({ defaultUri }) => defaultUri,
      showTextDocument: async (document, options) => void log.opened.push({ file: document.uri.fsPath, options }),
    },
    workspace: {
      workspaceFolders: workspaceRoot ? [{ uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot) }] : undefined,
      getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
      findFiles: async (pattern, exclude) => {
        const relative = (f) => path.relative(workspaceRoot ?? '', f).split(path.sep).join('/');
        const include = globToRegExp(pattern);
        const skip = exclude ? globToRegExp(exclude) : null;
        return files.filter((f) => include.test(relative(f)) && !skip?.test(relative(f))).map(Uri.file);
      },
      asRelativePath: (p) => path.relative(workspaceRoot ?? '', p),
      openTextDocument: async (uri) => ({ uri }),
      fs: { writeFile: async (uri, content) => void log.saved.push({ file: uri.fsPath, content: content.toString() }) },
      onDidSaveTextDocument: (listener) => saveEmitter.event(listener),
      onDidCreateFiles: () => ({ dispose() {} }),
      onDidDeleteFiles: () => ({ dispose() {} }),
    },
  };

  return { vscode, log, saveEmitter };
}

/** Makes `require('vscode')` return the mock for the code under test. */
function installMock(vscode) {
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'vscode') return vscode;
    return original.call(this, request, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
  return () => (Module._load = original);
}

function fakeContext(extensionPath, storagePath) {
  const state = new Map();
  return {
    extensionPath,
    extensionUri: Uri.file(extensionPath),
    storageUri: storagePath ? Uri.file(storagePath) : undefined,
    subscriptions: [],
    workspaceState: { get: (key) => state.get(key), update: async (key, value) => void state.set(key, value) },
  };
}

module.exports = { createMock, fakeContext, installMock, Uri };
