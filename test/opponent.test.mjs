// How the opponents choose their moves (public/js/opponent.js): Lichess players by
// popularity, surprises off your book, and the chapter a surprise answer becomes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildRepertoire, cardKey } from '../public/js/repertoire.js';
import { parsePgn } from '../public/js/pgn.js';
import { START_FEN } from '../public/js/constants.js';
import { checkChapter } from '../repertoire-format.js';
import { must } from './helpers/must.mjs';
import {
  pickByPopularity, bookMovesAt, opponentTurns, surpriseReplies, engineSurprises,
  surpriseFromGap, surpriseQueue, surpriseToPgn,
} from '../public/js/opponent.js';

/** The FEN after these SAN moves from the start (or from `from`). */
function fenAfter(sans, from = START_FEN) {
  const c = new Chess(from);
  for (const san of sans) c.move(san);
  return c.fen();
}

// White: the Queen's Gambit, reached two ways. 1.d4 e6 2.c4 d5 transposes into chapter one.
const PGN = '[Event "QGD"]\n\n1. d4 d5 2. c4 e6 3. Nc3 *\n\n[Event "Via e6"]\n\n1. d4 e6 2. c4 Nf6 *';
const model = buildRepertoire({ color: 'white', pgn: PGN });
const AFTER_D4 = fenAfter(['d4']);
const AFTER_E6_C4 = fenAfter(['d4', 'e6', 'c4']);

test('Lichess players pick a move as often as it is played', () => {
  const data = { total: 200, moves: [{ uci: 'e7e5', san: 'e5', total: 30 }, { uci: 'c7c5', san: 'c5', total: 70 }] };
  // The draw falls on the listed moves (100 games): 0–30 is e5, 30–100 is c5.
  assert.equal(must(pickByPopularity(data, () => 0)).uci, 'e7e5');
  assert.equal(must(pickByPopularity(data, () => 0.29)).uci, 'e7e5');
  assert.equal(must(pickByPopularity(data, () => 0.31)).uci, 'c7c5');
  assert.equal(must(pickByPopularity(data, () => 0.9999)).uci, 'c7c5');
  assert.equal(must(pickByPopularity(data, () => 1)).uci, 'c7c5', 'a draw of exactly 1 still picks a move');
  assert.equal(must(pickByPopularity(data, () => 0)).share, 30 / 200, 'share of all the position’s games');

  const counts = { e7e5: 0, c7c5: 0 };
  let seed = 1;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 5000; i++) counts[must(pickByPopularity(data, rand)).uci]++;
  assert.ok(Math.abs(counts.e7e5 / 5000 - 0.3) < 0.03, `about 30% e5, got ${counts.e7e5}`);
});

test('a position without games gives no move, so Stockfish takes over', () => {
  assert.equal(pickByPopularity(null), null);
  assert.equal(pickByPopularity({ total: 0, moves: [] }), null);
  assert.equal(pickByPopularity({ total: 0, moves: [{ uci: 'e7e5', san: 'e5', total: 0 }] }), null);
  assert.equal(must(pickByPopularity({ moves: [{ uci: 'e7e5', san: 'e5', total: 4 }] })).share, 1, 'without a total, the listed moves are all the games');
});

test('your repertoire’s moves in a position, from every chapter', () => {
  assert.deepEqual([...bookMovesAt(model, AFTER_D4)].sort(), ['d7d5', 'e7e6']);
  assert.deepEqual([...bookMovesAt(model, fenAfter(['e4']))], []);
});

test('surprises can come wherever the opponent is to move in your lines', () => {
  const turns = opponentTurns(model);
  assert.deepEqual(turns.map((t) => t.moves), [['d2d4'], ['d2d4', 'd7d5', 'c2c4'], ['d2d4', 'e7e6', 'c2c4']],
    'after 1.d4 once, though both chapters reach it');
  assert.equal(turns[0].fen, AFTER_D4);
  assert.equal(turns[0].startFen, START_FEN);

  const black = buildRepertoire({ color: 'black', pgn: '1. e4 c5 2. Nf3 d6 *' });
  assert.deepEqual(opponentTurns(black).map((t) => t.moves), [[], ['e2e4', 'c7c5']], 'as Black, the first move is a turn too');
});

test('a surprise is a popular reply your repertoire does not answer', () => {
  const data = {
    total: 1000,
    moves: [
      { uci: 'g8f6', san: 'Nf6', total: 600 }, // your book
      { uci: 'd7d5', san: 'd5', total: 300 }, // transposes into chapter one
      { uci: 'b7b6', san: 'b6', total: 60 },
      { uci: 'f7f5', san: 'f5', total: 80 },
      { uci: 'c7c5', san: 'c5', total: 30 }, // under 5%
    ],
  };
  assert.deepEqual(surpriseReplies(model, AFTER_E6_C4, data), [
    { uci: 'f7f5', san: 'f5', games: 80, share: 0.08 },
    { uci: 'b7b6', san: 'b6', games: 60, share: 0.06 },
  ]);
  assert.deepEqual(surpriseReplies(model, AFTER_E6_C4, data, { minShare: 0.07 }).map((s) => s.san), ['f5']);
  assert.deepEqual(surpriseReplies(model, AFTER_E6_C4, { total: 0, moves: [] }), []);
  assert.deepEqual(surpriseReplies(model, AFTER_E6_C4, null), []);
});

test('without Lichess, Stockfish’s sound sidelines are the surprises', () => {
  // Black to move after 1.d4: scores are from White's side, so lower is better for Black.
  const lines = [
    { score: { cp: 20 }, pv: ['d7d5'] }, // your book
    { score: { cp: 40 }, pv: ['g8f6', 'c2c4'] }, // 20 worse for Black: sound
    { score: { cp: 45 }, pv: ['e7e6'] }, // your book
    { score: { cp: 250 }, pv: ['g7g5'] }, // a blunder, not a surprise
    { score: null, pv: ['a7a6'] },
    { score: { cp: 30 }, pv: [] },
  ];
  assert.deepEqual(engineSurprises(model, AFTER_D4, lines), [{ uci: 'g8f6', san: 'Nf6', loss: 20 }]);
  assert.deepEqual(engineSurprises(model, AFTER_D4, lines, { maxLoss: 300 }).map((s) => s.uci), ['g8f6', 'g7g5']);
  assert.deepEqual(engineSurprises(model, AFTER_D4, []), []);
  // White to move: higher is better for the side to move.
  const white = buildRepertoire({ color: 'black', pgn: '1. e4 e5 *' });
  assert.deepEqual(engineSurprises(white, START_FEN, [{ score: { cp: 30 }, pv: ['e2e4'] }, { score: { cp: 25 }, pv: ['d2d4'] }]),
    [{ uci: 'd2d4', san: 'd4', loss: 5 }]);
});

const GAP_B6 = { lineMoves: ['d2d4', 'e7e6', 'c2c4', 'b7b6'], startFen: START_FEN, share: 0.06, games: 60, reach: 0.01 };
const GAP_C6 = { lineMoves: ['d2d4', 'd7d5', 'c2c4', 'c7c6'], startFen: START_FEN, share: 0.2, games: 900, reach: 0.05 };

test('a saved gap becomes a surprise, unless your repertoire answers it now', () => {
  assert.deepEqual(surpriseFromGap(model, 'k', GAP_B6), {
    startFen: START_FEN, moves: ['d2d4', 'e7e6', 'c2c4'], fen: AFTER_E6_C4, uci: 'b7b6', san: 'b6', share: 0.06, games: 60, source: 'gap', gapKey: 'k',
  });
  assert.equal(surpriseFromGap(model, 'k', { ...GAP_B6, lineMoves: ['d2d4', 'e7e6', 'c2c4', 'g8f6'] }), null, 'in the book');
  assert.equal(surpriseFromGap(model, 'k', { ...GAP_B6, lineMoves: ['d2d4', 'd7d5', 'c2c4', 'e7e6'] }), null, 'in the book by the other road');
  assert.equal(surpriseFromGap(model, 'k', { ...GAP_B6, lineMoves: ['d2d4', 'e2e5', 'c2c4'] }), null, 'an illegal move on the way');
  assert.equal(surpriseFromGap(model, 'k', { lineMoves: [] }), null);
  assert.equal(surpriseFromGap(model, 'k', null), null);
  const old = must(surpriseFromGap(model, 'k', { lineMoves: GAP_B6.lineMoves }));
  assert.equal(old.startFen, START_FEN, 'a gap without a start is from the start position');
  assert.equal(old.share, null);
});

test('a session works through the gaps first, most likely first, then the other turns', () => {
  const rep = { gaps: { b6: GAP_B6, c6: GAP_C6, answered: { ...GAP_B6, lineMoves: ['d2d4', 'e7e6', 'c2c4', 'g8f6'] } } };
  const queue = surpriseQueue(rep, model, { rand: () => 0 });
  assert.deepEqual(queue.map((q) => (q.kind === 'gap' ? q.surprise.san : q.turn.moves.join(' '))), ['c6', 'b6', 'd2d4'],
    'turns that already have a gap are not looked up again');
  assert.equal(surpriseQueue({}, model).length, 3, 'no gaps: every turn');
});

test('an answer becomes a chapter the repertoire can read', () => {
  const s = must(surpriseFromGap(model, 'k', GAP_B6));
  const pgn = surpriseToPgn(s, 'g1f3', { note: 'Played in 6% of games {at your level}.' });
  assert.equal(checkChapter(pgn), pgn.trim(), 'the server accepts it');
  assert.match(pgn, /\[ChapterName "Answer to 2\.\.\.b6"\]/);
  assert.match(pgn, /\n\n1\. d4 e6 2\. c4 b6 \{ Played in 6% of games at your level\. \} 3\. Nf3 \*\n$/);
  const [game] = parsePgn(pgn);
  assert.equal(game.moves, 5);
  const grown = buildRepertoire({ color: 'white', pgn: `${PGN}\n\n${pgn}` });
  assert.ok(grown.cards.has(cardKey(fenAfter(['d4', 'e6', 'c4', 'b6']), 'g1f3')), 'your answer is a card to learn');
  assert.equal(surpriseFromGap(grown, 'k', GAP_B6), null, 'and the gap is answered');
});

test('an answer from a set-up position keeps the position, and Black’s numbers are right', () => {
  const start = fenAfter(['e4', 'e5']);
  const s = { startFen: start, moves: ['g1f3'], fen: fenAfter(['Nf3'], start), uci: 'd7d6', san: 'd6', share: null, games: null, source: 'engine' };
  const pgn = surpriseToPgn(s, 'd2d4');
  assert.match(pgn, /\[SetUp "1"\]\n\[FEN "rnbqkbnr\/pppp1ppp\/8\/4p3\/4P3\/8\/PPPP1PPP\/RNBQKBNR w KQkq - 0 2"\]/);
  assert.match(pgn, /\n\n2\. Nf3 d6 3\. d4 \*\n$/);
  const [game] = parsePgn(pgn);
  assert.equal(game.root.fen, start);
  assert.deepEqual(game.errors, []);
  assert.doesNotThrow(() => checkChapter(pgn));

  const asBlack = { startFen: START_FEN, moves: [], fen: START_FEN, uci: 'b2b3', san: 'b3', share: 0.05, games: 50, source: 'lichess' };
  assert.match(surpriseToPgn(asBlack, 'e7e5', { note: 'Rare.' }), /\[Event "Surprise: 1\.b3"\][\s\S]*\n\n1\. b3 \{ Rare\. \} 1\.\.\. e5 \*/);
  assert.throws(() => surpriseToPgn(asBlack, 'e7e4'), /not legal/);
});

test('explorer data without a move list, or Stockfish without lines, gives no surprises', () => {
  assert.deepEqual(surpriseReplies(model, AFTER_D4, { total: 100 }), []);
  assert.deepEqual(engineSurprises(model, AFTER_D4, null), []);
  assert.deepEqual(engineSurprises(model, AFTER_D4, [null, { score: { cp: 10 } }, { score: { cp: 10 }, pv: [] }]), []);
});

test('a saved gap without a reach still comes up, after the likelier ones', () => {
  const rep = { gaps: { b6: { ...GAP_B6, reach: undefined }, c6: GAP_C6 } };
  const queue = surpriseQueue(rep, model, { rand: () => 0 });
  assert.deepEqual(queue.slice(0, 2).map((q) => q.kind === 'gap' && [q.surprise.uci, q.reach]), [['c7c6', 0.05], ['b7b6', 0]]);
});
