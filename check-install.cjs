// Tells start.bat whether to install the dependencies: on the first run, and after an
// update that changed package-lock.json, when node_modules would otherwise be stale. A
// finished install is recorded in node_modules with the lockfile's hash, so the next
// start can tell. A node_modules installed some other way has no record and is
// installed once more. start.bat runs this from the app folder, after check-node.cjs.
//
//   node check-install.cjs          exits with 1 when an install is needed, 0 when not
//   node check-install.cjs --done   records that the install has just finished

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RECORD = path.join('node_modules', '.repertoire-trainer-install');

function lockHash(dir) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');
}

/** True unless start.bat installed node_modules from this very package-lock.json. */
function needsInstall(dir) {
  try {
    return fs.readFileSync(path.join(dir, RECORD), 'utf8').trim() !== lockHash(dir);
  } catch (err) {
    return true; // no record: never installed, or not by start.bat
  }
}

function markInstalled(dir) {
  fs.writeFileSync(path.join(dir, RECORD), `${lockHash(dir)}\n`);
}

module.exports = { needsInstall, markInstalled };

if (require.main === module) {
  if (process.argv.includes('--done')) markInstalled(process.cwd());
  else process.exitCode = needsInstall(process.cwd()) ? 1 : 0;
}
