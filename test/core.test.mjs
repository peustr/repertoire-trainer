// @ts-check
// The PGN parser, lines and cards, the scheduler, puzzle helpers and the settings schema.
// Run with:  npm test  (or: node --test test/core.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePgn, tokenize, parseComment, formatSequence } from '../public/js/pgn.js';
import { buildRepertoire } from '../public/js/repertoire.js';
import * as srs from '../public/js/srs.js';
import { puzzleToPgn, describeRatings, describeSpeeds, puzzleQueue } from '../public/js/puzzle-utils.js';
import { START_FEN, ratingGroupLabel } from '../public/js/constants.js';
import * as puzzles from '../puzzles.js';
import * as lichess from '../lichess.js';
import * as schema from '../settings-schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('tokenizer handles numbers, NAGs, castling with zeros and results', () => {
  const t = tokenize('1.e4!? e5 2. Nf3 $1 Nc6 3... 0-0 {x} ; rest\n 1/2-1/2');
  assert.deepEqual(t.map((x) => x.t), ['san', 'nag', 'san', 'san', 'nag', 'san', 'san', 'comment', 'comment', 'result']);
  assert.equal(t[6].text, 'O-O');
});

test('variations branch from the move before them', () => {
  const [g] = parsePgn('1. e4 e5 (1... c5 2. Nf3) (1... e6) 2. Nf3 *');
  assert.equal(g.errors.length, 0);
  const e4 = g.root.children[0];
  assert.deepEqual(e4.children.map((c) => c.san), ['e5', 'c5', 'e6']);
  assert.equal(e4.children[1].children[0].san, 'Nf3');
});

test('nested variations and pre-comments', () => {
  const [g] = parsePgn('1. e4 e5 2. Nf3 (2. Bc4 Nf6 (2... Bc5 {classical}) 3. d3) ({pre} 2. f4 exf4) 2... Nc6 *');
  assert.equal(g.errors.length, 0);
  const e5 = g.root.children[0].children[0];
  assert.deepEqual(e5.children.map((c) => c.san), ['Nf3', 'Bc4', 'f4']);
  const bc4 = e5.children[1];
  assert.deepEqual(bc4.children.map((c) => c.san), ['Nf6', 'Bc5']);
  assert.equal(bc4.children[1].comment, 'classical');
  assert.equal(e5.children[2].preComment, 'pre');
});

test('illegal moves skip only their own variation', () => {
  const [g] = parsePgn('1. e4 e5 (1... Ke5 2. d4) 2. Nf3 *');
  assert.equal(g.errors.length, 1);
  assert.equal(g.root.children[0].children.map((c) => c.san).join(), 'e5');
  assert.equal(g.root.children[0].children[0].children[0].san, 'Nf3');
});

test('an unclosed comment is reported, not silently swallowed', () => {
  const [g] = parsePgn('1. e4 e5 2. Nf3 {a note with no end 2... Nc6 3. Bb5 a6 *');
  assert.equal(g.errors.length, 1);
  assert.match(g.errors[0], /after 1\.e4 1\.\.\.e5 2\.Nf3 is never closed/);
  assert.equal(g.moves, 3, 'moves before the comment are kept');
  const [start] = parsePgn('{ never closed 1. e4 e5 *');
  assert.match(start.errors[0], /at the start is never closed/);
  const [ok] = parsePgn('1. e4 {fine} e5 *');
  assert.deepEqual(ok.errors, []);
});

test('arrow and square markup becomes shapes', () => {
  const c = parseComment('Look here [%cal Ge2e4,Rd7d5] [%csl Yf7] [%clk 0:01:00]');
  assert.equal(c.text, 'Look here');
  assert.equal(c.shapes.length, 3);
  assert.deepEqual(c.shapes[0], { orig: 'e2', dest: 'e4', brush: 'green' });
});

test('FEN start positions', () => {
  const [g] = parsePgn('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 40"]\n\n40. e4 Kd7 41. e5 *');
  assert.equal(g.errors.length, 0);
  assert.equal(formatSequence([g.root.children[0], g.root.children[0].children[0]]), '40.e4 Kd7');
});

test('multi-game files become chapters', () => {
  const games = parsePgn('[Event "A"]\n1. e4 e5 *\n\n[Event "B"]\n1. d4 d5 *\n');
  assert.equal(games.length, 2);
});

for (const file of ['italian-game-white.pgn', 'caro-kann-black.pgn']) {
  test(`sample ${file} parses cleanly`, () => {
    const pgn = fs.readFileSync(path.join(here, '..', 'samples', file), 'utf8');
    const color = /black/.test(file) ? 'black' : 'white';
    const model = buildRepertoire({ pgn, color });
    assert.deepEqual(model.errors, []);
    assert.ok(model.lines.length >= 4, `only ${model.lines.length} lines`);
  });
}

test('transpositions share cards', () => {
  const pgn = fs.readFileSync(path.join(here, '..', 'samples', 'italian-game-white.pgn'), 'utf8');
  const model = buildRepertoire({ pgn, color: 'white' });
  // 3...Bc5 4.c3 Nf6 5.d3 and 3...Nf6 4.d3 Bc5 5.c3 reach the same position; White's next move there is one card.
  const shared = [...model.cards.values()].filter((c) => c.lines.length > 1 && c.lines.some((l) => l.chapter.index === 0) && c.lines.some((l) => l.chapter.index === 1));
  assert.ok(shared.length >= 3, 'expected shared cards across chapters');
});

test('scheduler: promote, demote, due lines', () => {
  const now = 1_000_000_000_000;
  let s = srs.learned(now);
  assert.equal(s.level, 1);
  assert.equal(s.due, now + 4 * 3600e3);
  s = srs.promote(s, s.due);
  assert.equal(s.level, 2);
  s = srs.promote(srs.promote(s, now), now);
  assert.equal(s.level, 4);
  assert.equal(srs.demote(s, now).level, 1);
  assert.equal(srs.demote(s, now, 'stepback').level, 2);
  for (let i = 0; i < 20; i++) s = srs.promote(s, now);
  assert.equal(s.level, srs.MAX_LEVEL);
});

test('puzzle PGN round-trips through the parser with comments and glyphs', () => {
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

test('rating bands describe the explorer groups', () => {
  assert.equal(describeRatings([1600, 1800]), '1600–1999');
  assert.equal(describeRatings('2200,2500'), '2200+');
  assert.deepEqual(lichess.cleanRatings(''), [1600, 1800, 2000]);
  assert.deepEqual(lichess.cleanRatings('0,1000'), [0, 1000]);
  assert.deepEqual(lichess.cleanSpeeds('blitz,nonsense'), ['blitz']);
  assert.deepEqual(lichess.cleanSpeeds(''), ['blitz', 'rapid', 'classical']);
  assert.equal(describeSpeeds('ultraBullet,blitz'), 'ultrabullet, blitz');
  assert.deepEqual([0, 1000, 2500].map(ratingGroupLabel), ['Under 1000', '1000–1199', '2500+']);
  const ratingField = schema.buildSchema().flatMap((s) => s.fields).find((f) => f.key === 'lichessRatings');
  assert.deepEqual(ratingField.options[4], ['1600', '1600–1799'], 'the Settings page names each group');
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

test('puzzle queue: due first, then new by likelihood', () => {
  const now = 1_000_000_000_000;
  const rep = {
    puzzles: { a: { id: 'a', reach: 0.1 }, b: { id: 'b', reach: 0.5 }, c: { id: 'c', reach: 0.9 }, d: { id: 'd', reach: 0.9 } },
    cards: { 'pz|a': { level: 2, due: now - 10 }, 'pz|c': { level: 1, due: now + 1000 } },
  };
  assert.deepEqual(puzzleQueue(rep, { now }).map((p) => p.id), ['a', 'd', 'b']);
});

test('puzzle themes from material', () => {
  assert.equal(puzzles.theme({ mate: 3 }, 'w', 'x', 'x').label, 'Mate in 3');
  const before = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  const after = 'r1bqkbnr/pppp1ppp/8/4N3/4P3/8/PPPP1PPP/RNBQKB1R b KQkq - 0 4';
  assert.equal(puzzles.theme({ cp: 300 }, 'w', before, after).label, 'Wins a piece');
});

test('settings schema: defaults, clamping and bad values', () => {
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

test('scheduler follows custom intervals and step-back size', (t) => {
  srs.setIntervals([1, 2, 3, 4, 5, 6, 7, 8]);
  srs.setStepback(3);
  t.after(() => { // the scheduler's settings are module-wide: put the defaults back
    srs.setIntervals([4, 24, 72, 168, 336, 720, 2160, 4320]);
    srs.setStepback(2);
  });
  const now = 0;
  const s = srs.promote({ level: 4, due: 0 }, now);
  assert.equal(s.due, 5 * 3600e3);
  assert.equal(srs.demote({ level: 6, due: 0 }, now, 'stepback').level, 3);
});

