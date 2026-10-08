'use strict';

// Puts what the extension ships next to its code:
//   media/viewer.html – the built 3D viewer (from src/CodeMap.Cli/Assets, run `npm run build` in /viewer after changing it)
//   analyzer/         – the codemap analyzer, framework-dependent: one copy for every OS, runs on the installed .NET
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const extension = path.resolve(__dirname, '..');
const repository = path.resolve(extension, '..');
const { version } = require(path.join(extension, 'package.json'));

fs.mkdirSync(path.join(extension, 'media'), { recursive: true });
fs.copyFileSync(path.join(repository, 'src', 'CodeMap.Cli', 'Assets', 'viewer.html'), path.join(extension, 'media', 'viewer.html'));

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

const size = fs.readdirSync(analyzer).reduce((sum, f) => sum + fs.statSync(path.join(analyzer, f)).size, 0);
console.log(`viewer.html and analyzer (${(size / 1024 / 1024).toFixed(1)} MB) are ready.`);
