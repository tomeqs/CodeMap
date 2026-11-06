'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createMock, fakeContext, installMock } = require('./vscode-mock');
const { claudeCommand, configEntry, findOnPath, mergeConfig, portableLaunch, serverLaunch } = require('../../src/mcp');

const electron = { execPath: '/apps/Code Helper', electron: true };

/** An extension folder with the bundled analyzer. */
function bundledExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-ext-'));
  fs.mkdirSync(path.join(dir, 'analyzer'));
  fs.writeFileSync(path.join(dir, 'analyzer', 'codemap.dll'), '');
  return dir;
}

/** The mock with VS Code's MCP API (or Cursor's), recording what the extension registers. */
function mcpMock({ cursor = false, vscodeApi = true, settings = {}, workspaceRoot = '/work/shop' } = {}) {
  const mock = createMock({ workspaceRoot, settings });
  const { vscode, log } = mock;
  const config = new (vscode.EventEmitter)();
  const trust = new (vscode.EventEmitter)();
  vscode.workspace.onDidChangeConfiguration = config.event;
  vscode.workspace.onDidGrantWorkspaceTrust = trust.event;
  log.providers = [];
  log.cursor = [];
  if (vscodeApi) {
    vscode.McpStdioServerDefinition = class {
      constructor(label, command, args, env, version) {
        Object.assign(this, { label, command, args, env, version });
      }
    };
    vscode.lm = { registerMcpServerDefinitionProvider: (id, provider) => (log.providers.push({ id, provider }), { dispose() {} }) };
  }

  if (cursor) {
    vscode.env.appName = 'Cursor';
    vscode.cursor = {
      mcp: {
        registerServer: (server) => log.cursor.push(['register', server]),
        unregisterServer: (name) => log.cursor.push(['unregister', name]),
      },
    };
  }

  const changeSetting = (key) => config.fire({ affectsConfiguration: (section) => section === key });
  return { ...mock, changeSetting, grantTrust: () => trust.fire() };
}

function activateWith(mock, extensionPath) {
  const restore = installMock(mock.vscode);
  try {
    const extension = require('../../src/extension');
    const context = { ...fakeContext(extensionPath), extension: { packageJSON: { version: '9.9.9' } } };
    return { result: extension.activate(context), context };
  } finally {
    restore();
  }
}

test('the server starts like the analyzer, with mcp --root and only the variables CodeMap adds', () => {
  const ext = bundledExtension();
  const base = { PATH: '/usr/bin', DOTNET_NOLOGO: '1' };
  const launch = serverLaunch({ extensionPath: ext, folder: '/work/shop', base, runtime: electron });
  assert.equal(launch.command, 'dotnet');
  assert.deepEqual(launch.args, [path.join(ext, 'analyzer', 'codemap.dll'), 'mcp', '--root', '/work/shop']);
  assert.deepEqual(launch.env, { DOTNET_CLI_TELEMETRY_OPTOUT: '1', CODEMAP_NODE: '/apps/Code Helper', ELECTRON_RUN_AS_NODE: '1' });

  const own = serverLaunch({ extensionPath: ext, settings: { analyzerPath: '/opt/codemap', nodePath: '/opt/node' }, base: { CODEMAP_NODE: '/x' }, runtime: electron });
  assert.equal(own.command, '/opt/codemap');
  assert.deepEqual(own.args, ['mcp']);
  assert.equal(own.env.CODEMAP_NODE, '/opt/node');
  assert.equal(own.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(serverLaunch({ extensionPath: ext, base: { CODEMAP_NODE: '/x' }, runtime: electron }).env.CODEMAP_NODE, undefined, 'the environment already has it');
});

test('a configuration kept in a file prefers codemap on PATH to the copy inside this version of the extension', () => {
  const ext = bundledExtension();
  const onPath = (names) => (name) => names.includes(name);
  const tool = portableLaunch({ extensionPath: ext, root: '${workspaceFolder}', base: {}, runtime: electron, onPath: onPath(['codemap', 'node']) });
  assert.deepEqual(tool, { command: 'codemap', args: ['mcp', '--root', '${workspaceFolder}'], env: {}, pinned: false });

  const bundled = portableLaunch({ extensionPath: ext, base: {}, runtime: electron, onPath: onPath([]) });
  assert.equal(bundled.command, 'dotnet');
  assert.equal(bundled.pinned, true);
  assert.deepEqual(bundled.env, { CODEMAP_NODE: '/apps/Code Helper', ELECTRON_RUN_AS_NODE: '1' }, 'no node on PATH: the editor\'s own');

  const set = portableLaunch({ extensionPath: ext, settings: { analyzerPath: '/opt/codemap.dll', nodePath: '/opt/node' }, base: {}, onPath: onPath(['codemap']) });
  assert.deepEqual([set.command, set.args, set.env, set.pinned], ['dotnet', ['/opt/codemap.dll', 'mcp'], { CODEMAP_NODE: '/opt/node' }, false]);
});

test('executables are found on PATH, with the Windows extensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-path-'));
  fs.writeFileSync(path.join(dir, 'codemap'), '');
  fs.writeFileSync(path.join(dir, 'node.EXE'), '');
  assert.equal(findOnPath('codemap', { PATH: dir }, 'linux'), true);
  assert.equal(findOnPath('node', { PATH: dir }, 'linux'), false);
  assert.equal(findOnPath('node', { Path: dir, PATHEXT: '.COM;.EXE' }, 'win32'), true);
  assert.equal(findOnPath('codemap', { PATH: '' }, 'linux'), false);
});

test('mcp.json: CodeMap is added next to the other servers, in each editor\'s format', () => {
  const entry = configEntry({ command: 'codemap', args: ['mcp'], env: {} });
  assert.deepEqual(entry, { command: 'codemap', args: ['mcp'] });
  assert.deepEqual(configEntry({ command: 'codemap', args: ['mcp'], env: { A: '1' } }, { vscodeFormat: true }), { type: 'stdio', command: 'codemap', args: ['mcp'], env: { A: '1' } });

  assert.deepEqual(JSON.parse(mergeConfig('', entry).text), { mcpServers: { codemap: entry } });
  const merged = mergeConfig(JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: true }), entry);
  assert.deepEqual(JSON.parse(merged.text), { mcpServers: { other: { command: 'x' }, codemap: entry }, extra: true });
  assert.equal(merged.replaced, false);
  assert.equal(mergeConfig(merged.text, entry).replaced, true);
  assert.deepEqual(Object.keys(JSON.parse(mergeConfig('{"inputs":[]}', entry, { vscodeFormat: true }).text)), ['inputs', 'servers']);
  assert.equal(mergeConfig('{ // a comment\n "servers": {} }', entry, { vscodeFormat: true }), null, 'comments are not rewritten away');
  assert.equal(mergeConfig('[]', entry), null);
});

test('the Claude Code command line is quoted for the shell', () => {
  assert.equal(claudeCommand({ command: 'codemap', args: ['mcp'], env: {} }), 'claude mcp add codemap -- codemap mcp');
  assert.equal(
    claudeCommand({ command: 'dotnet', args: ['/Users/me/My Ext/codemap.dll', 'mcp'], env: { CODEMAP_NODE: "/it's/node" } }),
    `claude mcp add -e 'CODEMAP_NODE=/it'\\''s/node' codemap -- dotnet '/Users/me/My Ext/codemap.dll' mcp`,
  );
});

test('VS Code: the extension provides the server to agent mode, follows the settings and trust', async () => {
  const ext = bundledExtension();
  const mock = mcpMock();
  const { result } = activateWith(mock, ext);
  assert.equal(result.mcp, 'vscode');
  const [{ id, provider }] = mock.log.providers;
  assert.equal(id, 'codemap.mcp');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders.map((p) => p.id), [id]);
  assert.ok(manifest.activationEvents.includes(`onMcpServerDefinitionProvider:${id}`));

  const [server] = await provider.provideMcpServerDefinitions();
  assert.equal(server.label, 'CodeMap');
  assert.equal(server.command, 'dotnet');
  assert.deepEqual(server.args.slice(1), ['mcp', '--root', '/work/shop']);
  assert.equal(server.cwd.fsPath, '/work/shop');
  assert.equal(server.version, '9.9.9');

  let changes = 0;
  provider.onDidChangeMcpServerDefinitions(() => changes++);
  mock.changeSetting('codemap.nodePath');
  mock.changeSetting('codemap.renderer');
  assert.equal(changes, 1, 'only settings of the server');

  mock.vscode.workspace.isTrusted = false;
  assert.deepEqual(await provider.provideMcpServerDefinitions(), [], 'not in an untrusted workspace');
  mock.vscode.workspace.isTrusted = true;
  mock.grantTrust();
  assert.equal(changes, 2);
});

test('VS Code: the server can be turned off', async () => {
  const mock = mcpMock({ settings: { mcpServer: false } });
  activateWith(mock, bundledExtension());
  assert.deepEqual(await mock.log.providers[0].provider.provideMcpServerDefinitions(), []);
});

test('Cursor: the server is registered with Cursor\'s API, again when the settings change, and removed with the extension', () => {
  const mock = mcpMock({ cursor: true });
  const { result, context } = activateWith(mock, bundledExtension());
  assert.equal(result.mcp, 'cursor');
  assert.equal(mock.log.providers.length, 0, 'not twice');
  const [[verb, server]] = mock.log.cursor;
  assert.equal(verb, 'register');
  assert.equal(server.name, 'codemap');
  assert.equal(server.server.command, 'dotnet');
  assert.deepEqual(server.server.args.slice(1), ['mcp', '--root', '/work/shop']);
  assert.ok(Object.values(server.server.env).every((v) => typeof v === 'string'));

  mock.vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => (key === 'mcpServer' ? false : fallback) });
  mock.changeSetting('codemap.mcpServer');
  assert.deepEqual(mock.log.cursor.slice(1), [['unregister', 'codemap']]);

  mock.log.cursor.length = 0;
  for (const s of context.subscriptions) s.dispose?.();
  assert.deepEqual(mock.log.cursor, [], 'already unregistered');
});

test('Cursor: not in an untrusted workspace until it is trusted', () => {
  const mock = mcpMock({ cursor: true, vscodeApi: false });
  mock.vscode.workspace.isTrusted = false;
  activateWith(mock, bundledExtension());
  assert.deepEqual(mock.log.cursor, []);
  mock.vscode.workspace.isTrusted = true;
  mock.grantTrust();
  assert.equal(mock.log.cursor[0][0], 'register');
});

test('an editor without an MCP API still gets the commands', async () => {
  const mock = mcpMock({ vscodeApi: false });
  const { result } = activateWith(mock, bundledExtension());
  assert.equal(result.mcp, null);
  assert.ok(mock.log.commands.has('codemap.copyMcpConfig'));
  assert.ok(mock.log.commands.has('codemap.addMcpConfig'));

  await mock.log.commands.get('codemap.addMcpConfig')();
  const [saved] = mock.log.saved;
  assert.equal(saved.file, path.join('/work/shop', '.vscode', 'mcp.json'));
  const config = JSON.parse(saved.content);
  assert.equal(config.servers.codemap.type, 'stdio');
  assert.deepEqual(config.servers.codemap.args.slice(-3), ['mcp', '--root', '${workspaceFolder}']);
  assert.match(mock.log.infos.at(-1), /added the MCP server in \.vscode\/mcp\.json/);
});

test('Cursor: Add to Workspace writes .cursor/mcp.json, after asking when the server is already offered', async () => {
  const mock = mcpMock({ cursor: true });
  activateWith(mock, bundledExtension());
  const file = path.join('/work/shop', '.cursor', 'mcp.json');
  mock.log.existing = { [file]: JSON.stringify({ mcpServers: { other: { command: 'x' } } }) };

  mock.log.answer = () => undefined;
  await mock.log.commands.get('codemap.addMcpConfig')();
  assert.equal(mock.log.saved.length, 0, 'cancelled');

  mock.log.answer = (message, items) => (/already offers/.test(message) ? 'Add' : undefined);
  await mock.log.commands.get('codemap.addMcpConfig')();
  const config = JSON.parse(mock.log.saved[0].content);
  assert.deepEqual(Object.keys(config.mcpServers), ['other', 'codemap']);
  assert.equal(config.mcpServers.codemap.type, undefined);
});

test('Copy MCP Server Configuration puts the configuration on the clipboard', async () => {
  const mock = mcpMock();
  activateWith(mock, bundledExtension());
  await mock.log.commands.get('codemap.copyMcpConfig')();
  const copied = JSON.parse(mock.log.clipboard[0]);
  assert.deepEqual(copied.mcpServers.codemap.args.slice(-3), ['mcp', '--root', '/work/shop']);
});
