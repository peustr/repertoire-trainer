// Editing a repertoire while it changes elsewhere: the edit form names the version it
// started from, so a chapter added meanwhile (a Surprise answer, a puzzle's line) is never
// written over. The user is told, and their text stays in the form.

import { test, expect } from './fixtures.mjs';

test('an edit opened before a chapter was added elsewhere is refused, and loses nothing', async ({ page, app }) => {
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  await app.open(`#/edit/${rep.id}`);
  const pgn = page.locator('#rep-pgn');
  await expect(pgn).toHaveValue('1. e4 e5 2. Nf3 *');

  await app.api('POST', `/api/repertoires/${rep.id}/lines`, { pgn: '1. d4 d5 2. c4 *' }); // from another tab
  await pgn.fill('1. e4 e5 2. Nf3 Nc6 3. Bb5 *');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.toast')).toContainText('This repertoire changed in another tab or window while you were editing it.');
  await expect(pgn).toHaveValue('1. e4 e5 2. Nf3 Nc6 3. Bb5 *'); // still there to copy
  expect((await app.api('GET', `/api/repertoires/${rep.id}`)).pgn).toContain('1. d4 d5 2. c4 *');

  await page.reload(); // the page now edits the latest version, which saves
  await expect(pgn).toHaveValue(/1\. d4 d5 2\. c4 \*/);
  await pgn.fill('1. e4 e5 2. Nf3 Nc6 3. Bb5 *\n\n1. d4 d5 2. c4 *');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`#/rep/${rep.id}$`));
  expect((await app.api('GET', `/api/repertoires/${rep.id}`)).pgn).toContain('3. Bb5');
});
