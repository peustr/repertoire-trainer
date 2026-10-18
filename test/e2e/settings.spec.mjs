// Settings saved from the Settings page.

import { test, expect } from './fixtures.mjs';

test('changes made in two tabs both stick', async ({ app, page, context }) => {
  const other = await context.newPage();
  await app.open('#/settings/display');
  await other.goto(`${app.base}/#/settings/display`);
  await expect(page.locator('#set-coordinates')).toBeChecked();
  await expect(other.locator('#set-figurines')).toBeChecked();

  // The other tab still has the settings it loaded before this change.
  await page.locator('#set-coordinates').uncheck();
  await expect(page.locator('.settings-head')).toContainText('All changes saved');
  await other.locator('#set-figurines').uncheck();
  await expect(other.locator('.settings-head')).toContainText('All changes saved');

  const saved = await app.api('GET', '/api/settings');
  expect(saved.figurines).toBe(false);
  expect(saved.coordinates).toBe(false);
});
