// The startup check that turns a too-old Node.js into a plain message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const { tooOld } = require('../check-node.js');

test('versions below the minimum are too old', () => {
  for (const v of ['18.20.4', '20.19.0', '22.11.9', 'v22.0.0']) assert.equal(tooOld(v, '>=22.12'), true, v);
  for (const v of ['22.12.0', '22.13.1', '24.0.0', 'v26.8.1']) assert.equal(tooOld(v, '>=22.12'), false, v);
});

test('the Node.js running the tests passes the check', () => {
  const run = spawnSync(process.execPath, ['check-node.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('package.json and the CI matrix agree on the minimum', () => {
  const fs = require('node:fs');
  const wanted = require('../package.json').engines.node;
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const lowest = Math.min(...ci.match(/node: \[([^\]]+)\]/)[1].split(',').map(Number));
  assert.equal(String(lowest), wanted.replace(/^>=\s*/, '').split('.')[0], 'test the oldest supported major in CI');
});
