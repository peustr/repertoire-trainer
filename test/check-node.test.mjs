// The startup check that turns a too-old Node.js into a plain message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tooOld } from '../check-node.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('versions below the minimum are too old', () => {
  for (const v of ['18.20.4', '20.19.0', '22.11.9', 'v22.0.0']) assert.equal(tooOld(v, '>=22.12'), true, v);
  for (const v of ['22.12.0', '22.13.1', '24.0.0', 'v26.8.1']) assert.equal(tooOld(v, '>=22.12'), false, v);
});

test('the Node.js running the tests passes the check', () => {
  const run = spawnSync(process.execPath, ['check-node.cjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('a Node.js that is too old gets a plain message and nothing else', () => {
  const oldNode = fileURLToPath(new URL('./fixtures/old-node.cjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--require', oldNode, 'check-node.cjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1);
  const wanted = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node.replace(/^>=\s*/, '');
  assert.match(run.stderr, new RegExp(`Repertoire Trainer needs Node\\.js ${wanted.replace('.', '\\.')} or newer\\. This computer has v18\\.20\\.4\\.`));
  assert.match(run.stderr, /Install the LTS version from https:\/\/nodejs\.org/);
});

test('CI tests exactly the oldest Node.js that package.json accepts', () => {
  const wanted = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node.replace(/^>=\s*/, '');
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const versions = ci.match(/node: \[([^\]]+)\]/)[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  const lowest = versions.reduce((a, b) => (tooOld(b, `>=${a}`) ? b : a));
  assert.equal(lowest, wanted, 'a bare major ("22") would test the newest 22.x, not the oldest one users may have');
});

test('the check is still CommonJS, so an old Node.js can run it', () => {
  const src = fs.readFileSync(new URL('../check-node.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
  assert.match(fs.readFileSync(new URL('../start.bat', import.meta.url), 'utf8'), /node check-node\.cjs/);
});
