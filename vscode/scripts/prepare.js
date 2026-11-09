'use strict';

// Puts what the extension ships next to its code:
//   LICENSE           – the repository's license
//   media/viewer.html – the built 3D viewer (from src/CodeMap.Cli/Assets, run `npm run build` in /viewer after changing it)
//   analyzer/         – the codemap analyzer, framework-dependent: one copy for every OS, runs on the installed .NET,
//                       with the TypeScript / JavaScript plugin in analyzer/plugins/typescript (runs on VS Code's Node.js)
//                       and the Python plugin in analyzer/plugins/python (runs on the Python the workspace uses)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const extension = path.resolve(__dirname, '..');
const repository = path.resolve(extension, '..');
const { version } = require(path.join(extension, 'package.json'));

fs.mkdirSync(path.join(extension, 'media'), { recursive: true });
fs.copyFileSync(path.join(repository, 'src', 'CodeMap.Cli', 'Assets', 'viewer.html'), path.join(extension, 'media', 'viewer.html'));
// The repository's license goes into the package too (vsce looks for it next to package.json).
fs.copyFileSync(path.join(repository, 'LICENSE'), path.join(extension, 'LICENSE'));

// The TypeScript plugin is published with the analyzer once its compiler is installed (see CodeMap.Cli.csproj).
const plugin = path.join(repository, 'analyzers', 'typescript');
if (!fs.existsSync(path.join(plugin, 'node_modules', 'typescript', 'lib', 'typescript.js'))) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: plugin, stdio: 'inherit', shell: process.platform === 'win32' });
}

const analyzer = path.join(extension, 'analyzer');
fs.rmSync(analyzer, { recursive: true, force: true });
execFileSync('dotnet', [
  'publish', path.join(repository, 'src', 'CodeMap.Cli'),
  '-c', 'Release',
  '-o', analyzer,
  `-p:Version=${version}`,
  '-p:UseAppHost=false',
  '-p:DebugType=none',
  '-p:SatelliteResourceLanguages=en',
  '--nologo',
], { stdio: 'inherit' });

if (!fs.existsSync(path.join(analyzer, 'plugins', 'typescript', 'codemap-plugin.json'))) {
  throw new Error('The TypeScript plugin is missing from analyzer/plugins/typescript.');
}
if (!fs.existsSync(path.join(analyzer, 'plugins', 'python', 'src', 'cli.py'))) {
  throw new Error('The Python plugin is missing from analyzer/plugins/python.');
}

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((sum, f) => sum + (f.isDirectory() ? size(path.join(dir, f.name)) : fs.statSync(path.join(dir, f.name)).size), 0);
console.log(`viewer.html and analyzer (${(size(analyzer) / 1024 / 1024).toFixed(1)} MB, with the TypeScript and Python plugins) are ready.`);
