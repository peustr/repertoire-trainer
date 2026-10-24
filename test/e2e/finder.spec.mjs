// The opponent-mistake finder opens over the page it was started from. Closing it after a
// search found something must leave a board page as it was (a training session in
// progress, a position in Explore); only the repertoire page redraws, to list what the
// search saved. The engine socket is faked, so the search finds one scripted puzzle.

import { test, expect, playLine, playMove, fakeEngine } from './fixtures.mjs';
import { buildRepertoire } from '../../public/js/repertoire.js';
import { START_FEN } from '../../public/js/constants.js';

const puzzle = {
  id: 'pz-f6',
  createdAt: '2026-10-01T00:00:00.000Z',
  fen: 'rnbqkbnr/ppppp1pp/5p2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  beforeFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  startFen: START_FEN,
  lineMoves: ['e2e4', 'f7f6'],
  searchRoot: START_FEN,
  pathSan: ['e4', 'f6'],
  mistake: { uci: 'f7f6', san: 'f6', share: 0.08, games: 800, positionGames: 10000, averageRating: 1650, yourScore: 60, gain: 200 },
  reach: 0.08,
  filters: { speeds: 'blitz', ratings: '1600' },
  solution: ['d1h5'],
  score: { cp: 250 },
  theme: { key: 'attack', label: 'Attack on the king' },
};

/** A search that finds the puzzle and, as the server does, saves it to the repertoire. */
function findsPuzzle(app, repId) {
  return () => {
    app.editRepertoire(repId, (r) => { r.puzzles = { [puzzle.id]: puzzle }; });
    return { events: [{ kind: 'found', puzzle }], result: { puzzles: [puzzle.id] } };
  };
}

/** Run the finder from the page's "Find opponent mistakes", wait for its find, and close it. */
async function findAndClose(page) {
  await page.getByRole('button', { name: /Find opponent mistakes/ }).first().click();
  const dialog = page.locator('dialog.finder');
  await expect(dialog).toContainText('Mistakes found (1)');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('with Lichess connected', () => {
  test.use({ lichess: true });

  test('closing the finder leaves a training session where it was', async ({ page, app }) => {
    const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
    await fakeEngine(page, { search: findsPuzzle(app, rep.id) });
    const line = buildRepertoire(rep).lines[0];
    const mine = line.nodes.filter((n) => n.color === 'w').map((n) => n.uci);

    await app.open(`#/train/${rep.id}/practice/${line.id}`);
    await playLine(page, mine.slice(0, 2));
    const yourTurn = page.locator('.move-dots li.current');
    await expect(yourTurn).toHaveCount(1); // the opponent has replied: your third move is asked
    await findAndClose(page);

    const accepted = page.locator('.scoresheet .sheet-move.mine');
    await expect(accepted).toHaveCount(2); // the line goes on from where it was
    await expect(yourTurn).toHaveCount(1);
    await playMove(page, mine[2]);
    await expect(accepted).toHaveCount(3);
  });

  test('closing the finder keeps the position in Explore', async ({ page, app }) => {
    const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
    await fakeEngine(page, { search: findsPuzzle(app, rep.id) });

    await app.open(`#/explore/${rep.id}`);
    await playMove(page, 'a2a3'); // off the book
    const where = page.locator('.where-main');
    await expect(where).toHaveText('Off-book analysis');
    await findAndClose(page);
    await expect(where).toHaveText('Off-book analysis');
  });

  test('the repertoire page lists what the finder saved once it closes', async ({ page, app }) => {
    const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
    await fakeEngine(page, { search: findsPuzzle(app, rep.id) });

    await app.open(`#/rep/${rep.id}`);
    const opponents = page.locator('.opponents');
    await expect(opponents).toContainText('Punish what your opponents actually play');
    await findAndClose(page);
    await expect(opponents).toContainText('1 opponent mistake to punish');
  });

  for (const [ended, says] of [
    ['puzzles', 'Stopped at 1 puzzle, the limit set under “Stop after finding” in Search settings.'],
    ['budget', 'Search budget used up.'],
    ['searched', 'Searched every popular line within reach.'],
  ]) {
    test(`a search that ended with "${ended}" says why it stopped`, async ({ page, app }) => {
      const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
      const finds = findsPuzzle(app, rep.id);
      await fakeEngine(page, { search: () => { const { events, result } = finds(); return { events, result: { ...result, ended } }; } });

      await app.open(`#/rep/${rep.id}`);
      await page.getByRole('button', { name: /Find opponent mistakes/ }).first().click();
      await expect(page.locator('dialog.finder .finder-looking')).toContainText(says);
    });
  }
});
