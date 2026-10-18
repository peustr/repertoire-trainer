// @ts-check
// #10 and #23: an action that fails must say so, and no error may vanish silently.

import { test, expect } from './fixtures.mjs';
import { START_FEN as START } from '../../public/js/constants.js';

const fail = (message) => ({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: message }) });

test('a delete that fails says so and keeps the repertoire', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  await app.open(`#/rep/${rep.id}`);
  await page.route(`**/api/repertoires/${rep.id}`, (route) => (route.request().method() === 'DELETE' ? route.fulfill(fail('Disk is full')) : route.continue()));

  await page.locator('section.tools').getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Delete' }).click();

  await expect(page.locator('.toast')).toContainText('Disk is full');
  await expect(page).toHaveURL(new RegExp(`#/rep/${rep.id}$`));
  await expect(page.locator('section.tools').getByRole('button', { name: 'Delete' })).toBeEnabled();
});

test('dismissing a gap removes it, on the page and on disk', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const after = 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';
  app.editRepertoire(rep.id, (r) => {
    r.gaps = {
      [after.split(' ').slice(0, 4).join(' ')]: {
        fen: after, beforeFen: START, startFen: START, lineMoves: ['e2e4', 'e7e5', 'g1f3', 'd7d6'],
        san: 'd6', share: 0.2, games: 1000, reach: 0.2, bestReplySan: 'd4',
      },
    };
  });
  await app.open(`#/rep/${rep.id}`);
  const gaps = page.locator('.gaps li');
  await expect(gaps).toHaveCount(1);

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(gaps).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.gaps li')).toHaveCount(0);
});

test('restoring defaults that cannot be saved says so', async ({ page, app }) => {
  await app.open('#/settings/training');
  await page.route('**/api/settings', (route) => (route.request().method() === 'PUT' ? route.fulfill(fail('Settings are read-only')) : route.continue()));

  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Restore defaults' }).click();
  await expect(page.locator('.toast')).toContainText('Settings are read-only');
});

test('an unexpected error in the background is shown, not swallowed', async ({ page, app }) => {
  await app.open('#/');
  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- the point of the test
  await page.evaluate(() => { Promise.reject(new Error('Something broke in the background')); });
  await expect(page.locator('.toast')).toContainText('Something broke in the background');
});
