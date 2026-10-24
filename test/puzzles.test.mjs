// The opponent-mistake search (puzzles.js) end to end: real explorer client against
// the mock Lichess, and a scripted engine that calls one reply a blunder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { startMockLichess } from './helpers/mock-lichess.mjs';
import { buildRepertoire } from '../public/js/repertoire.js';
import { START_FEN as START, positionKey } from '../public/js/constants.js';
import { createLichessClient } from '../lichess.js';
import { searchMistakes } from '../puzzles.js';

const mock = await startMockLichess();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-puzzles-'));
const lichess = createLichessClient({ dataDir, baseUrl: mock.url, explorerUrl: mock.url });
await lichess.connectWithToken('lip_testToken123');
/** The search, with this file's Lichess client. */
const search = (args) => searchMistakes({ lichess, ...args });

after(async () => {
  await mock.stop();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const OPTIONS = {
  maxPositions: 3, maxOppDepth: 2, minShare: 0.05, minGames: 10, threshold: 150, minAdvantage: 120,
  depth: 10, solveDepth: 10, uniqueGap: 120, maxLength: 1, maxPuzzles: 5, beyondBook: 1, gapShare: 0.1,
  speeds: 'blitz', ratings: '1600',
};
const uci = (m) => m.from + m.to + (m.promotion || '');

/**
 * A scripted engine: at `blunderAt`, the second reply it is asked about leaves White
 * 4 pawns up; everything else is level. Scores are from White's side, as from engine.js.
 * @param {string | null} blunderAt
 * @param {{ bestScore?: { cp: number } | null }} [options]
 */
function scriptedEngines(blunderAt, { bestScore = { cp: 0 } } = {}) {
  const seen = { blunder: null };
  return {
    seen,
    async evaluate({ fen, moves }) {
      const blunder = blunderAt && positionKey(fen) === positionKey(blunderAt) ? moves[1] : null;
      if (blunder) seen.blunder = blunder;
      return {
        best: { move: moves[0], score: bestScore, pv: [moves[0]] },
        moves: moves.map((m) => ({ move: m, score: { cp: m === blunder ? 400 : 0 }, pv: [m] })),
      };
    },
    async lines({ fen }) {
      const [a, b] = new Chess(fen).moves({ verbose: true });
      return { lines: [{ pv: [uci(a)], score: { cp: 400 } }, { pv: [uci(b)], score: { cp: 0 } }], bestmove: uci(a) };
    },
  };
}

const white = { id: 'w', color: 'white' };
const whiteModel = buildRepertoire({ color: 'white', pgn: '1. e4 e5 2. Nf3 *' });

test('a popular reply that throws the game away becomes a puzzle', async () => {
  const engines = scriptedEngines(AFTER_E4);
  const found = [];
  const res = await search({
    rep: white, model: whiteModel, fen: START, prefix: { startFen: START, moves: [] }, engines, options: OPTIONS,
    onEvent: (ev) => { if (ev.kind === 'found') found.push(ev.puzzle); },
  });
  assert.equal(res.puzzles.length, 1);
  const [p] = res.puzzles;
  assert.equal(p.mistake.uci, engines.seen.blunder);
  assert.deepEqual(p.lineMoves, ['e2e4', engines.seen.blunder], 'from the start: your e4, their blunder');
  assert.equal(p.unique, true);
  assert.equal(p.solution.length, 1);
  assert.ok(p.theme.label);
  assert.deepEqual(found.map((x) => x.id), [p.id], 'reported as it was found');
});

test('a position the engine could not score is skipped, not taken as level', async () => {
  const engines = scriptedEngines(AFTER_E4, { bestScore: null });
  const res = await search({ rep: white, model: whiteModel, fen: START, engines, options: OPTIONS });
  assert.equal(engines.seen.blunder !== null, true, 'the search reached the position');
  assert.deepEqual(res.puzzles, [], 'no score for the best move means nothing to compare the reply with');
  assert.ok(res.stats.skipped >= 1);
});

test('popular replies your repertoire does not answer are reported as gaps', async () => {
  const res = await search({ rep: white, model: whiteModel, fen: START, engines: scriptedEngines(AFTER_E4), options: OPTIONS });
  assert.ok(res.gaps.length >= 1);
  for (const g of res.gaps) {
    assert.notEqual(g.san, 'e5', 'e5 is prepared');
    assert.ok(g.share >= OPTIONS.gapShare);
  }
});

test('the search stays within its budget, and stops when asked', async () => {
  const res = await search({ rep: white, model: whiteModel, fen: START, engines: scriptedEngines(null), options: { ...OPTIONS, maxPositions: 2 } });
  assert.ok(res.stats.positions <= 2);

  let progress = 0;
  const stopped = await search({
    rep: white, model: whiteModel, fen: START, engines: scriptedEngines(null), options: OPTIONS,
    onEvent: (ev) => { if (ev.kind === 'progress') progress++; },
    cancelled: () => progress > 0,
  });
  assert.equal(stopped.ended, 'stopped');
  assert.equal(stopped.stats.positions, 1);
});

test('without a Lichess account the search stops with that message', async () => {
  await lichess.disconnect();
  const black = { id: 'b', color: 'black' };
  const blackModel = buildRepertoire({ color: 'black', pgn: '1. e4 e5 *' });
  await assert.rejects(
    search({ rep: black, model: blackModel, fen: START, engines: scriptedEngines(null), options: OPTIONS }),
    { status: 401 },
  );
});
