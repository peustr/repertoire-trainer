// Explore's keyboard: the shortcuts work whichever way the user types them.

import { test, expect, fakeEngine } from './fixtures.mjs';

test('F and f both flip the board', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  await fakeEngine(page);
  await app.open(`#/explore/${rep.id}`);
  const board = page.locator('.cg-wrap');
  await expect(board).toHaveClass(/orientation-white/);
  await page.keyboard.press('Shift+F');
  await expect(board).toHaveClass(/orientation-black/);
  await page.keyboard.press('f');
  await expect(board).toHaveClass(/orientation-white/);
});
