// How a repertoire's PGN becomes lines and cards (public/js/repertoire.js): the cases
// that leave a line out, and the moves that link to a position.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepertoire, movesTo } from '../public/js/repertoire.js';

test('reading problems are collected with the chapter they are in', () => {
  const model = buildRepertoire({ color: 'white', pgn: '[Event "Main"]\n\n1. e4 e5 2. Kf3 *' });
  assert.equal(model.errors.length, 1);
  assert.match(model.errors[0], /^Main: Illegal or unreadable move "Kf3"/);
  assert.equal(model.lines.length, 1, 'the moves before the problem still make a line');
});

test('a chapter without moves gives no lines', () => {
  const model = buildRepertoire({ color: 'white', pgn: '[Event "Broken"]\n[FEN "nonsense"]\n\n*' });
  assert.equal(model.chapters.length, 1, 'kept, so its problem can be shown');
  assert.equal(model.lines.length, 0);
  assert.equal(model.cards.size, 0);
});

test('a line repeated in another chapter is trained once', () => {
  const model = buildRepertoire({ color: 'white', pgn: '[Event "A"]\n\n1. e4 e5 2. Nf3 *\n\n[Event "B"]\n\n1. e4 e5 2. Nf3 *' });
  assert.equal(model.lines.length, 1);
  assert.equal(model.chapters[1].lines.length, 0);
});

test('a line with no move for your side is left out', () => {
  const model = buildRepertoire({ color: 'black', pgn: '1. e4 (1. d4) 1... e5 *' });
  assert.equal(model.side, 'b');
  assert.deepEqual(model.lines.map((l) => l.nodes.map((n) => n.san)), [['e4', 'e5']]);
});

test('a node is linked to by its moves from the chapter start', () => {
  const model = buildRepertoire({ color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  const [line] = model.lines;
  assert.deepEqual(movesTo(line.nodes[2]), ['e2e4', 'e7e5', 'g1f3']);
  assert.deepEqual(movesTo(model.chapters[0].root), []);
});
