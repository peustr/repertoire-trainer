// The Lichess page after a sign-in: Lichess sends the user back to #/lichess?connected=1
// (or ?error=…). That answer is shown once; left in the address, every redraw of the page
// would show it again, over the message of whatever the user just did.

import { test, expect } from './fixtures.mjs';

/** Record every message the page's toast shows, in order. */
async function recordToasts(page) {
  await page.addInitScript(() => {
    const shown = [];
    /** @type {any} */ (window).__toasts = shown;
    new MutationObserver((records) => {
      for (const r of records) if (r.target instanceof Element && r.target.classList.contains('toast')) shown.push(r.target.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => /** @type {any} */ (window).__toasts);
}

test.describe('with Lichess connected', () => {
  test.use({ lichess: true });

  test('the sign-in is confirmed once, and the next action keeps its own message', async ({ page, app }) => {
    const toasts = await recordToasts(page);
    await app.open('#/lichess?connected=1');
    await expect(page.locator('.toast')).toHaveText('Connected as MockPlayer');
    await expect(page).toHaveURL(/#\/lichess$/);

    const redrawn = page.waitForResponse((res) => res.url().endsWith('/api/lichess/status'));
    await page.getByRole('button', { name: 'Use opponents rated 1400–1999' }).click();
    await redrawn;
    await page.waitForTimeout(300); // the page finishes drawing itself again
    expect(await toasts()).toEqual(['Connected as MockPlayer', 'Opponents set to 1400–1999']);
  });
});

test('a sign-in that failed says why once, and not after a reload', async ({ page, app }) => {
  await app.open(`#/lichess?error=${encodeURIComponent('Lichess sign-in was cancelled (access_denied).')}`);
  const notice = page.locator('.notice.warn');
  await expect(notice).toHaveText('Lichess sign-in was cancelled (access_denied).');
  await expect(page).toHaveURL(/#\/lichess$/);
  await page.reload();
  await expect(page.locator('.page.lichessview')).toBeVisible();
  await expect(notice).toHaveCount(0);
});
