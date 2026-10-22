// Explore's keyboard: the shortcuts work whichever way the user types them, and leave the
// browser's own (with Ctrl, Alt or Cmd) alone.

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

test('with Ctrl, Alt or Cmd held, the keys are left to the browser', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  await fakeEngine(page);
  await app.open(`#/explore/${rep.id}`);
  const board = page.locator('.cg-wrap');
  const where = page.locator('.where-main');
  await expect(where).toHaveText('Starting position');
  for (const key of ['Control+f', 'Meta+f', 'Alt+ArrowRight', 'Control+ArrowRight']) {
    await page.keyboard.press(key);
    await expect(board, key).toHaveClass(/orientation-white/);
    await expect(where, key).toHaveText('Starting position');
  }
  await page.keyboard.press('ArrowRight');
  await expect(where).toContainText('After 1.');
});
