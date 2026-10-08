'use strict';

// Starts a real VS Code with the extension and the Shop sample, and runs suite.js inside it.
// Needs the bundled analyzer (`npm run prepare-assets`) and, on Linux without a display, xvfb-run.
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const workspace = path.resolve(extensionDevelopmentPath, '..', 'samples', 'Shop');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    });
  } catch (error) {
    console.error('Integration tests failed:', error);
    process.exit(1);
  }
}

main();
