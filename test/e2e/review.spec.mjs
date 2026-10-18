// A review session end to end: a mistake, a hint and right answers must reach the
// schedule as session.js says. Guards the trainer's wiring of those rules.

import { test, expect, playMove } from './fixtures.mjs';
import { buildRepertoire } from '../../public/js/repertoire.js';

test('a review with a mistake and a hint updates the schedule', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  const line = buildRepertoire(rep).lines[0];
  const mine = line.nodes.filter((n) => n.color === 'w').map((n) => n.uci);
  const keys = line.cardKeys;
  const dueAnHourAgo = { level: 3, due: Date.now() - 3600e3, reps: 3, lapses: 0 };
  app.editRepertoire(rep.id, (r) => { r.cards = Object.fromEntries(keys.map((k) => [k, { ...dueAnHourAgo }])); });

  await app.open(`#/train/${rep.id}/review/${line.id}`);
  // The scoresheet gains a move only once the trainer has accepted it. (Dots are no
  // good here: a mistake or a hint marks the dot before the right move is played.)
  const accepted = page.locator('.scoresheet .sheet-move.mine');
  for (let i = 0; i < mine.length; i++) {
    await expect(page.locator('.move-dots li.current')).toHaveCount(1);
    if (i === 0) {
      await playMove(page, 'a2a3'); // not in the repertoire: a mistake
      await expect(page.locator('.feedback')).toContainText('Not');
      await expect(page.locator('.move-dots li.current')).toHaveCount(1); // the book move is asked again
    }
    if (i === 1) await page.getByRole('button', { name: 'Hint' }).click();
    await playMove(page, mine[i]);
    await expect(accepted).toHaveCount(i + 1);
  }
  await expect(page.locator('ul.outcomes li.wrong')).toHaveCount(2);

  const cards = (await app.api('GET', `/api/repertoires/${rep.id}`)).cards;
  expect(cards[keys[0]].level).toBe(1); // the mistake
  expect(cards[keys[1]].level).toBe(1); // the hint ("a hint counts as a mistake" is on by default)
  for (const k of keys.slice(2)) expect(cards[k].level).toBe(4); // right and due: one level up
});
