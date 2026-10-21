// Card keys are stored user data: progress in data/repertoires/*.json is keyed by
// positionKey(fen)|uci. These literal keys pin the format, so a change to positionKey,
// cardKey, line hashing or the FENs chess.js writes fails here instead of silently
// resetting everyone's progress. A change that is meant to happen needs a migration
// (repertoire-format.js) before these strings may change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepertoire, cardKey, hash } from '../public/js/repertoire.js';
import { positionKey, START_FEN } from '../public/js/constants.js';
import { puzzleKey } from '../public/js/puzzle-utils.js';

const keys = (color, pgn) => [...buildRepertoire({ color, pgn }).cards.keys()];

test('a position key is the FEN without its move counters', () => {
  assert.equal(positionKey(START_FEN), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  assert.equal(cardKey(START_FEN, 'e2e4'), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -|e2e4');
});

test('no en passant square unless the capture is legal', () => {
  // After 1.e4 e5 no white pawn can take on e6, so the key has "-", not "e6".
  assert.deepEqual(keys('white', '1. e4 e5 2. Nf3 *'), [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -|e2e4',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -|g1f3',
  ]);
  // The same for Black after 1.e4: no "e3".
  assert.deepEqual(keys('black', '1. e4 c5 *'), ['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -|c7c5']);
});

test('the en passant square when the capture is legal, and the capture itself', () => {
  assert.deepEqual(keys('white', '1. e4 Nf6 2. e5 d5 3. exd6 *'), [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -|e2e4',
    'rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -|e4e5',
    'rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6|e5d6',
  ]);
});

test('castling rights that are gone leave the key', () => {
  assert.deepEqual(keys('white', '1. e4 e5 2. Ke2 Ke7 3. Ke1 *'), [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -|e2e4',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -|e1e2',
    'rnbq1bnr/ppppkppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR w - -|e2e1',
  ]);
});

test('a chapter from a [FEN] header, and a promotion', () => {
  const pgn = '[SetUp "1"]\n[FEN "1n5k/P7/8/8/8/8/8/K7 w - - 0 1"]\n\n1. axb8=N *';
  assert.deepEqual(keys('white', pgn), ['1n5k/P7/8/8/8/8/8/K7 w - -|a7b8n']);
});

test('line ids and puzzle keys', () => {
  assert.equal(hash('repertoire-trainer'), '2eiwj0l1rdc');
  assert.deepEqual(buildRepertoire({ color: 'white', pgn: '1. e4 e5 2. Nf3 *' }).lines.map((l) => l.id), ['23ffiqd5a1o']);
  assert.equal(puzzleKey('3f2a9c1e5b7d'), 'pz|3f2a9c1e5b7d');
});
