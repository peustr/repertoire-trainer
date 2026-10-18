// #6: links into Explore must survive a reload or a bookmark.

import { test, expect, playMove } from './fixtures.mjs';
import { buildRepertoire } from '../../public/js/repertoire.js';

test('the Explore link after a trained line opens the same move after a reload', async ({ page, app }) => {
  // The library parses both repertoires, so the second one's moves are not the first parsed.
  await app.seedSample('caro-kann-black.pgn', 'Caro-Kann');
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const line = buildRepertoire(rep).lines[0];
  const mine = line.nodes.filter((n) => n.color === 'w');

  await app.open('#/');
  await expect(page.locator('.reprow')).toHaveCount(2);
  await page.evaluate(([id, lineId]) => { location.hash = `#/train/${id}/practice/${lineId}`; }, [rep.id, line.id]);
  for (let i = 0; i < mine.length; i++) {
    await expect(page.locator('.move-dots li.current')).toHaveCount(1);
    await playMove(page, mine[i].uci);
    await expect(page.locator('.move-dots li.right')).toHaveCount(i + 1);
  }

  await page.getByRole('link', { name: 'Explore', exact: true }).click();
  const where = page.locator('.where-main');
  await expect(where).toContainText('After');
  const atEndOfLine = await where.textContent();

  await page.reload();
  await expect(where).toHaveText(atEndOfLine);
});
