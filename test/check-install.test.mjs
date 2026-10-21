// Installing the dependencies: start.bat asks check-install.cjs whether node_modules
// matches package-lock.json, and installs with npm ci when it does not. The versions it
// installs are the ones package.json pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsInstall, markInstalled } from '../check-install.cjs';

const SCRIPT = fileURLToPath(new URL('../check-install.cjs', import.meta.url));
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** An app folder with a lockfile, removed after the test. */
function appFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3, "packages": {"node_modules/ws": {"version": "8.22.0"}}}');
  return dir;
}

test('an install is needed until one from this lockfile has finished', (t) => {
  const dir = appFolder(t);
  assert.equal(needsInstall(dir), true, 'first run: no node_modules');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.equal(needsInstall(dir), true, 'installed some other way');
  markInstalled(dir);
  assert.equal(needsInstall(dir), false);
});

test('an update that changes the lockfile asks for a new install', (t) => {
  const dir = appFolder(t);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  markInstalled(dir);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3, "packages": {"node_modules/ws": {"version": "8.23.0"}}}');
  assert.equal(needsInstall(dir), true);
});

test('start.bat reads the answer from the exit code and records a finished install', (t) => {
  const dir = appFolder(t);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run().status, 1, 'install needed');
  assert.equal(run('--done').status, 0);
  assert.equal(run().status, 0, 'up to date');
});

test('start.bat checks before every start and installs with npm ci', () => {
  const bat = read('start.bat');
  const order = ['node check-node.cjs', 'node check-install.cjs', 'call npm ci', 'node check-install.cjs --done', 'node server.js'];
  const at = order.map((step) => bat.indexOf(step));
  assert.ok(at.every((i) => i >= 0), `start.bat runs ${order.join(', ')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  assert.doesNotMatch(bat, /npm install/, 'npm install could rewrite the lockfile');
  assert.match(read('check-install.cjs'), /^'use strict';$/m, 'CommonJS, like check-node.cjs');
});

test('every dependency is pinned, and the lockfile installs exactly those versions', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned`);
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `${name} in package-lock.json`);
  }
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'the lockfile was made from this package.json');
});
