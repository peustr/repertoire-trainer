// Opponent-mistake puzzles: solving one and adding its line to the repertoire.

import { test, expect, playMove } from './fixtures.mjs';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
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
