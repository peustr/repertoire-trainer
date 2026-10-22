// The settings schema (settings-schema.js): every field's label and default, defaults
// sized for the computer, how each kind of field cleans what the Settings page sends,
// which fields restart Stockfish, and the mistake finder's options.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as schema from '../settings-schema.js';
import * as puzzles from '../puzzles.js';

const GB = 2 ** 30;
const cpus = (n) => Array.from({ length: n }, () => /** @type {os.CpuInfo} */ ({}));

test('defaults, clamping and bad values; every field has a label and a default', () => {
  const d = schema.defaults();
  assert.equal(d.reviewBatch, 20);
  assert.equal(d.srsIntervals.length, 8);
  const v = schema.validate(d, {
    reviewBatch: '999', theme: 'purple', lichessRatings: '1600,abc,2500', lichessSince: '2024-13',
    srsIntervals: [1, 2, 3], puzzleMinShare: 2.5, engineBuild: 'native', analysisHash: 4, unknownKey: 1,
  });
  assert.equal(v.reviewBatch, 200);
  assert.equal(v.theme, 'light');
  assert.equal(v.lichessRatings, '1600,2500');
  assert.equal(v.lichessSince, '');
  assert.deepEqual(v.srsIntervals, d.srsIntervals);
  assert.equal(v.puzzleMinShare, 2.5);
  assert.equal(v.engineBuild, 'native');
  assert.equal(v.analysisHash, 16);
  assert.equal(v.unknownKey, undefined);
  const sections = schema.buildSchema();
  for (const sec of sections) for (const f of sec.fields) {
    assert.ok(f.label && f.label.length > 3, `${f.key} needs a label`);
    assert.ok(f.default !== undefined, `${f.key} needs a default`);
  }
  assert.ok(schema.ENGINE_KEYS.includes('analysisHash'));
});

test('the Settings page names each rating group', () => {
  const ratingField = schema.buildSchema().flatMap((s) => s.fields).find((f) => f.key === 'lichessRatings');
  assert.deepEqual(ratingField.options[4], ['1600', '1600–1799']);
});

test('sparring and drill settings take effect without restarting Stockfish', () => {
  const sparring = schema.buildSchema().find((s) => s.id === 'sparring');
  assert.deepEqual(sparring.fields.map((f) => f.key), ['sparOpponent', 'sparElo', 'sparMoveTime', 'playOutMoves', 'playOutTolerance', 'surpriseBatch', 'surpriseMinShare', 'surpriseTolerance']);
  assert.ok(!sparring.fields.some((f) => f.restart));
});

test("the mistake finder's options come from the settings", () => {
  const options = schema.finderOptions(schema.defaults());
  assert.deepEqual(Object.keys(options).sort(), [
    'beyondBook', 'cacheDays', 'candidates', 'depth', 'gapShare', 'maxLength', 'maxOppDepth', 'maxPositions', 'maxPuzzles',
    'minAdvantage', 'minGames', 'minShare', 'ratings', 'since', 'solveDepth', 'speeds', 'threshold', 'uniqueGap',
  ]);
  assert.equal(options.minShare, 0.05, 'percentages become fractions');
  assert.equal(options.gapShare, 0.1);
  assert.equal(options.threshold, 150);
  assert.deepEqual(puzzles.DEFAULTS, options);
  const custom = schema.finderOptions(schema.validate(schema.defaults(), { puzzleThreshold: 220, lichessSince: '2024-01' }));
  assert.equal(custom.threshold, 220);
  assert.equal(custom.since, '2024-01');
});

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

test('reading the settings does not rebuild the schema each time', (t) => {
  const cpus = t.mock.method(os, 'cpus');
  for (let i = 0; i < 3; i++) {
    schema.validate(schema.defaults(), { reviewBatch: 30 });
    schema.finderOptions(schema.defaults());
  }
  assert.equal(cpus.mock.callCount(), 0, 'the fields were built once, when the module loaded');
  assert.equal(schema.buildSchema().length, 7, 'the Settings page still gets the whole schema');
  assert.ok(cpus.mock.callCount() > 0, 'built afresh for it');
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

test('no patch leaves the settings as they are', () => {
  const d = schema.defaults();
  assert.deepEqual(schema.validate(d, null), d);
  assert.deepEqual(schema.validate(d, undefined), d);
});
