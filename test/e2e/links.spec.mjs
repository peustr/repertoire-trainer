// #6: links into Explore must survive a reload or a bookmark.

import { test, expect, playLine } from './fixtures.mjs';
import { buildRepertoire } from '../../public/js/repertoire.js';
import { must } from '../helpers/must.mjs';

test('the Explore link after a trained line opens the same move after a reload', async ({ page, app }) => {
  // The library parses both repertoires, so the second one's moves are not the first parsed.
  await app.seedSample('caro-kann-black.pgn', 'Caro-Kann');
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const line = buildRepertoire(rep).lines[0];
  const mine = line.nodes.filter((n) => n.color === 'w').map((n) => n.uci);

  await app.open('#/');
  await expect(page.locator('.reprow')).toHaveCount(2);
  await page.evaluate(([id, lineId]) => { location.hash = `#/train/${id}/practice/${lineId}`; }, [rep.id, line.id]);
  await playLine(page, mine);

  await page.getByRole('link', { name: /^Explore this line/ }).click();
  const where = page.locator('.where-main');
  await expect(where).toContainText('After');
  const atEndOfLine = await where.textContent();

  await page.reload();
  await expect(where).toHaveText(must(atEndOfLine));
});
