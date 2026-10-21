// Playing one move from a position (public/js/moves.js): the one copy the PGN reader, the
// opponents, the mistake search and the board pages share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playMove } from '../public/js/moves.js';
import { START_FEN } from '../public/js/constants.js';
import { must } from './helpers/must.mjs';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

test('a move in UCI or in SAN gives the same result', () => {
  const played = { fen: AFTER_E4, uci: 'e2e4', san: 'e4', color: 'w', captured: false };
  assert.deepEqual(playMove(START_FEN, 'e2e4'), played);
  assert.deepEqual(playMove(START_FEN, 'e4'), played);
});

test('a promotion, a capture and castling', () => {
  assert.equal(must(playMove('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8n')).san, 'a8=N');
  assert.deepEqual(playMove('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'exd5'), { fen: '4k3/8/8/3P4/8/8/8/4K3 b - - 0 1', uci: 'e4d5', san: 'exd5', color: 'w', captured: true });
  assert.equal(must(playMove('r3k3/8/8/8/8/8/8/R3K2R w KQq - 0 1', 'O-O')).uci, 'e1g1', 'castling in UCI is the king’s move');
});

test('an illegal or unreadable move is no move, and so is a null move', () => {
  for (const move of ['e2e5', 'Qh5', 'xyz', '--', null, undefined]) assert.equal(playMove(START_FEN, move), null, String(move));
  assert.equal(playMove('not a position', 'e2e4'), null);
});

test('a position a study sets up plays even when chess.js would not accept it', () => {
  assert.equal(must(playMove('8/8/8/8/8/8/4P3/8 w - - 0 1', 'e2e4')).fen, '8/8/8/8/4P3/8/8/8 b - - 0 1', 'no kings');
});
