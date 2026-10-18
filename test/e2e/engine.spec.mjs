// #11: when the engine never answers, or the connection drops, the page says so
// instead of showing "Thinking…" forever.

import { test, expect } from './fixtures.mjs';

/** Replace the engine WebSocket with a fake that greets and then reacts to "analyse" as told. */
async function fakeEngineSocket(page, onAnalyse) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.send(JSON.stringify({ type: 'hello', engine: null }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'analyse') onAnalyse(ws, msg);
    });
  });
}

test('an analysis the engine never answers ends with a message', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  await fakeEngineSocket(page, () => {}); // silence
  await app.open('#/');
  await page.evaluate((url) => import(url).then((m) => m.setRequestLimits({ request: 1000 })), '/js/engine-client.js');
  await page.evaluate((id) => { location.hash = `#/explore/${id}`; }, rep.id);

  await expect(page.locator('.engine-box')).toContainText('did not answer in time', { timeout: 10000 });
});

test('an analysis cut off by a lost connection ends with a message', async ({ page, app }) => {
  const rep = await app.seedSample('italian-game-white.pgn', 'Italian');
  await fakeEngineSocket(page, (ws) => ws.close());
  await app.open(`#/explore/${rep.id}`);

  await expect(page.locator('.engine-box')).toContainText('Lost connection');
});
