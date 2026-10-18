// #9: answers given while the server cannot be reached are kept in the browser
// and saved once it answers again, even across a reload.

import { test, expect, playLine } from './fixtures.mjs';
import { buildRepertoire } from '../../public/js/repertoire.js';

test('answers survive an unreachable server and a reload', async ({ page, app }) => {
  await app.api('PUT', '/api/settings', { learnRecall: false }); // one pass per new line
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const line = buildRepertoire(rep).lines[0];
  const progressOf = async () => Object.keys((await app.api('GET', `/api/repertoires/${rep.id}`)).cards || {}).length;

  let serverDown = true;
  await page.route(`**/api/repertoires/${rep.id}/progress`, (route) => (serverDown ? route.abort('connectionrefused') : route.continue()));

  await app.open(`#/train/${rep.id}/learn/${line.id}`);
  await playLine(page, line.nodes.filter((n) => n.color === 'w').map((n) => n.uci));
  await expect(page.locator('.toast')).toContainText('kept in this browser');

  // Reload while the server is still unreachable: nothing is lost, and the page
  // already shows the line as learned.
  await page.evaluate((id) => { location.hash = `#/rep/${id}`; }, rep.id);
  await page.reload();
  await expect(page.locator('table.lines tbody tr').first()).not.toHaveClass(/is-new/);
  expect(await progressOf()).toBe(0);

  serverDown = false;
  await expect.poll(progressOf, { timeout: 20000 }).toBe(line.cardKeys.length);
  await expect(page.locator('.toast')).toContainText('Your progress is saved');
});

test('answers are saved when the browser storage will not take them', async ({ page, app }) => {
  await app.api('PUT', '/api/settings', { learnRecall: false });
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const line = buildRepertoire(rep).lines[0];
  const progressOf = async () => Object.keys((await app.api('GET', `/api/repertoires/${rep.id}`)).cards || {}).length;

  // A full localStorage: every write is refused, as Chrome does once the quota is used.
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  });

  await app.open(`#/train/${rep.id}/learn/${line.id}`);
  await playLine(page, line.nodes.filter((n) => n.color === 'w').map((n) => n.uci));
  await expect.poll(progressOf, { timeout: 10000 }).toBe(line.cardKeys.length);
});

test('with the server unreachable and the browser storage full, it says to keep the tab open', async ({ page, app }) => {
  await app.api('PUT', '/api/settings', { learnRecall: false });
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const line = buildRepertoire(rep).lines[0];
  const progressOf = async () => Object.keys((await app.api('GET', `/api/repertoires/${rep.id}`)).cards || {}).length;

  let serverDown = true;
  await page.route(`**/api/repertoires/${rep.id}/progress`, (route) => (serverDown ? route.abort('connectionrefused') : route.continue()));
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  });

  await app.open(`#/train/${rep.id}/learn/${line.id}`);
  await playLine(page, line.nodes.filter((n) => n.color === 'w').map((n) => n.uci));
  // A reload would lose these answers, so "kept in this browser" would be wrong.
  await expect(page.locator('.toast').filter({ hasText: 'Keep this tab open' })).toBeVisible();

  serverDown = false;
  await expect.poll(progressOf, { timeout: 20000 }).toBe(line.cardKeys.length);
});
