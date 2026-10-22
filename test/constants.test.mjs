// Chess and Lichess constants (public/js/constants.js): scores in centipawns and the
// names of the explorer's rating groups.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratingGroupLabel, scoreToCp } from '../public/js/constants.js';

test('scores in centipawns: a missing score is level, mates are large, and mate 0 is level', () => {
  assert.equal(scoreToCp(null), 0);
  assert.equal(scoreToCp(undefined), 0);
  assert.equal(scoreToCp({ cp: -35 }), -35);
  assert.equal(scoreToCp({ mate: 1 }), 9990);
  assert.equal(scoreToCp({ mate: -3 }), -9970);
  assert.equal(scoreToCp({ mate: 0 }), 0);
});

test('a rating group is named by its range', () => {
  assert.deepEqual([0, 1000, 2500].map(ratingGroupLabel), ['Under 1000', '1000–1199', '2500+']);
});
