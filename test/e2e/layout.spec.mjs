// The layout around the board and on the control pages: every tool and training mode
// says what it does, the explorer asks Lichess only when it is on screen, and Settings
// shows which options differ from their defaults.

import { test, expect, playLine } from './fixtures.mjs';
import { buildRepertoire } from '../../public/js/repertoire.js';

test('the repertoire page lists every training mode with what it does, the next one first', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  await app.open(`#/rep/${rep.id}`);

  const modes = page.locator('.modes .mode');
  await expect(modes.locator('.mode-name')).toHaveText([/^Review/, /^Learn/, /^Practise/, /^Puzzles/, /^Surprise drills/, /^Spar/, /^Explore/]);
  for (const desc of await modes.locator('.mode-desc').allTextContents()) expect(desc.length).toBeGreaterThan(20);
  // Nothing learned yet: Review waits (not a link), Learn is the one to do next.
  await expect(modes.filter({ hasText: /^Review/ })).toHaveClass(/idle/);
  await expect(page.locator('div.mode', { hasText: /^Review/ })).toContainText('Nothing learned yet');
  const learn = modes.filter({ hasText: /^Learn/ });
  await expect(learn).toHaveClass(/primary/);
  await learn.click();
  await expect(page).toHaveURL(new RegExp(`#/train/${rep.id}/learn$`));
});

test('the trainer lists its tools with a sentence each, and offers the end-of-line ones when the line ends', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const line = buildRepertoire(rep).lines[0];
  await app.open(`#/train/${rep.id}/practice/${line.id}`);

  const tools = page.locator('.tool-list .tool');
  await expect(tools.locator('.tool-title')).toHaveText(['Find opponent mistakes']);
  await playLine(page, line.nodes.filter((n) => n.color === 'w').map((n) => n.uci));
  await expect(tools.locator('.tool-title')).toHaveText(['Play it out', 'Spar from here', 'Find opponent mistakes', 'Explore this line']);
  for (const desc of await tools.locator('.tool-desc').allTextContents()) expect(desc.length).toBeGreaterThan(20);
  await expect(page.getByRole('link', { name: /^Play it out/ })).toHaveAttribute('href', /^#\/spar\?.*goal=hold/);
});

test('Settings marks a changed option and counts it in the section list until it is back at its default', async ({ page, app }) => {
  await app.open('#/settings/training');
  const row = page.locator('.setting[data-key="learnRecall"]');
  const badge = page.locator('.settings-tab', { hasText: 'Training' }).locator('.tab-badge');
  await expect(row).not.toHaveClass(/changed/);
  await expect(badge).toHaveText('2'); // the fixture's instant reply speeds

  await page.locator('#set-learnRecall').uncheck();
  await expect(page.locator('.settings-head')).toContainText('All changes saved');
  await expect(row).toHaveClass(/changed/);
  await expect(badge).toHaveText('3');

  await row.getByRole('button', { name: 'Use default' }).click();
  await expect(page.locator('#set-learnRecall')).toBeChecked();
  await expect(badge).toHaveText('2');
  await expect(row).not.toHaveClass(/changed/);
  expect((await app.api('GET', '/api/settings')).learnRecall).toBe(true);
});

test.describe('with Lichess connected', () => {
  test.use({ lichess: true });

  test('Explore asks Lichess for the opening explorer only while its tab is open', async ({ page, app }) => {
    const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
    const lookups = [];
    page.on('request', (req) => { if (req.url().includes('/api/lichess/explorer')) lookups.push(req.url()); });
    await app.open(`#/explore/${rep.id}`);
    await expect(page.locator('.where-main')).toHaveText('Starting position');

    // Moving through the tree with the Moves tab open asks Lichess nothing.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.where-main')).toContainText('After 1.');
    await page.waitForTimeout(600); // longer than the explorer's 250 ms pause
    expect(lookups).toHaveLength(0);

    await page.getByRole('tab', { name: 'Opening explorer' }).click();
    await expect(page.locator('.ex-row').first()).toBeVisible();
    expect(lookups).toHaveLength(1);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => lookups.length).toBe(2);

    await page.getByRole('tab', { name: 'Moves' }).click();
    await expect(page.locator('#pane-explorer')).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    expect(lookups).toHaveLength(2);
  });
});
