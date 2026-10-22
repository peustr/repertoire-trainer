// Puzzle and explorer helpers (public/js/puzzle-utils.js): the puzzle queue and counts,
// the wording of numbers and filters, and the chapter a puzzle becomes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  puzzleList, puzzleState, puzzleQueue, puzzleStats, formatGames, formatShare, describeRatings,
  describeSpeeds, describeReach, cpFor, puzzleToPgn,
} from '../public/js/puzzle-utils.js';
import { parsePgn } from '../public/js/pgn.js';
import { buildRepertoire } from '../public/js/repertoire.js';
import { START_FEN } from '../public/js/constants.js';

const now = 1_000_000_000_000;

test('a repertoire without puzzles or progress has none to show', () => {
  assert.deepEqual(puzzleList({}), []);
  assert.equal(puzzleState({}, { id: 'a' }), null);
  assert.deepEqual(puzzleQueue({}), []);
  assert.deepEqual(puzzleStats({}), { total: 0, due: 0, fresh: 0, ready: 0 });
});

test('the queue holds due puzzles first, then new ones by likelihood', () => {
  const rep = {
    puzzles: { a: { id: 'a', reach: 0.1 }, b: { id: 'b', reach: 0.5 }, c: { id: 'c', reach: 0.9 }, d: { id: 'd', reach: 0.9 } },
    cards: { 'pz|a': { level: 2, due: now - 10 }, 'pz|c': { level: 1, due: now + 1000 } },
  };
  assert.deepEqual(puzzleQueue(rep, { now }).map((p) => p.id), ['a', 'd', 'b']);
});

test('the queue can be limited to chosen puzzles, and puzzles without a reach come last', () => {
  const rep = { puzzles: { a: { id: 'a' }, b: { id: 'b', reach: 0.2 }, c: { id: 'c' }, d: { id: 'd', reach: 0.4 } } };
  assert.deepEqual(puzzleQueue(rep, { only: ['a', 'b', 'c'] }).map((p) => p.id), ['b', 'a', 'c']);
  assert.deepEqual(puzzleQueue(rep, { limit: 2 }).map((p) => p.id), ['d', 'b']);
});

test('puzzle counts: new, due, and ready (both together)', () => {
  const rep = {
    puzzles: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' } },
    cards: { 'pz|b': { level: 1, due: now - 1 }, 'pz|c': { level: 3, due: now + 1 } },
  };
  assert.deepEqual(puzzleStats(rep, now), { total: 4, due: 1, fresh: 2, ready: 3 });
});

test('game counts are shortened to thousands and millions', () => {
  assert.equal(formatGames(null), '—');
  assert.equal(formatGames(undefined), '—');
  assert.equal(formatGames(0), '0');
  assert.equal(formatGames(999), '999');
  assert.equal(formatGames(1234), '1.2k');
  assert.equal(formatGames(12345), '12k');
  assert.equal(formatGames(1234567), '1.2M');
  assert.equal(formatGames(12345678), '12M');
});

test('shares read as percentages, with a decimal below 10%', () => {
  assert.equal(formatShare(null), '—');
  assert.equal(formatShare(0.123), '12%');
  assert.equal(formatShare(0.034), '3.4%');
});

test('rating filters read as a range, from a list or the saved text', () => {
  assert.equal(describeRatings('1600,1800'), '1600–1999');
  assert.equal(describeRatings([2200, 2500]), '2200+');
  assert.equal(describeRatings([1500, 1600]), '1600–1799', 'values that are not explorer groups are ignored');
  assert.equal(describeRatings(''), 'all ratings');
  assert.equal(describeRatings(null), 'all ratings');
  assert.equal(describeRatings([]), 'all ratings');
});

test('speed filters read as words', () => {
  assert.equal(describeSpeeds('blitz,rapid'), 'blitz, rapid');
  assert.equal(describeSpeeds(['ultraBullet', 'custom']), 'ultrabullet, custom');
  assert.equal(describeSpeeds(null), 'all speeds');
  assert.equal(describeSpeeds([]), 'all speeds');
});

test('how often a position comes up', () => {
  assert.equal(describeReach(0), null);
  assert.equal(describeReach(undefined), null);
  assert.equal(describeReach(0.5), 'in most of your games from here');
  assert.equal(describeReach(1 / 12), 'about 1 in 12 games from here');
});

test('scores are turned to your side', () => {
  assert.equal(cpFor({ cp: 80 }, 'w'), 80);
  assert.equal(cpFor({ cp: 80 }, 'b'), -80);
  assert.equal(cpFor({ mate: -2 }, 'b'), 9980);
  assert.equal(cpFor(null, 'b'), -0);
});

const PUZZLE = {
  lineMoves: ['e2e4', 'e7e5', 'g1f3', 'f7f6'],
  solution: ['f3e5', 'f6e5', 'd1h5'],
  pathSan: ['e4', 'e5', 'Nf3', 'f6'],
  mistake: { san: 'f6', share: 0.02, positionGames: 800 },
};

test('a puzzle without a title, theme or better move still makes a readable chapter', () => {
  const pgn = puzzleToPgn(PUZZLE);
  assert.match(pgn, /\[Event "Punish f6"\]/);
  assert.match(pgn, /\[ChapterName "Opponent mistake: f6"\]/);
  assert.doesNotMatch(pgn, /SetUp|Better was/);
  assert.match(pgn, /2\.0% of 800 Lichess games \(all ratings\)\. }/);
  assert.match(pgn, /\$1 \{ Punish it\. \}/);
  const [g] = parsePgn(pgn);
  assert.deepEqual(g.errors, []);
  assert.equal(g.moves, 7);
});

test('a puzzle from a set-up position keeps it, and stops at a move that is not legal', () => {
  const startFen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  const pgn = puzzleToPgn({
    startFen,
    lineMoves: ['f1c4', 'g8f6'],
    solution: ['f3g5', 'e1e8', 'd2d3'],
    pathSan: ['Bc4', 'Nf6'],
    mistake: { san: 'Nf6', share: 0.5, positionGames: 20000, bestMoveBeforeSan: 'Bc5' },
    theme: { label: 'Wins material' },
  }, { title: 'The "Fried Liver"' });
  assert.match(pgn, /\[Event "The 'Fried Liver'"\]/, 'quotes cannot break the header');
  assert.match(pgn, /\[SetUp "1"\]\n\[FEN "r1bqkbnr/);
  assert.match(pgn, /Better was Bc5\. }/);
  assert.match(pgn, /\n3\. Bc4 Nf6 \$2 .* 4\. Ng5 \$1 \{ Wins material\. \} \*/);
  assert.doesNotMatch(pgn, /d3/, 'nothing after the illegal move');
});

test('a puzzle’s chapter reads back with its comments and glyphs', () => {
  const p = {
    startFen: START_FEN,
    lineMoves: ['e2e4', 'e7e5', 'g1f3', 'd7d6', 'f1c4', 'c8g4', 'b1c3', 'g7g6'],
    solution: ['f3e5', 'g4d1', 'c4f7', 'e8e7', 'c3d5'],
    pathSan: ['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6'],
    mistake: { san: 'g6', share: 0.12, positionGames: 5400, bestMoveBeforeSan: 'Nf6' },
    filters: { ratings: [1600, 1800] },
    theme: { label: 'Mate in 2' },
  };
  const pgn = puzzleToPgn(p, { title: 'Punishing 4...g6' });
  const model = buildRepertoire({ pgn, color: 'white' });
  assert.deepEqual(model.errors, []);
  assert.equal(model.lines.length, 1);
  const nodes = model.lines[0].nodes;
  assert.equal(nodes.length, 13);
  assert.ok(nodes[7].nags.includes(2), 'mistake marked ?');
  assert.ok(nodes[8].nags.includes(1), 'answer marked !');
  assert.match(nodes[7].comment, /12% of 5.4k/);
  assert.equal(model.chapters[0].name, 'Punishing 4...g6');
});
