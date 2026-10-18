// The PGN reader's less common input (public/js/pgn.js): escape lines, stray brackets,
// annotations on their own, broken start positions and variations, and chapter names.
// The everyday cases are in core.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, parseComment, parsePgn, chapterName, moveNumber, formatSequence, toFigurine, nagGlyphs,
} from '../public/js/pgn.js';
import { START_FEN } from '../public/js/constants.js';
import { buildRepertoire } from '../public/js/repertoire.js';

const kinds = (text) => tokenize(text).map((t) => (t.t === 'san' ? t.text : t.t === 'nag' ? `$${t.n}` : t.t));

test('a line starting with % is skipped, to the end of the line or the text', () => {
  assert.deepEqual(kinds('% exported by some tool\n1. e4\n% the end'), ['e4']);
  assert.deepEqual(kinds('1. e4 %e5'), ['e4', '%e5'], 'only at the start of a line');
});

test('stray brackets and symbols are skipped', () => {
  assert.deepEqual(kinds('[not a header] 1. e4 } $ e5 ]'), ['not', 'a', 'header', 'e4', 'e5']);
});

test('a ; comment on the last line runs to the end of the text', () => {
  const t = tokenize('1. e4 ; a closing remark');
  assert.deepEqual(t[1], { t: 'comment', text: ' a closing remark' });
});

test('½-½ is read as a draw, and 0-0-0 as queenside castling', () => {
  assert.deepEqual(tokenize('0-0-0 ½-½'), [{ t: 'san', text: 'O-O-O' }, { t: 'result', value: '1/2-1/2' }]);
});

test('annotations written apart from the move still count; nonsense ones, numbers and e.p. are ignored', () => {
  assert.deepEqual(kinds('1. e4 ! d5 2. e5 f5 ?!? 3. exf6 e.p. 12 ?'), ['e4', '$1', 'd5', 'e5', 'f5', 'exf6', '$2']);
});

test('arrows and squares in an unknown colour are drawn green', () => {
  assert.deepEqual(parseComment('[%cal Xe2e4] [%csl Zd5]').shapes, [
    { orig: 'e2', dest: 'e4', brush: 'green' },
    { orig: 'd5', brush: 'green' },
  ]);
});

test('several comments after a move are joined', () => {
  const [g] = parsePgn('1. e4 {one} {two} e5 *');
  assert.equal(g.root.children[0].comment, 'one two');
});

test('several comments before a variation’s first move are joined', () => {
  const [g] = parsePgn('1. e4 e5 ({one} {two} 1... c5) *');
  assert.equal(g.root.children[0].children[1].preComment, 'one two');
});

test('an illegal first move is reported as coming at the start', () => {
  const [g] = parsePgn('1. e5 e6 *');
  assert.equal(g.moves, 0);
  assert.match(g.errors[0], /^Illegal or unreadable move "e5" after the start/);
});

test('a null move (--) is reported and the rest of its line skipped, not trained as a move', () => {
  const [g] = parsePgn('1. e4 -- 2. d4 (2. Nf3) *');
  assert.equal(g.errors.length, 1);
  assert.match(g.errors[0], /^Illegal or unreadable move "--" after 1\.e4/);
  assert.deepEqual(g.root.children[0].children, [], 'nothing after 1.e4 is kept');
  const model = buildRepertoire({ color: 'black', pgn: '1. e4 e5 (1... -- 2. d4) 2. Nf3 *' });
  assert.deepEqual([...model.cards.values()].map((c) => c.san), ['e5'], 'no card asks you to pass');
});

test('comments inside a line that was skipped are dropped with it', () => {
  const [g] = parsePgn('1. e4 e5 (1... Ke5 {lost with the line} 2. d4) 2. Nf3 *');
  assert.equal(g.errors.length, 1);
  const comments = [];
  const walk = (n) => { comments.push(n.comment, n.preComment); n.children.forEach(walk); };
  walk(g.root);
  assert.ok(!comments.some((c) => c.includes('lost')));
  assert.equal(g.root.children[0].children[0].children[0].san, 'Nf3', 'the main line goes on');
});

test('a broken [FEN] header is reported and the game starts from the usual position', () => {
  const [g] = parsePgn('[FEN "not a position"]\n\n1. e4 *');
  assert.deepEqual(g.errors, ['Invalid [FEN] header: not a position']);
  assert.equal(g.root.fen, START_FEN);
  assert.equal(g.root.children[0].san, 'e4');
});

test('a variation before the first move is reported and ignored', () => {
  const [g] = parsePgn('(1. d4 d5) 1. e4 e5 *');
  assert.deepEqual(g.errors, ['A variation starts before any move was played — ignored it.']);
  assert.deepEqual(g.root.children.map((c) => c.san), ['e4']);
  assert.equal(g.moves, 2);
});

test('a result inside a variation does not end the game', () => {
  const games = parsePgn('1. e4 (1. d4 1-0) 1... e5 *');
  assert.equal(games.length, 1);
  assert.deepEqual(games[0].root.children.map((c) => c.san), ['e4', 'd4']);
  assert.equal(games[0].root.children[0].children[0].san, 'e5');
});

test('a variation that is never closed is reported', () => {
  const [g] = parsePgn('1. e4 e5 (1... c5 2. Nf3 *');
  assert.deepEqual(g.errors, ['Unbalanced parentheses — a variation was never closed.']);
  assert.equal(g.moves, 4, 'its moves are still read');
});

test('nothing to read gives no games', () => {
  assert.deepEqual(parsePgn(null), []);
  assert.deepEqual(parsePgn(undefined), []);
  assert.deepEqual(parsePgn('   \n'), []);
});

test('a new header after moves starts the next game, even without a result', () => {
  const games = parsePgn('[Event "A"]\n1. e4 e5\n[Event "B"]\n1. d4 d5');
  assert.deepEqual(games.map((g) => g.headers.Event), ['A', 'B']);
  assert.deepEqual(games.map((g) => g.root.children[0].san), ['e4', 'd4']);
});

test('chapter names come from the most telling header', () => {
  const name = (headers) => chapterName({ headers }, 2);
  assert.equal(name({ ChapterName: ' Main line ', Event: 'X' }), 'Main line');
  assert.equal(name({ Event: 'My study: Sicilian: Najdorf' }), 'Sicilian: Najdorf', 'a Lichess study export');
  assert.equal(name({ White: 'Carlsen', Black: 'Nakamura', Event: 'Blitz' }), 'Carlsen – Nakamura');
  assert.equal(name({ White: 'White', Black: 'Black', Event: 'Blitz' }), 'Blitz', 'placeholder player names are no use');
  assert.equal(name({ White: 'Carlsen', Event: 'Blitz' }), 'Blitz');
  assert.equal(name({ Opening: 'Sicilian Defence', Variation: 'Najdorf' }), 'Sicilian Defence: Najdorf');
  assert.equal(name({ Opening: 'Sicilian Defence', Variation: '?' }), 'Sicilian Defence');
  assert.equal(name({ Event: '?', White: '??', Opening: '?' }), 'Chapter 3');
});

test('move numbers come from the position before the move', () => {
  const [g] = parsePgn('[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 41"]\n\n41... Kd7 42. e4 *');
  const kd7 = g.root.children[0];
  assert.equal(moveNumber(kd7), 41);
  assert.equal(moveNumber(kd7.children[0]), 42);
  assert.equal(moveNumber(g.root), 41, 'the start position has its own number');
  assert.equal(moveNumber({ parent: null, fen: '4k3/8/8/8/8/8/4P3/4K3 b - -' }), 1, 'a position without move counters starts at 1');
});

test('a sequence starting with Black’s move numbers it with dots, and can use figurines', () => {
  const [g] = parsePgn('1. e4 e5 2. Nf3! Nc6 3. Bb5 *');
  const e5 = g.root.children[0].children[0];
  const nodes = [e5, e5.children[0], e5.children[0].children[0], e5.children[0].children[0].children[0]];
  assert.equal(formatSequence(nodes), '1...e5 2.Nf3! Nc6 3.Bb5');
  assert.equal(formatSequence(nodes, true), '1...e5 2.♘︎f3! ♘︎c6 3.♗︎b5');
});

test('figurines replace piece letters, promotions included', () => {
  assert.equal(toFigurine('Qxf7#'), '♕︎xf7#');
  assert.equal(toFigurine('e8=N+'), 'e8=♘︎+');
  assert.equal(toFigurine('e4'), 'e4');
  assert.equal(toFigurine(''), '');
  assert.equal(toFigurine(null), '');
});

test('NAG glyphs skip the ones without a symbol', () => {
  assert.equal(nagGlyphs([1, 99, 16]), '!±');
  assert.equal(nagGlyphs(undefined), '');
});
