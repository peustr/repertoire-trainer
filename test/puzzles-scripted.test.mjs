// The opponent-mistake search (puzzles.js) against a scripted explorer and engine, so
// each rule can be met on purpose: which positions are searched and in what order, how
// a puzzle's solution is extended, and what is skipped. puzzles.test.mjs runs the search
// against the mock Lichess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildRepertoire } from '../public/js/repertoire.js';
import { START_FEN as START, positionKey } from '../public/js/constants.js';
import { LichessError } from '../lichess.js';
import { searchMistakes, buildPuzzle, theme } from '../puzzles.js';

/** The FEN after these SAN moves. */
function fenAfter(sans, from = START) {
  const c = new Chess(from);
  for (const san of sans) c.move(san);
  return c.fen();
}

/** An explorer move as lichess.explorer() returns it; half the games are White wins. */
const move = (uci, san, total) => ({ uci, san, total, white: Math.ceil(total / 2), draws: 0, black: Math.floor(total / 2), averageRating: 1700 });

/** A stand-in for the Lichess client: answers (or errors) by position. */
function scriptedExplorer(answers) {
  const asked = [];
  const byKey = new Map(Object.entries(answers).map(([fen, a]) => [positionKey(fen), a]));
  return {
    asked,
    async explorer({ fen }) {
      asked.push(positionKey(fen));
      const a = byKey.get(positionKey(fen));
      if (a instanceof Error) throw a;
      return { cached: false, total: 0, moves: [], ...a };
    },
  };
}

/**
 * A stand-in for the engine manager. evals: by position, { best?, moves?: { uci: { score, pv } | 'missing' } };
 * a move not listed scores level. lines: by position, the MultiPV lines. Scores are from White's side.
 */
function scriptedEngines({ evals = {}, lines = {} } = {}) {
  const calls = { evaluate: [], lines: [] };
  const evalsByKey = new Map(Object.entries(evals).map(([fen, e]) => [positionKey(fen), e]));
  const linesByKey = new Map(Object.entries(lines).map(([fen, l]) => [positionKey(fen), l]));
  return {
    calls,
    async evaluate({ fen, moves }) {
      calls.evaluate.push({ key: positionKey(fen), moves });
      const e = evalsByKey.get(positionKey(fen)) || {};
      const scored = moves
        .filter((m) => !(e.moves && e.moves[m] === 'missing'))
        .map((m) => ({ move: m, score: { cp: 0 }, pv: [m], ...(e.moves && e.moves[m]) }));
      return { best: 'best' in e ? e.best : { move: moves[0], score: { cp: 0 }, pv: [moves[0]] }, moves: scored };
    },
    async lines({ fen, depth }) {
      calls.lines.push({ key: positionKey(fen), depth });
      return { lines: linesByKey.get(positionKey(fen)) || [] };
    },
  };
}

const OPTIONS = {
  maxPositions: 10, maxOppDepth: 3, minShare: 0.05, minGames: 10, threshold: 150, minAdvantage: 120,
  depth: 8, solveDepth: 8, uniqueGap: 120, maxLength: 1, maxPuzzles: 5, beyondBook: 2, gapShare: 0.1,
  speeds: 'blitz', ratings: '1600',
};
const white = { id: 'w', color: 'white' };
const black = { id: 'b', color: 'black' };
const AFTER_E4 = fenAfter(['e4']);

/** Run the search with scripted helpers. */
function search({ answers = {}, engines = scriptedEngines(), options = {}, ...args }) {
  const lichess = scriptedExplorer(answers);
  const run = searchMistakes(/** @type {any} */ ({ lichess, engines, ...args, options: { ...OPTIONS, ...options } }));
  return run.then((res) => ({ ...res, asked: lichess.asked, engines }));
}

// --- themes -----------------------------------------------------------------------------

test('a puzzle is themed by what it wins, from either side', () => {
  const won = (side, before, after) => theme({ cp: 500 }, side, `${before} w - - 0 1`, `${after} w - - 0 1`).label;
  const bare = '4k3/8/8/8/8/8/8/4K3';
  assert.equal(won('w', 'q3k3/8/8/8/8/8/8/4K3', bare), 'Wins the queen');
  assert.equal(won('w', 'r3k3/8/8/8/8/8/8/4K3', bare), 'Wins a rook');
  assert.equal(won('w', 'n3k3/8/8/8/8/8/8/4K3', bare), 'Wins a piece');
  assert.equal(won('w', 'n3k3/8/8/8/8/8/P7/4K3', bare), 'Wins material', 'a knight for a pawn');
  assert.equal(won('w', 'p3k3/8/8/8/8/8/8/4K3', bare), 'Wins a pawn');
  assert.equal(won('w', bare, bare), 'Decisive advantage');
  assert.equal(won('b', '4k3/8/8/8/8/8/8/Q3K3', bare), 'Wins the queen');
  assert.equal(theme({ mate: -2 }, 'b', START, START).label, 'Mate in 2', 'a negative mate is Black mating');
  assert.equal(theme({ mate: 2 }, 'b', START, START).label, 'Decisive advantage', 'White mating is no theme for Black');
});

// --- building one puzzle ------------------------------------------------------------------

test('no puzzle when Stockfish has no line, or no longer sees enough', async () => {
  const opts = { ...OPTIONS };
  assert.equal(await buildPuzzle(scriptedEngines(), START, 'w', opts), null);
  assert.equal(await buildPuzzle(scriptedEngines({ lines: { [START]: [{ pv: [], score: { cp: 900 } }] } }), START, 'w', opts), null);
  assert.equal(await buildPuzzle(scriptedEngines({ lines: { [START]: [{ pv: ['e2e4'], score: { cp: 100 } }] } }), START, 'w', opts), null);
  assert.equal(await buildPuzzle(scriptedEngines({ lines: { [START]: [{ pv: ['e2e4'], score: null }] } }), START, 'w', opts), null);
});

test('a mate for Black is a puzzle, and the solving depth defaults to two more than the search', async () => {
  const engines = scriptedEngines({ lines: { [AFTER_E4]: [{ pv: ['d8h4'], score: { mate: -3 } }] } });
  const { solveDepth, maxLength, ...opts } = OPTIONS;
  assert.ok(solveDepth && maxLength);
  const p = await buildPuzzle(engines, AFTER_E4, 'b', opts);
  assert.equal(engines.calls.lines[0].depth, OPTIONS.depth + 2);
  assert.equal(p.unique, true, 'no second line to compare');
  assert.equal(p.secondScore, null);
  assert.deepEqual(p.solution, ['d8h4']);
  assert.equal(p.theme.label, 'Mate in 3');
});

test('a mate is a single-answer puzzle even when the second line scores almost as high', async () => {
  const lines = (a, b) => scriptedEngines({ lines: { [START]: [{ pv: ['e2e4'], score: a }, { pv: ['d2d4'], score: b }] } });
  assert.equal((await buildPuzzle(lines({ mate: 4 }, { cp: 9900 }), START, 'w', OPTIONS)).unique, true);
  assert.equal((await buildPuzzle(lines({ cp: 400 }, { cp: 350 }), START, 'w', OPTIONS)).unique, false);
});

test('the solution goes on while each next move is clearly the only good one', async () => {
  const afterE5 = fenAfter(['e4', 'e5']);
  const afterNc6 = fenAfter(['e4', 'e5', 'Nf3', 'Nc6']);
  const engines = scriptedEngines({
    lines: {
      [START]: [{ pv: ['e2e4', 'e7e5', 'g1f3'], score: { cp: 300 } }, { pv: ['d2d4'], score: { cp: 0 } }],
      [afterE5]: [{ pv: ['g1f3', 'b8c6'], score: { cp: 320 } }, { pv: ['f1c4'], score: { cp: 100 } }],
      // Only 50 better than the second line, but a mate against none: still the only move.
      [afterNc6]: [{ pv: ['f1b5'], score: { mate: 5 } }, { pv: ['f1c4'], score: { cp: 9900 } }],
    },
  });
  const p = await buildPuzzle(engines, START, 'w', { ...OPTIONS, maxLength: 3, solveDepth: undefined });
  assert.deepEqual(engines.calls.lines.map((c) => c.depth), [10, 8, 8], 'without a solving depth: two deeper for the first move, then the search depth');
  assert.deepEqual(p.solutionSan, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
  assert.deepEqual(p.score, { mate: 5 }, 'the score at the end of the solution');
  assert.deepEqual(p.firstScore, { cp: 300 });
  assert.deepEqual(p.secondScore, { cp: 0 });
});

test('the solution stops where the next move is not forced, not legal, or the game is over', async () => {
  const solve = async (lines, fen = START, maxLength = 3) => (await buildPuzzle(scriptedEngines({ lines }), fen, 'w', { ...OPTIONS, maxLength })).solution;
  const first = (pv) => ({ [START]: [{ pv, score: { cp: 500 } }] });
  const afterE5 = fenAfter(['e4', 'e5']);

  assert.deepEqual(await solve(first(['e2e4'])), ['e2e4'], 'no reply expected');
  assert.deepEqual(await solve(first(['e2e4', 'e2e4'])), ['e2e4'], 'the expected reply is not legal');
  assert.deepEqual(await solve(first(['e2e4', 'e7e5'])), ['e2e4'], 'Stockfish has nothing after the reply');
  assert.deepEqual(await solve({ ...first(['e2e4', 'e7e5']), [afterE5]: [{ pv: ['g1f3'], score: { cp: 300 } }, { pv: ['f1c4'], score: { cp: 280 } }] }),
    ['e2e4'], 'two good moves: not a single answer');
  assert.deepEqual(await solve({ ...first(['e2e4', 'e7e5']), [afterE5]: [{ pv: ['a1a8'], score: { cp: 300 } }] }), ['e2e4'], 'its move is not legal');
  assert.deepEqual(await solve({ ...first(['e2e4', 'e7e5']), [afterE5]: [{ pv: [], score: { cp: 300 } }] }), ['e2e4'], 'its line is empty');

  // 1.f3 e5 2.g4?? Qh4#: after the reply there is nothing left to play.
  const fools = fenAfter(['f3', 'e5']);
  const p = await buildPuzzle(scriptedEngines({ lines: { [fools]: [{ pv: ['g2g4', 'd8h4'], score: { cp: 300 } }] } }), fools, 'w', { ...OPTIONS, maxLength: 3 });
  assert.deepEqual(p.solution, ['g2g4']);
});

test('a first move that is not legal still gives a puzzle, at the position it was asked about', async () => {
  const p = await buildPuzzle(scriptedEngines({ lines: { [START]: [{ pv: ['e2e5', 'e7e5'], score: { cp: 500 } }] } }), START, 'w', OPTIONS);
  assert.deepEqual(p.solution, ['e2e5']);
  assert.deepEqual(p.solutionSan, [], 'nothing to name');
  assert.equal(p.theme.label, 'Decisive advantage');
});

// --- the search ---------------------------------------------------------------------------------

test('the likeliest position is searched first; failed and thin explorer answers are skipped', async () => {
  const model = buildRepertoire({ color: 'white', pgn: '1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *' });
  const viaE5 = fenAfter(['e4', 'e5', 'Nf3']);
  const viaC5 = fenAfter(['e4', 'c5', 'Nf3']);
  const res = await search({
    rep: white, model, fen: START,
    answers: {
      [AFTER_E4]: { total: 1000, moves: [move('c7c5', 'c5', 200), move('e7e5', 'e5', 600)] },
      [viaE5]: new LichessError('Lichess answered 500', 500),
      [viaC5]: { total: 5, moves: [move('b8c6', 'Nc6', 5)] },
    },
  });
  assert.deepEqual(res.asked, [AFTER_E4, viaE5, viaC5].map(positionKey), 'e5 (60%) before c5 (20%)');
  assert.equal(res.stats.skipped, 1);
  assert.equal(res.stats.positions, 2, 'the failed lookup does not count');
  assert.equal(res.exhausted, true);
});

test('replies that cannot be played are ignored, only the most popular are scored, and gaps note what to play', async () => {
  const model = buildRepertoire({ color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  const engines = scriptedEngines({
    evals: { [AFTER_E4]: { moves: { e7e6: { score: { cp: 0 }, pv: undefined }, d7d5: { score: { cp: 0 }, pv: ['d7d5', 'a1a8'] } } } },
  });
  const res = await search({
    rep: white, model, fen: START, engines, prefix: { startFen: START },
    options: { candidates: 3 },
    answers: {
      [AFTER_E4]: {
        total: 1000,
        moves: [move('e7e6', 'P-K3', 300), move('zzzz', 'Zz9', 250), move('e7e5', 'e5', 200), move('d7d5', 'd5', 150), move('c7c5', 'c5', 100)],
      },
    },
  });
  assert.deepEqual(engines.calls.evaluate[0].moves, ['e7e6', 'e7e5', 'd7d5'], 'read by its UCI when the SAN is unreadable; c5 is past the three');
  assert.deepEqual(res.gaps.map((g) => [g.san, g.bestReply, g.bestReplySan]), [['e6', null, null], ['d5', 'a1a8', null]]);
  assert.deepEqual(res.gaps[0].lineMoves, ['e2e4', 'e7e6']);
  assert.equal(res.gaps[0].startFen, START);
});

test('out of book, your move is Stockfish’s: the hint from the last search, or a fresh one', async () => {
  const model = buildRepertoire({ color: 'white', pgn: '1. e4 *' });
  const after = (san) => fenAfter(['e4', san]);
  const engines = scriptedEngines({
    evals: {
      [AFTER_E4]: {
        moves: {
          e7e5: { score: { cp: 0 }, pv: ['e7e5', 'g1f3'] },
          c7c5: { score: { cp: 0 }, pv: ['c7c5'] },
          d7d5: { score: { cp: 0 }, pv: ['d7d5', 'a1a8'] },
          g8f6: { score: { cp: 0 }, pv: ['g8f6'] },
        },
      },
    },
    lines: { [after('c5')]: [{ pv: ['g1f3'], score: { cp: 30 } }] },
  });
  const res = await search({
    rep: white, model, fen: START, engines,
    answers: { [AFTER_E4]: { total: 1000, moves: [move('e7e5', 'e5', 400), move('c7c5', 'c5', 300), move('d7d5', 'd5', 200), move('g8f6', 'Nf6', 100)] } },
  });
  assert.deepEqual(res.gaps, [], 'the repertoire has no replies here to miss');
  assert.deepEqual(engines.calls.lines.map((c) => c.key), [after('c5'), after('Nf6')].map(positionKey), 'asked only where there was no hint');
  assert.deepEqual(res.asked.slice(1), [fenAfter(['e4', 'e5', 'Nf3']), fenAfter(['e4', 'c5', 'Nf3'])].map(positionKey),
    'no move after d5 (the hint is not legal) or Nf6 (Stockfish had none)');
});

test('with no opponent moves to follow nothing is looked up, and a position reached twice is looked up once', async () => {
  const shallow = await search({ rep: black, model: buildRepertoire({ color: 'black', pgn: '1. e4 e5 *' }), fen: START, options: { maxOppDepth: 0 } });
  assert.deepEqual(shallow.asked, []);

  const model = buildRepertoire({ color: 'white', pgn: '1. d4 d5 2. c4 *\n\n1. c4 d5 2. d4 *' });
  const answers = {
    [fenAfter(['d4'])]: { total: 100, moves: [move('d7d5', 'd5', 100)] },
    [fenAfter(['c4'])]: { total: 100, moves: [move('d7d5', 'd5', 100)] },
  };
  const res = await search({ rep: white, model, fen: START, answers });
  const queens = positionKey(fenAfter(['d4', 'd5', 'c4']));
  assert.equal(res.asked.filter((k) => k === queens).length, 1, 'the Queen’s Gambit, by either move order');
});

test('a reply that walks into mate is a mistake however small the score gap; details for a Black repertoire', async () => {
  const model = buildRepertoire({ color: 'black', pgn: '1. e4 e5 *' });
  const afterF3 = fenAfter(['f3']);
  const afterA3 = fenAfter(['a3']);
  const engines = scriptedEngines({
    evals: { [START]: { best: { move: null, score: { cp: 0 } }, moves: { f2f3: { score: { mate: -5 } }, a2a3: { score: { mate: -6 } } } } },
    lines: { [afterF3]: [{ pv: ['e7e5'], score: { mate: -5 } }], [afterA3]: [{ pv: ['e7e5'], score: { mate: -6 } }] },
  });
  const res = await search({
    rep: black, model, fen: START, engines,
    options: { threshold: 100000, minShare: 0 },
    answers: { [START]: { total: 1000, moves: [move('e2e4', 'e4', 900), move('f2f3', 'f3', 100), move('a2a3', 'a3', 0)] } },
  });
  const [f3, a3] = res.puzzles;
  assert.equal(f3.mistake.san, 'f3');
  assert.equal(f3.mistake.yourScore, 50, 'from Black’s wins (half the games)');
  assert.equal(f3.mistake.bestMoveBeforeSan, null, 'Stockfish named no best move');
  assert.equal(f3.startFen, START, 'without a prefix the line starts at the search root');
  assert.deepEqual(f3.lineMoves, ['f2f3']);
  assert.equal(a3.mistake.yourScore, null, 'no games to score');
});

test('a mistake the deeper look does not confirm is dropped, and replies without a score are passed over', async () => {
  const model = buildRepertoire({ color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  const engines = scriptedEngines({
    evals: { [AFTER_E4]: { moves: { f7f6: { score: { cp: 400 } }, d7d5: 'missing', c7c5: { score: null } } } },
    lines: { [fenAfter(['e4', 'f6'])]: [{ pv: ['g1f3'], score: { cp: 50 } }] },
  });
  const res = await search({
    rep: white, model, fen: START, engines,
    answers: { [AFTER_E4]: { total: 1000, moves: [move('e7e5', 'e5', 500), move('f7f6', 'f6', 200), move('d7d5', 'd5', 200), move('c7c5', 'c5', 100)] } },
  });
  assert.deepEqual(res.puzzles, []);
  assert.deepEqual(res.gaps, [], 'd5 and c5 have no score to judge them by');
  assert.equal(engines.calls.lines.length, 1, 'the mistake was looked at');
});

test('the search can be stopped while it scores a position’s replies', async () => {
  const model = buildRepertoire({ color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  const engines = scriptedEngines({ evals: { [AFTER_E4]: { moves: { f7f6: { score: { cp: 400 } } } } } });
  let checks = 0;
  const res = await search({
    rep: white, model, fen: START, engines, cancelled: () => ++checks >= 4,
    answers: { [AFTER_E4]: { total: 1000, moves: [move('f7f6', 'f6', 600), move('e7e5', 'e5', 400)] } },
  });
  assert.equal(res.cancelled, true);
  assert.deepEqual(engines.calls.lines, [], 'stopped before working out the puzzle');
});

test('a rate limit or a lost connection stops the search', async () => {
  const model = buildRepertoire({ color: 'white', pgn: '1. e4 e5 *' });
  for (const status of [429, 502]) {
    await assert.rejects(search({ rep: white, model, fen: START, answers: { [AFTER_E4]: new LichessError('No', status) } }), { status });
  }
});

test('a mistake reached again by another road is worked out once', async () => {
  // The same position, once with Black still able to castle and once not: 1...Rg8 gives the same result from both.
  const castling = '4k2r/8/8/8/8/8/8/4K3 b k - 0 1';
  const kd8 = fenAfter(['Kd8', 'Kd1'], castling);
  const back = fenAfter(['Kd8', 'Kd1', 'Ke8', 'Ke1'], castling);
  assert.notEqual(positionKey(back), positionKey(castling));
  const engines = scriptedEngines({
    evals: {
      [castling]: { moves: { h8g8: { score: { cp: 500 } }, e8d8: { score: { cp: 0 }, pv: ['e8d8', 'e1d1'] } } },
      [kd8]: { moves: { d8e8: { score: { cp: 0 }, pv: ['d8e8', 'd1e1'] } } },
      [back]: { moves: { h8g8: { score: { cp: 500 } } } },
    },
    lines: { [fenAfter(['Rg8'], castling)]: [{ pv: ['e1e2'], score: { cp: 500 } }] },
  });
  const res = await search({
    rep: white, model: buildRepertoire({ color: 'white', pgn: '' }), fen: castling, engines, prefix: { moves: ['e2e4'] },
    options: { maxOppDepth: 4, beyondBook: 3 },
    answers: {
      [castling]: { total: 100, moves: [move('h8g8', 'Rg8', 50), move('e8d8', 'Kd8', 50)] },
      [kd8]: { total: 100, moves: [move('d8e8', 'Ke8', 100)] },
      [back]: { total: 100, moves: [move('h8g8', 'Rg8', 100)] },
    },
  });
  assert.equal(res.asked.at(-1), positionKey(back), 'the second road was searched');
  assert.equal(res.puzzles.length, 1);
  assert.equal(engines.calls.lines.length, 1);
  assert.equal(res.puzzles[0].startFen, castling, 'a prefix without a start begins at the search root');
  assert.deepEqual(res.puzzles[0].lineMoves, ['e2e4', 'h8g8']);
});
