// How a repertoire's PGN becomes lines and cards (public/js/repertoire.js): the samples,
// cards shared by transpositions, the cases that leave a line out, and the moves that
// link to a position.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRepertoire, movesTo } from '../public/js/repertoire.js';

const sample = (file) => fs.readFileSync(new URL(`../samples/${file}`, import.meta.url), 'utf8');

for (const file of ['italian-game-white.pgn', 'caro-kann-black.pgn']) {
  test(`sample ${file} parses cleanly`, () => {
    const color = /black/.test(file) ? 'black' : 'white';
    const model = buildRepertoire({ pgn: sample(file), color });
    assert.deepEqual(model.errors, []);
    assert.ok(model.lines.length >= 4, `only ${model.lines.length} lines`);
  });
}

test('transpositions share cards', () => {
  const model = buildRepertoire({ pgn: sample('italian-game-white.pgn'), color: 'white' });
  // 3...Bc5 4.c3 Nf6 5.d3 and 3...Nf6 4.d3 Bc5 5.c3 reach the same position; White's next move there is one card.
  const shared = [...model.cards.values()].filter((c) => c.lines.length > 1 && c.lines.some((l) => l.chapter.index === 0) && c.lines.some((l) => l.chapter.index === 1));
  assert.ok(shared.length >= 3, 'expected shared cards across chapters');
});

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
