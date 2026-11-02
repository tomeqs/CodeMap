'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

/**
 * How to start the analyzer: a path from the settings (an executable or codemap.dll), the copy bundled
 * with the extension (runs on the installed .NET), or `codemap` on PATH (dotnet tool / standalone exe).
 */
function resolveAnalyzer({ extensionPath, analyzerPath, dotnetPath }) {
  const dotnet = dotnetPath || 'dotnet';
  if (analyzerPath) {
    return analyzerPath.toLowerCase().endsWith('.dll')
      ? { command: dotnet, args: [analyzerPath], label: analyzerPath, needsDotnet: true }
      : { command: analyzerPath, args: [], label: analyzerPath, needsDotnet: false };
  }

  const bundled = path.join(extensionPath, 'analyzer', 'codemap.dll');
  if (fs.existsSync(bundled)) return { command: dotnet, args: [bundled], label: 'bundled analyzer', needsDotnet: true };
  return { command: 'codemap', args: [], label: 'codemap on PATH', needsDotnet: false };
}

/**
 * The analyzer's environment. TypeScript / JavaScript run on Node.js: `codemap.nodePath`, else CODEMAP_NODE
 * from the environment, else the Node.js inside VS Code itself (Electron run as Node), so nothing has to be installed.
 */
function analyzerEnv({ nodePath } = {}, base = process.env, runtime = { execPath: process.execPath, electron: !!process.versions.electron }) {
  const env = { ...base, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  if (nodePath) {
    env.CODEMAP_NODE = nodePath;
  } else if (!env.CODEMAP_NODE) {
    env.CODEMAP_NODE = runtime.execPath;
    if (runtime.electron) env.ELECTRON_RUN_AS_NODE = '1';
  }

  return env;
}

function analyzerArgs(target, outDir, { includeTests = true, includeExternal = false, gitHistory = true } = {}) {
  const args = [target, '-o', outDir, '-f', 'json', '--name', 'map'];
  if (!includeTests) args.push('--no-tests');
  if (includeExternal) args.push('--external');
  if (!gitHistory) args.push('--no-git');
  return args;
}

/**
 * Analyzes a solution, project or folder and returns the graph (codemap JSON).
 * `onLine` receives the analyzer's output line by line (progress); aborting `signal` stops it.
 */
function runAnalyzer(analyzer, target, options, { onLine, signal, cwd } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-'));
  const cleanup = () => fs.rmSync(outDir, { recursive: true, force: true });
  const args = [...analyzer.args, ...analyzerArgs(target, outDir, options)];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(analyzer.command, args, {
        cwd,
        windowsHide: true,
        env: analyzerEnv(options),
      });
    } catch (error) {
      cleanup();
      reject(explain(error, analyzer));
      return;
    }

    const output = [];
    let partial = '';
    const onData = (chunk) => {
      const lines = (partial + chunk.toString()).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        output.push(line);
        onLine?.(line);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort);
    let failed = false;
    child.on('error', (error) => {
      failed = true;
      cleanup();
      reject(explain(error, analyzer));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (failed) return;
      try {
        if (partial.trim()) output.push(partial);
        if (signal?.aborted) throw new CancelledError();
        if (code !== 0) throw new Error(`The analyzer stopped with exit code ${code}.\n${output.slice(-15).join('\n')}`);
        resolve(JSON.parse(fs.readFileSync(path.join(outDir, 'map.codemap.json'), 'utf8')));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    });
  });
}

/** A missing `dotnet` / `codemap` gets a message that says what to install. */
function explain(error, analyzer) {
  if (error?.code !== 'ENOENT') return error;
  const message = analyzer.needsDotnet
    ? `CodeMap could not start "${analyzer.command}". It needs the .NET SDK 8 or newer (https://dot.net). ` +
      'Alternatively set "codemap.analyzerPath" to the standalone codemap executable from https://github.com/tomeqs/CodeMap/releases.'
    : `CodeMap could not start "${analyzer.command}". Check the "codemap.analyzerPath" setting or install the codemap tool.`;
  return Object.assign(new Error(message), { code: 'ENOENT' });
}

module.exports = { CancelledError, analyzerArgs, analyzerEnv, resolveAnalyzer, runAnalyzer };
