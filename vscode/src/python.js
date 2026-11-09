'use strict';

/** The id of Microsoft's Python extension, whose interpreter (and so virtual environment) CodeMap prefers. */
const PYTHON_EXTENSION = 'ms-python.python';

/**
 * The Python the analyzer runs the Python plugin on, when the Python extension is installed: the interpreter it has
 * chosen for the workspace, so the project's virtual environment. Without that extension the analyzer finds Python on
 * the PATH itself. `known` is the last one found (the MCP server's launch needs it at once); `onDidChange` fires when
 * the user picks another interpreter.
 */
class PythonInterpreter {
  constructor(vscode, { timeout = 5000 } = {}) {
    this.vscode = vscode;
    this.timeout = timeout;
    this.known = undefined;
    this.listeners = [];
    this.watching = false;
  }

  /** The interpreter for a folder (a Uri), or undefined; never throws, and gives up after `timeout` ms. */
  async current(folder) {
    const extension = this.vscode.extensions?.getExtension?.(PYTHON_EXTENSION);
    if (!extension) return undefined;
    try {
      const api = extension.isActive ? extension.exports : await withTimeout(extension.activate(), this.timeout);
      this.watch(api);
      const found = await interpreterFrom(api, folder, this.timeout);
      if (found !== this.known) {
        this.known = found;
        for (const listener of this.listeners) listener(found);
      }

      return found;
    } catch {
      return undefined;
    }
  }

  onDidChange(listener) {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  }

  /** Follows the interpreter the user picks (the Python extension's event), once. */
  watch(api) {
    const event = api?.environments?.onDidChangeActiveEnvironmentPath;
    if (this.watching || typeof event !== 'function') return;
    this.watching = true;
    event(() => this.current(this.vscode.workspace?.workspaceFolders?.[0]?.uri));
  }
}

/** The executable of the active environment (Python extension API), or of the older execution details API. */
async function interpreterFrom(api, folder, timeout) {
  const environments = api?.environments;
  if (typeof environments?.getActiveEnvironmentPath === 'function') {
    const active = environments.getActiveEnvironmentPath(folder);
    if (!active) return undefined;
    if (typeof environments.resolveEnvironment === 'function') {
      const resolved = await withTimeout(environments.resolveEnvironment(active), timeout);
      const executable = resolved?.executable?.uri?.fsPath;
      if (executable) return executable;
    }

    return active.path || undefined;
  }

  const command = api?.settings?.getExecutionDetails?.(folder)?.execCommand;
  return Array.isArray(command) && command.length === 1 ? command[0] : undefined; // ['conda', 'run', …] is no executable
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms))),
  ]);
}

module.exports = { PYTHON_EXTENSION, PythonInterpreter, interpreterFrom };
