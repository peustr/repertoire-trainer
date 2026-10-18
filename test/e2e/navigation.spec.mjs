// #5: a page whose data arrives late must not render on top of the page the
// user has already moved on to, or leave its keyboard handlers behind.

import { test, expect, trackKeyHandlers } from './fixtures.mjs';

test('switching pages quickly shows only the last page and leaves no handlers behind', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const liveKeyHandlers = await trackKeyHandlers(page);
  await app.open('#/lichess');
  await expect(page.locator('#main .page.lichessview')).toBeVisible();

  // Hold Explore's data back so it arrives after the Lichess page has rendered again.
  await page.route(`**/api/repertoires/${rep.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  const late = page.waitForResponse((res) => res.url().endsWith(`/api/repertoires/${rep.id}`));
  await page.evaluate((id) => {
    location.hash = `#/explore/${id}`;
    setTimeout(() => { location.hash = '#/lichess'; }, 0);
  }, rep.id);
  await late;
  await page.waitForTimeout(500); // the late view finishes rendering, wherever it renders

  await expect(page.locator('#main .page')).toHaveCount(1);
  await expect(page.locator('#main .page.lichessview')).toBeVisible();
  expect(await liveKeyHandlers()).toBe(0);
});
