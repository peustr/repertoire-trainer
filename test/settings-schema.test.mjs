// The settings schema (settings-schema.js): defaults sized for the computer, and how each
// kind of field cleans what the Settings page sends. The basics are in core.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as schema from '../settings-schema.js';

const GB = 2 ** 30;
const cpus = (n) => Array.from({ length: n }, () => /** @type {os.CpuInfo} */ ({}));

test('engine defaults are sized for a small computer', (t) => {
  t.mock.method(os, 'cpus', () => []);
  t.mock.method(os, 'totalmem', () => 4 * GB);
  assert.deepEqual(schema.machine(), { cores: 1, memGB: 4 });
  assert.deepEqual(schema.engineDefaults(), { analysisThreads: 1, analysisHash: 128, taskThreads: 1, taskHash: 64 });
});

test('engine defaults are sized for a large computer', (t) => {
  t.mock.method(os, 'cpus', () => cpus(16));
  t.mock.method(os, 'totalmem', () => 32 * GB);
  assert.deepEqual(schema.machine(), { cores: 16, memGB: 32 });
  assert.deepEqual(schema.engineDefaults(), { analysisThreads: 4, analysisHash: 256, taskThreads: 2, taskHash: 64 });
});

test('values that cannot be used keep the current setting', () => {
  const d = schema.defaults();
  const v = schema.validate(d, {
    reviewBatch: 'lots', enginePath: 42, lichessSpeeds: 'none,of,these', lichessRatings: null,
    srsIntervals: [4, 24, 72, 168, 336, 720, 2160, -1],
  });
  assert.equal(v.reviewBatch, d.reviewBatch);
  assert.equal(v.enginePath, d.enginePath);
  assert.equal(v.lichessSpeeds, d.lichessSpeeds);
  assert.equal(v.lichessRatings, d.lichessRatings);
  assert.deepEqual(v.srsIntervals, d.srsIntervals);
  assert.deepEqual(schema.validate(d, { srsIntervals: [1, 2, 3, 4, 5, 6, 7, 'x'] }).srsIntervals, d.srsIntervals);
});

test('chips can be sent as a list, and repeats count once', () => {
  const v = schema.validate(schema.defaults(), { lichessSpeeds: ['blitz', ' rapid ', 'blitz', 'nonsense'] });
  assert.equal(v.lichessSpeeds, 'blitz,rapid');
});

test('text is trimmed and kept to 500 characters', () => {
  assert.equal(schema.validate(schema.defaults(), { enginePath: '  C:\\stockfish.exe  ' }).enginePath, 'C:\\stockfish.exe');
  assert.equal(schema.validate(schema.defaults(), { enginePath: 'x'.repeat(600) }).enginePath.length, 500);
});

test('a field of a type the schema does not know is never saved', () => {
  assert.equal(schema.clean({ type: 'colour' }, '#fff'), undefined);
});

test('no patch leaves the settings as they are', () => {
  const d = schema.defaults();
  assert.deepEqual(schema.validate(d, null), d);
  assert.deepEqual(schema.validate(d, undefined), d);
});
