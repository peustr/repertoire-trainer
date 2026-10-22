// The trainer's session around "Retry line": a retry is extra practice, so the session
// still goes on to the line that was next, and the retry counts neither in the session's
// summary nor in the day's activity. Then hints: one while the arrow already shows the
// move costs nothing, and Ctrl+H belongs to the browser, not to the Hint button.

import { test, expect, playLine, fakeEngine } from './fixtures.mjs';

test('retrying a line keeps the next line of the session, and does not count', async ({ page, app }) => {
  await fakeEngine(page);
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 (2. Bc4) *' });

  await app.open(`#/train/${rep.id}/learn`);
  const tag = page.locator('.mode-tag');
  await expect(tag).toContainText('1 of 2');
  await playLine(page, ['e2e4', 'g1f3']); // shown with arrows
  await playLine(page, ['e2e4', 'g1f3']); // from memory
  await page.getByRole('button', { name: 'Retry line' }).click();
  await expect(tag).toContainText('1 of 2'); // still the first line
  await playLine(page, ['e2e4', 'g1f3']);

  const nextLine = page.getByRole('button', { name: 'Next line' });
  await expect(nextLine).toBeVisible(); // not "Finish session": the second line is still to come
  await nextLine.click();
  await expect(page.locator('.line-sub')).toContainText('Line 2 of 2');
  await expect(tag).toContainText('2 of 2');
  await playLine(page, ['f1c4']); // 1.e4 is known by now and plays itself
  await playLine(page, ['f1c4']);
  await page.getByRole('button', { name: 'Finish session' }).click();
  await expect(page.locator('.prompt')).toContainText('2 lines, 3 moves right');

  // Only the two passes from memory reach the day's tally.
  await expect.poll(async () => (await app.api('GET', `/api/repertoires/${rep.id}`)).history)
    .toEqual([expect.objectContaining({ correct: 3, wrong: 0, lines: 2 })]);
});

test('a hint while the arrow shows the move costs nothing', async ({ page, app }) => {
  await app.api('PUT', '/api/settings', { learnRecall: false }); // the arrowed pass is the one graded
  await fakeEngine(page);
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  await app.open(`#/train/${rep.id}/learn`);
  await expect(page.locator('.move-dots li.current')).toHaveCount(1);
  await page.getByRole('button', { name: 'Hint' }).click();
  await expect(page.locator('.feedback')).toHaveText('Hint: move the highlighted piece.');
  await playLine(page, ['e2e4', 'g1f3']);
  await expect.poll(async () => Object.values((await app.api('GET', `/api/repertoires/${rep.id}`)).cards).map((c) => c.lapses))
    .toEqual([0, 0]);
});

test('Ctrl+H is left to the browser and takes no hint', async ({ page, app }) => {
  await fakeEngine(page);
  const rep = await app.api('POST', '/api/repertoires', { name: 'Kings pawn', color: 'white', pgn: '1. e4 e5 2. Nf3 *' });
  await app.open(`#/train/${rep.id}/learn`);
  await playLine(page, ['e2e4', 'g1f3']); // shown with arrows
  await expect(page.locator('.mode-tag')).toContainText('from memory');
  await expect(page.locator('.move-dots li.current')).toHaveCount(1);
  await page.keyboard.press('Control+h');
  await expect(page.locator('.feedback')).toBeEmpty();
  await playLine(page, ['e2e4', 'g1f3']);
});
