// Edge case: CommonJS. `pkg` and `path` are require() variables: the code below reads them, so they are used.
const pkg = require('../package.json');
const path = require('node:path');

console.log(`${pkg.name} ${pkg.version} (${path.basename(path.resolve(__dirname, '..'))})`);
