// Opponent-mistake puzzles: solving one and adding its line to the repertoire, how many
// the repertoire page offers for a session, opening one chosen from the list, the gaps
// it lists, a move Stockfish cannot check, and skipping one while Stockfish is busy.

import { test, expect, playMove, fakeEngine } from './fixtures.mjs';
import { START_FEN as START } from '../../public/js/constants.js';
import { REQUEST } from '../../public/js/protocol.js';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_F6 = 'rnbqkbnr/ppppp1pp/5p2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

const puzzle = {
  id: 'pz-f6',
  createdAt: '2026-10-01T00:00:00.000Z',
  fen: AFTER_F6,
  beforeFen: AFTER_E4,
  startFen: START,
  lineMoves: ['e2e4', 'f7f6'],
  searchRoot: START,
  pathSan: ['e4', 'f6'],
  mistake: { uci: 'f7f6', san: 'f6', share: 0.08, games: 800, positionGames: 10000, averageRating: 1650, yourScore: 60, gain: 200 },
  reach: 0.08,
  filters: { speeds: 'blitz', ratings: '1600' },
  solution: ['d1h5'],
  score: { cp: 250 },
  theme: { key: 'attack', label: 'Attack on the king' },
};

test('adding a solved puzzle to the repertoire saves it once, in one request', async ({ app, page }) => {
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  app.editRepertoire(rep.id, (r) => { r.puzzles = { [puzzle.id]: puzzle }; });
  const writes = [];
  page.on('request', (req) => { if (req.method() !== 'GET' && req.url().includes('/api/repertoires/')) writes.push(`${req.method()} ${new URL(req.url()).pathname}`); });

  await app.open(`#/puzzles/${rep.id}`);
  await expect(page.locator('.prompt')).toContainText('Punish it');
  await playMove(page, 'd1h5');
  const add = page.getByRole('button', { name: 'Add line to repertoire' });
  await add.click();
  await expect(page.getByRole('button', { name: 'In your repertoire' })).toBeDisabled();

  const saved = await app.api('GET', `/api/repertoires/${rep.id}`);
  expect(saved.pgn.match(/\[Event "Punishing/g)).toHaveLength(1);
  expect(saved.pgn).toContain('1. e4 e5 2. Nf3 *');
  expect(saved.puzzles[puzzle.id].addedAt).toBeTruthy();
  expect(writes.filter((w) => !w.endsWith('/progress'))).toEqual([`POST /api/repertoires/${rep.id}/puzzles/${puzzle.id}/add-line`]);
});

test('the repertoire page offers as many puzzles as a session holds', async ({ app, page }) => {
  await app.api('PUT', '/api/settings', { puzzleBatch: 2 });
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  app.editRepertoire(rep.id, (r) => { r.puzzles = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { ...puzzle, id }])); });

  await app.open(`#/rep/${rep.id}`);
  const solve = page.getByRole('link', { name: 'Solve 2', exact: true });
  await expect(solve).toBeVisible();
  await solve.click();
  await expect(page.locator('.mode-tag')).toHaveText('Puzzle · 1 of 2');
});

test('a puzzle chosen from the list opens even before it is due', async ({ app, page }) => {
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  app.editRepertoire(rep.id, (r) => {
    r.puzzles = { [puzzle.id]: puzzle };
    r.cards = { [`pz|${puzzle.id}`]: { level: 2, due: Date.now() + 3 * 86400000, reps: 2, lapses: 0 } };
  });

  await app.open(`#/rep/${rep.id}`);
  await page.locator('.puzzle-list li').getByRole('link', { name: 'Solve' }).click();
  await expect(page.locator('.prompt')).toContainText('Punish it');
  await expect(page.locator('.line-sub')).toContainText('Level 2 · next in');
  await playMove(page, 'd1h5');
  await expect(page.locator('.prompt-sub')).toHaveText('Not due yet, so the schedule is unchanged.');
});

test('the repertoire page lists only the gaps your repertoire does not answer yet', async ({ app, page }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
  const gap = (uci, san, fen) => ({ fen, beforeFen: AFTER_NF3, startFen: START, lineMoves: ['e2e4', 'e7e5', 'g1f3', uci], san, share: 0.2, games: 1000, reach: 0.2 });
  app.editRepertoire(rep.id, (r) => {
    r.gaps = {
      d6: gap('d7d6', 'd6', 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3'),
      nc6: gap('b8c6', 'Nc6', 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'), // your main line by now
    };
  });

  await app.open(`#/rep/${rep.id}`);
  await expect(page.locator('.gaps li')).toHaveCount(1);
  await expect(page.locator('.gaps li')).toContainText('d6');
  await expect(page.locator('.mode', { hasText: 'Surprise drills' })).toContainText('1 saved gap');
});

for (const [why, evaluate] of /** @type {const} */ ([
  ['Stockfish fails', () => Promise.reject(new Error('Lost connection to the engine'))],
  ['Stockfish gives no scores', () => ({ best: { move: null, score: null, pv: [] }, moves: [] })],
])) {
  test(`a move Stockfish could not check is not a miss (${why})`, async ({ app, page }) => {
    await fakeEngine(page, { evaluate });
    const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
    app.editRepertoire(rep.id, (r) => { r.puzzles = { [puzzle.id]: puzzle }; });

    await app.open(`#/puzzles/${rep.id}`);
    await expect(page.locator('.prompt')).toContainText('Punish it');
    await playMove(page, 'd2d4');
    const feedback = page.locator('.feedback');
    await expect(feedback).toContainText('Stockfish could not check 2.d4, so it does not count against you.');
    if (why === 'Stockfish fails') await expect(feedback).toContainText('Lost connection to the engine');
    await expect(feedback).not.toContainText('The punishment is'); // the answer is not given away

    await playMove(page, 'd1h5');
    await expect(page.locator('.prompt-title')).toHaveText('Solved'); // not "with help"
    await expect.poll(async () => (await app.api('GET', `/api/repertoires/${rep.id}`)).cards).toEqual({ [`pz|${puzzle.id}`]: expect.objectContaining({ level: 1, lapses: 0 }) });
  });
}

for (const [verdict, cp] of /** @type {const} */ ([['accepts', 240], ['refuses', -50]])) {
  test(`Stockfish's verdict on a skipped puzzle (it ${verdict} the other move) leaves the next puzzle alone`, async ({ app, page }) => {
    let answer = () => {};
    const asked = await fakeEngine(page, {
      // Stockfish answers only once the puzzle has been skipped.
      evaluate: (msg) => new Promise((resolve) => {
        answer = () => resolve({
          best: { move: 'd1h5', score: { cp: 250 }, pv: ['d1h5'] },
          moves: [{ move: 'd1h5', score: { cp: 250 }, pv: [] }, { move: msg.moves[1], score: { cp }, pv: [] }],
        });
      }),
    });
    const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
    app.editRepertoire(rep.id, (r) => { r.puzzles = { a: { ...puzzle, id: 'a', reach: 0.5 }, b: { ...puzzle, id: 'b', reach: 0.1 } }; });

    await app.open(`#/puzzles/${rep.id}`);
    await expect(page.locator('.prompt')).toContainText('Punish it');
    await playMove(page, 'd2d4'); // not the solution: Stockfish is asked whether it wins anyway
    await expect.poll(() => asked.filter((m) => m.type === REQUEST.EVALUATE).length).toBe(1);
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.locator('.mode-tag')).toHaveText('Puzzle · 2 of 2');
    answer();

    await expect(page.locator('.prompt')).toContainText('Punish it'); // not solved for you
    await playMove(page, 'd1h5');
    await expect(page.locator('.prompt-title')).toHaveText('Solved'); // not "with help"
    await expect.poll(async () => (await app.api('GET', `/api/repertoires/${rep.id}`)).cards).toEqual({ 'pz|b': expect.objectContaining({ level: 1, lapses: 0 }) });
  });
}
