'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzerEnv } = require('../../src/analyzer');
const { serverLaunch, portableLaunch } = require('../../src/mcp');
const { PythonInterpreter, interpreterFrom } = require('../../src/python');

const runtime = { execPath: '/vscode/electron', electron: true };

test('Python runs on codemap.pythonPath, CODEMAP_PYTHON or the Python extension\'s interpreter, else the analyzer finds it', () => {
  assert.equal(analyzerEnv({ pythonPath: '/opt/py/bin/python', pythonInterpreter: '/repo/.venv/bin/python' }, { CODEMAP_PYTHON: '/old' }, runtime).CODEMAP_PYTHON, '/opt/py/bin/python');
  assert.equal(analyzerEnv({ pythonInterpreter: '/repo/.venv/bin/python' }, { CODEMAP_PYTHON: '/usr/bin/python3' }, runtime).CODEMAP_PYTHON, '/usr/bin/python3');
  assert.equal(analyzerEnv({ pythonInterpreter: '/repo/.venv/bin/python' }, {}, runtime).CODEMAP_PYTHON, '/repo/.venv/bin/python');
  assert.equal(analyzerEnv({}, {}, runtime).CODEMAP_PYTHON, undefined);
});

test('the MCP server gets the same Python; a configuration to keep only an explicit one', () => {
  const ext = '/ext';
  const launch = serverLaunch({ extensionPath: ext, settings: { pythonInterpreter: '/repo/.venv/bin/python' }, base: { PATH: '/bin' }, runtime });
  assert.equal(launch.env.CODEMAP_PYTHON, '/repo/.venv/bin/python');
  assert.equal(serverLaunch({ extensionPath: ext, settings: { pythonPath: '/opt/python' }, base: {}, runtime }).env.CODEMAP_PYTHON, '/opt/python');
  const kept = portableLaunch({ extensionPath: ext, settings: { pythonPath: '/opt/python' }, base: {}, runtime, onPath: () => true });
  assert.equal(kept.env.CODEMAP_PYTHON, '/opt/python');
  assert.equal(portableLaunch({ extensionPath: ext, base: {}, runtime, onPath: () => true }).env.CODEMAP_PYTHON, undefined);
});

function vscodeWith(extension) {
  return { extensions: { getExtension: (id) => (id === 'ms-python.python' ? extension : undefined) }, workspace: { workspaceFolders: [{ uri: { fsPath: '/repo' } }] } };
}

test('the Python extension\'s active environment, resolved to its executable', async () => {
  const folder = { fsPath: '/repo' };
  let listener = null;
  const api = {
    environments: {
      getActiveEnvironmentPath: (resource) => (resource === folder ? { id: 'venv', path: '/repo/.venv' } : undefined),
      resolveEnvironment: async (env) => (env.id === 'venv' ? { executable: { uri: { fsPath: '/repo/.venv/bin/python' } } } : undefined),
      onDidChangeActiveEnvironmentPath: (fn) => ((listener = fn), { dispose() {} }),
    },
  };
  const python = new PythonInterpreter(vscodeWith({ isActive: true, exports: api }));
  const seen = [];
  python.onDidChange((path) => seen.push(path));
  assert.equal(await python.current(folder), '/repo/.venv/bin/python');
  assert.equal(python.known, '/repo/.venv/bin/python');
  assert.deepEqual(seen, ['/repo/.venv/bin/python']);
  assert.equal(typeof listener, 'function'); // the user picking another interpreter refreshes it
});

test('older Python extensions, unresolved environments and missing or hanging extensions', async () => {
  assert.equal(await interpreterFrom({ settings: { getExecutionDetails: () => ({ execCommand: ['/usr/bin/python3.12'] }) } }, undefined, 100), '/usr/bin/python3.12');
  assert.equal(await interpreterFrom({ settings: { getExecutionDetails: () => ({ execCommand: ['conda', 'run', '-n', 'x', 'python'] }) } }, undefined, 100), undefined);
  assert.equal(await interpreterFrom({ environments: { getActiveEnvironmentPath: () => ({ path: '/usr/bin/python3' }), resolveEnvironment: async () => undefined } }, undefined, 100), '/usr/bin/python3');
  assert.equal(await new PythonInterpreter(vscodeWith(undefined)).current(), undefined);
  const hanging = new PythonInterpreter(vscodeWith({ isActive: false, activate: () => new Promise(() => {}) }), { timeout: 20 });
  assert.equal(await hanging.current(), undefined);
  const failing = new PythonInterpreter(vscodeWith({ isActive: false, activate: async () => { throw new Error('broken'); } }));
  assert.equal(await failing.current(), undefined);
});
