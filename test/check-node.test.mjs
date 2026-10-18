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

test('package.json and the CI matrix agree on the minimum', () => {
  const wanted = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node;
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const lowest = Math.min(...ci.match(/node: \[([^\]]+)\]/)[1].split(',').map(Number));
  assert.equal(String(lowest), wanted.replace(/^>=\s*/, '').split('.')[0], 'test the oldest supported major in CI');
});

test('the check is still CommonJS, so an old Node.js can run it', () => {
  const src = fs.readFileSync(new URL('../check-node.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
  assert.match(fs.readFileSync(new URL('../start.bat', import.meta.url), 'utf8'), /node check-node\.cjs/);
});
