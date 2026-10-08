'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { resolveAnalyzer, runAnalyzer } = require('./analyzer');
const { standaloneHtml, webviewHtml } = require('./html');
const { flowRootsFor, nodeAt, relativeToRoot, resolveInRoot } = require('./locate');

const VIEW_TYPE = 'codemap.map';
const TARGET_KEY = 'codemap.target';
const CACHE_FILE = 'map.codemap.json';
const SOURCE_FILES = /\.(cs|csproj|props|targets|sln|slnx|slnf)$/i;
const EXCLUDE = '**/{node_modules,bin,obj,.git,.vs}/**';
const READY_TIMEOUT_MS = 30000;

/** One code map per window: the webview with the 3D map, the analysis behind it and the live updates. */
class CodeMapController {
  constructor(context) {
    this.context = context;
    this.panel = null;
    this.ready = false;
    this.queue = [];
    this.doc = null;
    this.running = null;
    this.pending = false;
    this.output = vscode.window.createOutputChannel('CodeMap');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.status.command = 'codemap.open';
    this.loadedWaiters = [];
    this.saveTimer = null;
    context.subscriptions.push(this.output, this.status);
  }

  get settings() {
    return vscode.workspace.getConfiguration('codemap');
  }

  get target() {
    return this.context.workspaceState.get(TARGET_KEY);
  }

  // ------------------------------------------------------------------ commands

  /** Opens (or shows) the map. `uri`: a solution, project or folder from the explorer. */
  async open(uri, { column } = {}) {
    let target = uri?.fsPath;
    if (!target) target = this.target && fs.existsSync(this.target) ? this.target : await this.pickTarget();
    if (!target) return false;
    const changed = target !== this.target;
    await this.context.workspaceState.update(TARGET_KEY, target);

    if (this.panel) {
      this.panel.reveal(column);
      if (changed || !this.doc) {
        this.doc = null;
        await this.analyze();
      }

      return true;
    }

    // Opened next to an editor: keep the focus there, so "beside" stays the map's column.
    this.createPanel(column ?? vscode.ViewColumn.Active, column === vscode.ViewColumn.Beside);
    this.showCached(target);
    await this.analyze({ preserve: !!this.doc });
    return true;
  }

  async chooseTarget() {
    const target = await this.pickTarget({ always: true });
    if (target) await this.open(vscode.Uri.file(target));
  }

  /** Editor → map: selects the method / type under the cursor. */
  async revealAt(editor) {
    const node = await this.nodeUnderCursor(editor);
    if (!node) return;
    this.showBeside();
    this.send({ type: 'reveal', id: node.id });
  }

  /** Editor → map: the call flow starting at the method (or type) under the cursor, with its sequence diagram. */
  async flowAt(editor) {
    const node = await this.nodeUnderCursor(editor);
    if (!node) return;
    const ids = flowRootsFor(this.doc, node);
    if (!ids.length) {
      vscode.window.showInformationMessage('CodeMap: put the cursor in a method or a class to follow its calls.');
      return;
    }

    this.showBeside();
    this.send({ type: 'flow', ids, sequence: true });
  }

  async nodeUnderCursor(editor) {
    if (!editor) return null;
    if (!this.panel && !(await this.open(undefined, { column: vscode.ViewColumn.Beside }))) return null;
    const doc = await this.whenLoaded();
    if (!doc) return null;
    const root = doc.source?.root;
    const relative = relativeToRoot(root, editor.document.uri.fsPath);
    const node = relative && nodeAt(doc, relative, editor.selection.active.line + 1);
    if (!node) {
      vscode.window.showInformationMessage(
        relative ? 'CodeMap: nothing declared here is on the map.' : `CodeMap: this file is outside the analyzed folder (${root}).`,
      );
      return null;
    }

    return node;
  }

  /** Brings the map into view next to the editor, without taking the focus away from the code. */
  showBeside() {
    if (!this.panel.visible) this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  // ------------------------------------------------------------------ webview

  createPanel(column, preserveFocus = false) {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Code Map', { viewColumn: column, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true, // the 3D layout and camera survive switching tabs
      localResourceRoots: [],
    });
    this.adopt(panel);
  }

  /** Wires a panel up: a new one, or one VS Code restored after a restart. */
  adopt(panel) {
    this.panel = panel;
    this.ready = false;
    this.queue = [];
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    const viewer = fs.readFileSync(path.join(this.context.extensionPath, 'media', 'viewer.html'), 'utf8');
    panel.webview.html = webviewHtml(viewer, { cspSource: panel.webview.cspSource });
    this.fatal = null;
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.panel === panel && !this.ready && !this.fatal) this.offerBrowser('The map did not start in this window.');
    }, READY_TIMEOUT_MS);
    panel.webview.onDidReceiveMessage((message) => this.onMessage(message), null, this.context.subscriptions);
    panel.onDidDispose(() => {
      clearTimeout(this.readyTimer);
      this.running?.abort();
      this.panel = null;
      this.ready = false;
      this.doc = null;
      this.status.hide();
      this.resolveLoaded(null);
    }, null, this.context.subscriptions);
    this.updateStatus();
  }

  send(message) {
    if (!this.panel) return;
    if (!this.ready) {
      // only the latest graph matters
      if (message.type === 'load') this.queue = this.queue.filter((m) => m.type !== 'load');
      this.queue.push(message);
      return;
    }

    this.panel.webview.postMessage(message);
  }

  async onMessage(message) {
    switch (message?.type) {
      case 'ready':
        this.ready = true;
        clearTimeout(this.readyTimer);
        for (const queued of this.queue.splice(0)) this.panel.webview.postMessage(queued);
        break;
      case 'fatal':
        // The webview cannot show the 3D map (no WebGL 2): offer the browser instead.
        clearTimeout(this.readyTimer);
        this.fatal = String(message.message ?? 'The map could not start.');
        this.output.appendLine(this.fatal);
        this.offerBrowser(this.fatal);
        break;
      case 'openFile':
        await this.openFile(message.file, message.line);
        break;
      case 'save':
        await this.saveFile(message.name, message.content);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(message.text ?? ''));
        vscode.window.setStatusBarMessage('CodeMap: copied to the clipboard', 2500);
        break;
      case 'reanalyze':
        await this.analyze({ preserve: true });
        break;
    }
  }

  async openFile(file, line) {
    const root = this.doc?.source?.root;
    const full = root && typeof file === 'string' ? resolveInRoot(root, file) : null;
    if (!full) return;
    const position = new vscode.Position(Math.max(0, (Number(line) || 1) - 1), 0);
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(position, position) });
    } catch (error) {
      vscode.window.showWarningMessage(`CodeMap: could not open ${file}: ${error.message}`);
    }
  }

  async offerBrowser(reason) {
    const choice = await vscode.window.showErrorMessage(`CodeMap: ${reason}`, 'Open in Browser', 'Show Output');
    if (choice === 'Open in Browser') await this.openInBrowser();
    else if (choice === 'Show Output') this.output.show();
  }

  /** The map as a standalone HTML file in the default browser (its file links open VS Code at the right line). */
  async openInBrowser() {
    if (!this.doc && !(await this.open())) return;
    const doc = await this.whenLoaded();
    if (!doc) return;
    const viewer = fs.readFileSync(path.join(this.context.extensionPath, 'media', 'viewer.html'), 'utf8');
    const folder = this.context.storageUri?.fsPath ?? this.context.globalStorageUri?.fsPath ?? require('os').tmpdir();
    const file = path.join(folder, `${(doc.source?.name ?? 'codemap').replace(/[^\w.-]+/g, '_')}.html`);
    await fs.promises.mkdir(folder, { recursive: true });
    await fs.promises.writeFile(file, standaloneHtml(viewer, doc));
    await vscode.env.openExternal(vscode.Uri.file(file));
  }

  async saveFile(name, content) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const safeName = path.basename(String(name || 'codemap.txt'));
    const uri = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, safeName) : undefined });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(String(content ?? ''), 'utf8'));
    const action = await vscode.window.showInformationMessage(`CodeMap: saved ${path.basename(uri.fsPath)}`, 'Open');
    if (action === 'Open') await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
  }

  // ------------------------------------------------------------------ analysis

  async analyze({ preserve = false } = {}) {
    if (!this.panel) return;
    const target = this.target;
    if (!target) return;
    if (this.running) {
      this.pending = true;
      return;
    }

    const settings = this.settings;
    const analyzer = resolveAnalyzer({
      extensionPath: this.context.extensionPath,
      analyzerPath: settings.get('analyzerPath'),
      dotnetPath: settings.get('dotnetPath'),
    });
    const options = {
      includeTests: settings.get('includeTests', true),
      includeExternal: settings.get('includeExternal', false),
      gitHistory: settings.get('gitHistory', true),
    };

    const controller = new AbortController();
    this.running = controller;
    this.updateStatus();
    this.send({ type: 'status', text: preserve ? 'Updating the map…' : `Analyzing ${path.basename(target)}…` });
    this.output.appendLine(`\n[${new Date().toLocaleTimeString()}] ${target} (${analyzer.label})`);

    try {
      const doc = await vscode.window.withProgress(
        { location: preserve ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: 'CodeMap', cancellable: !preserve },
        (progress, token) => {
          token?.onCancellationRequested(() => controller.abort());
          return runAnalyzer(analyzer, target, options, {
            cwd: path.dirname(target),
            signal: controller.signal,
            onLine: (line) => {
              this.output.appendLine(line);
              progress.report({ message: line.trim().slice(0, 90) });
            },
          });
        },
      );

      if (!this.panel || this.target !== target) return;
      this.doc = doc;
      this.send({ type: 'load', doc, preserve: preserve && this.ready, watching: settings.get('liveUpdate', true) });
      this.resolveLoaded(doc);
      this.writeCache(doc);
    } catch (error) {
      if (error.cancelled) {
        this.send({ type: 'status', text: null });
      } else {
        const message = String(error.message ?? error);
        this.output.appendLine(message);
        this.send({ type: 'error', message: message.split('\n')[0] });
        if (!this.doc) this.resolveLoaded(null);
        vscode.window.showErrorMessage(`CodeMap: ${message.split('\n')[0]}`, 'Show Output').then((choice) => choice && this.output.show());
      }
    } finally {
      this.running = null;
      this.updateStatus();
      if (this.pending) {
        this.pending = false;
        this.analyze({ preserve: true });
      }
    }
  }

  /** Live updates: analyze again shortly after C# or project files are saved, created or deleted. */
  onFileChanged(file) {
    if (!this.panel || !this.doc || !this.settings.get('liveUpdate', true) || !SOURCE_FILES.test(file)) return;
    if (!relativeToRoot(this.doc.source?.root, file)) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.analyze({ preserve: true }), 900);
  }

  whenLoaded() {
    if (this.doc) return Promise.resolve(this.doc);
    if (!this.panel) return Promise.resolve(null);
    return new Promise((resolve) => this.loadedWaiters.push(resolve));
  }

  resolveLoaded(doc) {
    for (const resolve of this.loadedWaiters.splice(0)) resolve(doc);
  }

  // ------------------------------------------------------------------ cache (instant map when reopening)

  cachePath() {
    return this.context.storageUri ? path.join(this.context.storageUri.fsPath, CACHE_FILE) : null;
  }

  showCached(target) {
    const file = this.cachePath();
    if (!file || !fs.existsSync(file)) return;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc?.source?.path !== target) return;
      this.doc = doc;
      this.send({ type: 'load', doc, watching: this.settings.get('liveUpdate', true) });
      this.resolveLoaded(doc);
    } catch {
      // a broken cache is simply ignored
    }
  }

  writeCache(doc) {
    const file = this.cachePath();
    if (!file) return;
    fs.promises.mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.promises.writeFile(file, JSON.stringify(doc)))
      .catch(() => {});
  }

  // ------------------------------------------------------------------ helpers

  updateStatus() {
    if (!this.panel) return this.status.hide();
    this.status.text = this.running ? '$(sync~spin) CodeMap' : '$(type-hierarchy) CodeMap';
    this.status.tooltip = this.running ? 'Analyzing…' : `Code map of ${this.target ?? 'the workspace'}`;
    this.status.show();
  }

  /** Solutions first (shallowest first), then projects; asks when there is more than one. */
  async pickTarget({ always = false } = {}) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      vscode.window.showWarningMessage('CodeMap: open a folder with a C# solution or project first.');
      return null;
    }

    let candidates = await vscode.workspace.findFiles('**/*.{sln,slnx,slnf}', EXCLUDE, 50);
    if (!candidates.length) candidates = await vscode.workspace.findFiles('**/*.csproj', EXCLUDE, 200);
    const paths = candidates.map((uri) => uri.fsPath).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    if (!paths.length) return folders[0].uri.fsPath;
    if (paths.length === 1 && !always) return paths[0];

    const items = [
      ...paths.map((p) => ({ label: path.basename(p), description: vscode.workspace.asRelativePath(path.dirname(p)), target: p })),
      ...folders.map((f) => ({ label: `$(folder) ${f.name}`, description: 'every C# file in the folder', target: f.uri.fsPath })),
    ];
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Which solution or project should CodeMap analyze?' });
    return choice?.target ?? null;
  }
}

function depth(file) {
  return file.split(/[\\/]/).length;
}

function activate(context) {
  const controller = new CodeMapController(context);
  const editorCommand = (fn) => () => fn(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.open', (uri) => controller.open(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand('codemap.chooseTarget', () => controller.chooseTarget()),
    vscode.commands.registerCommand('codemap.refresh', () => controller.analyze({ preserve: true })),
    vscode.commands.registerCommand('codemap.openInBrowser', () => controller.openInBrowser()),
    vscode.commands.registerCommand('codemap.revealInMap', editorCommand((editor) => controller.revealAt(editor))),
    vscode.commands.registerCommand('codemap.callFlow', editorCommand((editor) => controller.flowAt(editor))),
    vscode.workspace.onDidSaveTextDocument((document) => controller.onFileChanged(document.uri.fsPath)),
    vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => controller.onFileChanged(uri.fsPath))),
    vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => controller.onFileChanged(uri.fsPath))),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      // VS Code restarted with the map open: bring it back with the last graph, then refresh it.
      async deserializeWebviewPanel(panel) {
        if (controller.panel) return panel.dispose();
        controller.adopt(panel);
        if (controller.target) {
          controller.showCached(controller.target);
          await controller.analyze({ preserve: !!controller.doc });
        }
      },
    }),
  );

  return { controller };
}

function deactivate() {}

module.exports = { activate, deactivate, CodeMapController };
