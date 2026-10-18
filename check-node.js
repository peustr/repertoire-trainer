// @ts-check
// Stops with a plain message when Node.js is older than package.json's "engines"
// asks for, instead of failing later with a cryptic error. start.bat runs it before
// installing anything, and server.js requires it first.
// Keep this file in syntax that very old Node versions can still parse.

'use strict';

/** True when `version` (e.g. "20.19.0") is below `wanted` (e.g. ">=22.12"). */
function tooOld(version, wanted) {
  const need = String(wanted).replace(/^>=\s*/, '').split('.').map(Number);
  const have = String(version).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = have[i] || 0;
    const b = need[i] || 0;
    if (a !== b) return a < b;
  }
  return false;
}

module.exports = { tooOld };

const wanted = require('./package.json').engines.node;
if (tooOld(process.versions.node, wanted)) {
  console.error('');
  console.error('  Repertoire Trainer needs Node.js ' + wanted.replace(/^>=\s*/, '') + ' or newer. This computer has ' + process.version + '.');
  console.error('  Install the LTS version from https://nodejs.org, then start the trainer again.');
  console.error('');
  process.exit(1);
}
