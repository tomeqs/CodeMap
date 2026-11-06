'use strict';

const fs = require('fs');
const path = require('path');
const { analyzerEnv, resolveAnalyzer } = require('./analyzer');

/** The id of the provider in package.json (`contributes.mcpServerDefinitionProviders`). */
const PROVIDER_ID = 'codemap.mcp';
/** The server's name in Cursor and in mcp.json files. */
const SERVER_NAME = 'codemap';
/** Settings that change how the server is started. */
const SERVER_SETTINGS = ['codemap.mcpServer', 'codemap.analyzerPath', 'codemap.dotnetPath', 'codemap.nodePath'];

/**
 * How the editor starts `codemap mcp` for its agents: the analyzer the map uses, with `mcp --root <folder>`. The
 * environment holds only what CodeMap adds to the editor's own (Node.js for TypeScript, no .NET banners).
 */
function serverLaunch({ extensionPath, settings = {}, folder, base = process.env, runtime } = {}) {
  const analyzer = resolveAnalyzer({ extensionPath, analyzerPath: settings.analyzerPath, dotnetPath: settings.dotnetPath });
  const args = [...analyzer.args, 'mcp'];
  if (folder) args.push('--root', folder);
  return { command: analyzer.command, args, env: added(analyzerEnv({ nodePath: settings.nodePath }, base, runtime), base), label: analyzer.label };
}

/**
 * A configuration to keep in a file (`.cursor/mcp.json`, `.vscode/mcp.json`) or to paste into another agent. It has to
 * outlive this copy of the extension, whose folder changes with every update, so `codemap` on PATH comes before the
 * bundled analyzer; `pinned` says when it still points into the extension.
 */
function portableLaunch({ extensionPath, settings = {}, root, base = process.env, runtime, onPath = findOnPath } = {}) {
  let analyzer = resolveAnalyzer({ extensionPath, analyzerPath: settings.analyzerPath, dotnetPath: settings.dotnetPath });
  if (!settings.analyzerPath && analyzer.args.length && onPath('codemap', base)) analyzer = { command: 'codemap', args: [] };
  const pinned = !settings.analyzerPath && analyzer.args.some((a) => a.startsWith(extensionPath));

  const env = {};
  if (settings.nodePath) env.CODEMAP_NODE = settings.nodePath;
  else if (!base.CODEMAP_NODE && !onPath('node', base)) Object.assign(env, added(analyzerEnv({}, {}, runtime), {}, ['CODEMAP_NODE', 'ELECTRON_RUN_AS_NODE']));

  const args = [...analyzer.args, 'mcp'];
  if (root) args.push('--root', root);
  return { command: analyzer.command, args, env, pinned };
}

/** The variables of `env` that `base` does not already have (optionally only some names). */
function added(env, base, names = null) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && base[key] !== value && (!names || names.includes(key))) result[key] = String(value);
  }

  return result;
}

/** Whether an executable is on PATH (with the Windows extensions). */
function findOnPath(name, env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  return dirs.some((dir) => extensions.some((ext) => {
    try {
      return fs.statSync(path.join(dir, name + ext)).isFile();
    } catch {
      return false;
    }
  }));
}

/** The entry of an mcp.json file: Cursor (and most agents) under `mcpServers`, VS Code under `servers` with a type. */
function configEntry(launch, { vscodeFormat = false } = {}) {
  const entry = vscodeFormat ? { type: 'stdio', command: launch.command, args: launch.args } : { command: launch.command, args: launch.args };
  if (Object.keys(launch.env).length) entry.env = launch.env;
  return entry;
}

/** `claude mcp add` for Claude Code, quoted for a POSIX shell. */
function claudeCommand(launch) {
  const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const env = Object.entries(launch.env).map(([k, v]) => `-e ${quote(`${k}=${v}`)} `).join('');
  return `claude mcp add ${env}${SERVER_NAME} -- ${[launch.command, ...launch.args].map(quote).join(' ')}`;
}

/**
 * Adds CodeMap to an mcp.json text, keeping what is there. Returns null when the text is not plain JSON (VS Code
 * allows comments in its mcp.json; rewriting it would lose them).
 */
function mergeConfig(text, entry, { vscodeFormat = false } = {}) {
  const key = vscodeFormat ? 'servers' : 'mcpServers';
  let config = {};
  if (text && text.trim()) {
    try {
      config = JSON.parse(text);
    } catch {
      return null;
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  }

  const servers = config[key] && typeof config[key] === 'object' ? config[key] : {};
  return { text: JSON.stringify({ ...config, [key]: { ...servers, [SERVER_NAME]: entry } }, null, 2) + '\n', replaced: SERVER_NAME in servers };
}

function isCursor(vscode) {
  return !!vscode.cursor || /cursor/i.test(vscode.env?.appName ?? '');
}

/**
 * Offers `codemap mcp` to the editor's AI agents: through VS Code's MCP server provider API (Copilot's agent mode), or
 * Cursor's extension API. Only in trusted workspaces, and unless `codemap.mcpServer` is off. Returns how it was
 * offered: 'vscode', 'cursor' or null (an editor without either API: the commands still write a configuration).
 */
function registerMcpServer(context, vscode, { version } = {}) {
  const settings = () => vscode.workspace.getConfiguration('codemap');
  const enabled = () => settings().get('mcpServer', true) !== false && vscode.workspace.isTrusted !== false;
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const launch = () => serverLaunch({
    extensionPath: context.extensionPath,
    settings: { analyzerPath: settings().get('analyzerPath'), dotnetPath: settings().get('dotnetPath'), nodePath: settings().get('nodePath') },
    folder: folder(),
  });

  let refresh;
  let kind = null;
  const cursorMcp = vscode.cursor?.mcp;
  if (typeof cursorMcp?.registerServer === 'function') {
    kind = 'cursor';
    let registered = false;
    const unregister = () => {
      if (registered) cursorMcp.unregisterServer?.(SERVER_NAME);
      registered = false;
    };
    refresh = () => {
      unregister();
      if (!enabled()) return;
      const { command, args, env } = launch();
      cursorMcp.registerServer({ name: SERVER_NAME, server: { command, args, env } });
      registered = true;
    };
    context.subscriptions.push({ dispose: unregister });
    refresh();
  } else if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function' && vscode.McpStdioServerDefinition) {
    kind = 'vscode';
    const changed = new vscode.EventEmitter();
    const provider = {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        if (!enabled()) return [];
        const { command, args, env } = launch();
        const definition = new vscode.McpStdioServerDefinition('CodeMap', command, args, env, version);
        if (folder()) definition.cwd = vscode.Uri.file(folder());
        return [definition];
      },
    };
    refresh = () => changed.fire();
    context.subscriptions.push(changed, vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
  } else {
    return null;
  }

  const listen = (event, handler) => {
    if (typeof event === 'function') context.subscriptions.push(event(handler));
  };
  listen(vscode.workspace.onDidChangeConfiguration, (e) => SERVER_SETTINGS.some((s) => e.affectsConfiguration(s)) && refresh());
  listen(vscode.workspace.onDidGrantWorkspaceTrust, refresh);
  listen(vscode.workspace.onDidChangeWorkspaceFolders, refresh);
  return kind;
}

/** The commands: copy a configuration for another agent, or add CodeMap to the workspace's mcp.json. */
class McpCommands {
  constructor(context, vscode, { registered = null, runtime } = {}) {
    this.context = context;
    this.vscode = vscode;
    this.registered = registered;
    this.runtime = runtime;
  }

  launch(root) {
    const settings = this.vscode.workspace.getConfiguration('codemap');
    return portableLaunch({
      extensionPath: this.context.extensionPath,
      settings: { analyzerPath: settings.get('analyzerPath'), dotnetPath: settings.get('dotnetPath'), nodePath: settings.get('nodePath') },
      root,
      runtime: this.runtime,
    });
  }

  /** Whether the editor's agents already have the server (offered by registerMcpServer, on, in a trusted workspace). */
  get offered() {
    return !!this.registered && this.vscode.workspace.getConfiguration('codemap').get('mcpServer', true) !== false && this.vscode.workspace.isTrusted !== false;
  }

  async copyConfiguration() {
    const vscode = this.vscode;
    const choice = await vscode.window.showQuickPick([
      { label: 'mcp.json', description: 'Cursor, Claude Desktop, Windsurf and most agents', id: 'json' },
      { label: 'Claude Code', description: 'the claude mcp add command', id: 'claude' },
      { label: 'VS Code mcp.json', description: '.vscode/mcp.json', id: 'vscode' },
    ], { placeHolder: 'Copy the CodeMap MCP server configuration for…' });
    if (!choice) return;

    // VS Code fills in ${workspaceFolder}; other agents get the folder itself.
    const launch = this.launch(choice.id === 'vscode' ? '${workspaceFolder}' : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const text = choice.id === 'claude'
      ? claudeCommand(launch)
      : JSON.stringify({ [choice.id === 'vscode' ? 'servers' : 'mcpServers']: { [SERVER_NAME]: configEntry(launch, { vscodeFormat: choice.id === 'vscode' }) } }, null, 2);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`CodeMap: the MCP server configuration is on the clipboard.${pinnedNote(launch)}`);
  }

  /** Adds CodeMap to `.cursor/mcp.json` (Cursor) or `.vscode/mcp.json` (VS Code) in the first workspace folder. */
  async addToWorkspace() {
    const vscode = this.vscode;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      vscode.window.showWarningMessage('CodeMap: open a folder first.');
      return;
    }

    const cursor = isCursor(vscode);
    const relative = cursor ? '.cursor/mcp.json' : '.vscode/mcp.json';
    if (this.offered) {
      const answer = await vscode.window.showInformationMessage(
        `CodeMap already offers its MCP server to this editor's agents. Add it to ${relative} anyway (to share it with the team)?`,
        { modal: true },
        'Add',
      );
      if (answer !== 'Add') return;
    }

    const file = vscode.Uri.joinPath(folder, ...relative.split('/'));
    let text = '';
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    } catch {
      // no file yet
    }

    const launch = this.launch('${workspaceFolder}');
    const merged = mergeConfig(text, configEntry(launch, { vscodeFormat: !cursor }), { vscodeFormat: !cursor });
    if (!merged) {
      const choice = await vscode.window.showWarningMessage(`CodeMap: ${relative} is not plain JSON (comments?), so it was left as it is.`, 'Copy Configuration');
      if (choice) await this.copyConfiguration();
      return;
    }

    await vscode.workspace.fs.createDirectory?.(vscode.Uri.joinPath(folder, relative.split('/')[0]));
    await vscode.workspace.fs.writeFile(file, Buffer.from(merged.text, 'utf8'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    vscode.window.showInformationMessage(`CodeMap: ${merged.replaced ? 'updated' : 'added'} the MCP server in ${relative}.${pinnedNote(launch)}`);
  }
}

function pinnedNote(launch) {
  return launch.pinned
    ? ' It runs the analyzer inside this version of the extension: after an update, add it again, or install the codemap tool (dotnet tool install -g CodeMap.Tool) and add it then.'
    : '';
}

module.exports = {
  PROVIDER_ID,
  SERVER_NAME,
  McpCommands,
  claudeCommand,
  configEntry,
  findOnPath,
  isCursor,
  mergeConfig,
  portableLaunch,
  registerMcpServer,
  serverLaunch,
};
