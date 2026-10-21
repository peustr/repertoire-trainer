// Closer to a real opponent: Spar against Lichess players, "Play it out" after a line,
// and Surprise drills. Stockfish is replaced by a fake engine socket with scripted
// answers, so the grading is exact and nothing waits on a real search. Lichess is the
// mock (test/mock-lichess.js) where a test asks for it.

import { Chess } from 'chess.js';
import { test, expect, playMove, playLine, fakeEngine } from './fixtures.mjs';
import { REQUEST } from '../../public/js/protocol.js';
import { START_FEN, positionKey } from '../../public/js/constants.js';
import { buildRepertoire } from '../../public/js/repertoire.js';

/** The FEN after these SAN moves from the start (or from `from`). */
function fenAfter(sans, from = START_FEN) {
  const c = new Chess(from);
  for (const san of sans) c.move(san);
  return c.fen();
}

/** A scripted evaluate: Stockfish's best is `best`, and each move scores as listed (others −1.00). */
const scored = (best, scores) => (msg) => ({
  best: { move: best, score: { cp: scores[best] }, pv: [best] },
  moves: msg.moves.map((m) => ({ move: m, score: { cp: scores[m] ?? -100 }, pv: [m] })),
});

test.describe('with Lichess connected', () => {
  test.use({ lichess: true });

  test('Spar: Lichess players choose the moves while the database has games, then Stockfish', async ({ page, app }) => {
    await app.api('PUT', '/api/settings', { figurines: false });
    const asked = await fakeEngine(page);
    await app.open('#/spar?color=white');
    await expect(page.locator('.source-note')).toContainText('Lichess players (1600–2199; blitz, rapid, classical) choose');
    await playMove(page, 'e2e4');
    await expect(page.locator('.scoresheet .sheet-move')).toHaveCount(2);
    await expect(page.locator('.source-note')).toContainText(/^Lichess players chose 1\.\.\.\S+: played in [\d.]+% of [\d.]+k games/);
    expect(asked.filter((m) => m.type === REQUEST.BESTMOVE)).toHaveLength(0);

    // Twelve moves in, the database has no games: Stockfish takes over and says so.
    await app.open(`#/spar?color=white&fen=${encodeURIComponent('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 12')}`);
    await playMove(page, 'e2e4');
    await expect(page.locator('.source-note')).toHaveText('New position: Lichess players have no games from here, so Stockfish took over at 1800 Elo.');
    await expect(page.locator('.scoresheet .sheet-move')).toHaveCount(2);
    await playMove(page, 'd2d4');
    await expect(page.locator('.scoresheet .sheet-move')).toHaveCount(4);
    await expect(page.locator('.source-note')).toHaveText('Stockfish is playing at 1800 Elo: Lichess players have no games from here.');
    expect(asked.filter((m) => m.type === REQUEST.BESTMOVE)).toHaveLength(2);
  });

  test('Surprise: a popular Lichess reply your repertoire skips', async ({ page, app }) => {
    await app.api('PUT', '/api/settings', { figurines: false });
    await fakeEngine(page, { evaluate: (msg) => scored(msg.moves[0], { [msg.moves[0]]: 30 })(msg) });
    const rep = await app.api('POST', '/api/repertoires', { name: 'Open games', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
    await app.open(`#/surprise/${rep.id}`);
    await expect(page.locator('.prompt')).toContainText(/^1\.\.\.\S+ is not in your repertoire/);
    await expect(page.locator('.line-sub')).toHaveText('What Lichess players at your level play');
    await expect(page.locator('.puzzle-facts')).toContainText('of the games here');
    await playMove(page, 'd2d4');
    await expect(page.locator('.feedback')).toContainText('2.d4: Stockfish’s choice too (+0.30).');
  });
});

test('Spar without a Lichess account: Stockfish plays and the page says why', async ({ page, app }) => {
  await fakeEngine(page);
  await app.open('#/spar?color=white');
  await playMove(page, 'e2e4');
  await expect(page.locator('.source-note')).toContainText('connect a Lichess account first. Stockfish is playing instead, at 1800 Elo.');
  await expect(page.locator('.source-note a')).toHaveAttribute('href', '#/lichess');
  await expect(page.locator('.scoresheet .sheet-move')).toHaveCount(2);
  await playMove(page, 'd2d4');
  await expect(page.locator('.scoresheet .sheet-move')).toHaveCount(4);
  await expect(page.locator('.source-note')).toHaveText('Stockfish is playing at 1800 Elo: Lichess could not be asked.');
});

test('Play it out: keep the position after a line, then see your biggest slip', async ({ page, app }) => {
  await app.api('PUT', '/api/settings', { figurines: false, playOutMoves: 2, sparOpponent: 'engine' });
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 *' });
  const afterE5 = fenAfter(['e4', 'e5']);
  await fakeEngine(page, {
    // The line leaves you at +0.50 and you end at +0.40; 3.d4 was a slip of 1.8 pawns.
    evaluate: (msg) => (msg.moves.length
      ? scored('b1c3', { b1c3: 30, d2d4: -150, g1f3: 30 })(msg)
      : { best: { move: 'b1c3', score: { cp: msg.fen === afterE5 ? 50 : 40 }, pv: [] }, moves: [] }),
    analyse: () => [{ multipv: 1, depth: 12, score: { cp: 50 }, pv: ['g1f3'] }],
  });
  const line = buildRepertoire(rep).lines[0];
  await app.open(`#/train/${rep.id}/practice/${line.id}`);
  await playLine(page, ['e2e4']);
  await page.getByRole('link', { name: 'Play it out' }).click();

  await expect(page.locator('.mode-tag')).toHaveText('Play it out · 0 of 2');
  await expect(page.locator('.goal-box')).toContainText('Stockfish rates it +0.50 for you.');
  await expect(page.getByRole('button', { name: 'Take back' })).toBeHidden();
  await playMove(page, 'g1f3');
  await expect(page.locator('.scoresheet .sheet-move')).toHaveCount(2);
  await playMove(page, 'd2d4');
  await expect(page.locator('.goal-box .fb')).toHaveText('You kept the position: +0.50 → +0.40.');
  await expect(page.locator('.goal-box .verdict')).toHaveText('Your biggest slip: 3.d4 gave away 1.8 pawns. Stockfish preferred 3.Nc3.');
  await expect(page.locator('.sheet-move.slip')).toHaveText('d4');
  await expect(page.locator('.prompt')).toContainText('Position kept');

  await page.getByRole('button', { name: 'Keep playing' }).click();
  await expect(page.locator('.mode-tag')).toHaveText('Spar');
  await expect(page.getByRole('button', { name: 'Take back' })).toBeVisible();
});

const AFTER_D6 = fenAfter(['e4', 'e5', 'Nf3', 'd6']);
const GAP = { fen: AFTER_D6, lineMoves: ['e2e4', 'e7e5', 'g1f3', 'd7d6'], startFen: START_FEN, san: 'd6', share: 0.09, games: 900, reach: 0.05 };

/** A white repertoire with one saved gap (2...d6), and Stockfish preferring 3.d4 there. */
async function gapDrill(page, app) {
  await app.api('PUT', '/api/settings', { figurines: false, surpriseBatch: 1 });
  const rep = await app.api('POST', '/api/repertoires', { name: 'Ruy Lopez', color: 'white', pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 *' });
  app.editRepertoire(rep.id, (r) => { r.gaps = { [positionKey(AFTER_D6)]: GAP }; });
  await fakeEngine(page, { evaluate: scored('d2d4', { d2d4: 60, b1c3: 40 }) });
  await app.open(`#/surprise/${rep.id}`);
  await expect(page.locator('.prompt')).toHaveText(/2\.\.\.d6 is not in your repertoire/);
  await expect(page.locator('.line-sub')).toHaveText('A popular reply the mistake finder spotted');
  return rep;
}

test('Surprise: a good answer to a saved gap joins the repertoire and answers the gap', async ({ page, app }) => {
  const rep = await gapDrill(page, app);
  await playMove(page, 'b1c3');
  await expect(page.locator('.feedback')).toHaveText('3.Nc3 is a good answer (+0.40). Stockfish’s best was 3.d4 (+0.60).');
  await page.getByRole('button', { name: 'Add my answer to the repertoire' }).click();
  await expect(page.getByRole('button', { name: 'In your repertoire' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Stockfish’s answer' })).toHaveCount(0);

  const saved = await app.api('GET', `/api/repertoires/${rep.id}`);
  expect(saved.pgn).toContain('[ChapterName "Answer to 2...d6"]');
  expect(saved.pgn).toContain('1. e4 e5 2. Nf3 d6 { Played in 9.0% of Lichess games here (1600–2199). } 3. Nc3 *');
  expect(saved.gaps).toEqual({});

  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.locator('.prompt')).toContainText('1 of 1 surprise answered well');
});

test('Surprise: a weak answer can be tried again, and only the first try counts', async ({ page, app }) => {
  await gapDrill(page, app);
  await playMove(page, 'h2h4');
  await expect(page.locator('.feedback')).toHaveText('3.h4 is a mistake here: it gives away 1.6 pawns (−1.00).');
  await page.getByRole('button', { name: 'Try again' }).click();
  await playMove(page, 'b1c3');
  await expect(page.locator('.feedback')).toContainText('3.Nc3 is a good answer');
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.locator('.prompt')).toContainText('0 of 1 surprise answered well');
});

test('Surprise: after a miss, Stockfish’s answer can be shown and added', async ({ page, app }) => {
  const rep = await gapDrill(page, app);
  await playMove(page, 'a2a3');
  await expect(page.locator('.feedback')).toContainText('3.a3 is a mistake here');
  await page.getByRole('button', { name: 'Show the answer' }).click();
  await expect(page.locator('.feedback')).toHaveText('Stockfish answers 3.d4 (+0.60).');
  await page.getByRole('button', { name: 'Add Stockfish’s answer' }).click();
  await expect(page.getByRole('button', { name: 'In your repertoire' })).toBeDisabled();
  expect((await app.api('GET', `/api/repertoires/${rep.id}`)).pgn).toContain('3. d4 *');
});

test('Surprise without Lichess: Stockfish finds a sound sideline your repertoire skips', async ({ page, app }) => {
  await app.api('PUT', '/api/settings', { figurines: false });
  const rep = await app.api('POST', '/api/repertoires', { name: 'Open games', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  await fakeEngine(page, {
    analyse: () => [
      { multipv: 1, depth: 12, score: { cp: 30 }, pv: ['e7e5'] }, // your book
      { multipv: 2, depth: 12, score: { cp: 45 }, pv: ['c7c5'] },
      { multipv: 3, depth: 12, score: { cp: 300 }, pv: ['g7g5'] }, // a blunder, not a surprise
    ],
  });
  await app.open(`#/rep/${rep.id}`);
  await page.getByRole('link', { name: /^Surprise drills/ }).click();
  await expect(page.locator('.prompt')).toHaveText(/1\.\.\.c5 is not in your repertoire/);
  await expect(page.locator('.surprise-facts')).toHaveText('Stockfish rates this move as sound, and your repertoire has no answer to it.');
});
