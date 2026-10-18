// Shared fixtures for the browser tests.
//
// `app` starts the real server for one test, on a free port with a throwaway data
// folder, and offers helpers to seed data through the API. `playMove` moves a piece
// on the chessground board by clicking its square and then the destination.

import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';

const SAMPLES = fileURLToPath(new URL('../../samples', import.meta.url));

export const test = base.extend({
  app: async ({ page }, use) => {
    const server = await startServer();
    const api = async (method, url, body) => {
      const res = await fetch(server.base + url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${await res.text()}`);
      return res.json();
    };
    const app = {
      ...server,
      api,
      /** Create a repertoire from a file in samples/. */
      seedSample: (file, name = file) => {
        const pgn = fs.readFileSync(path.join(SAMPLES, file), 'utf8');
        return api('POST', '/api/repertoires', { name, color: /black/.test(file) ? 'black' : 'white', pgn });
      },
      /** Change a stored repertoire file directly, for data the API cannot create (gaps, puzzles). */
      editRepertoire: (id, change) => {
        const file = path.join(server.dataDir, 'repertoires', `${id}.json`);
        const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
        change(rep);
        fs.writeFileSync(file, JSON.stringify(rep, null, 2));
      },
      /** Open a route of the app, e.g. '#/settings'. */
      open: (hash = '#/') => page.goto(`${server.base}/${hash}`),
    };
    // Fast, quiet training: opponent moves play at once, no sounds or animation.
    await api('PUT', '/api/settings', { moveDelay: 0, knownDelay: 0, animation: 0, sounds: false });
    try {
      await use(app);
    } finally {
      server.stop();
    }
  },
});

export { expect };

/**
 * Click-move a piece on the board, e.g. playMove(page, 'e2e4'). The board is measured
 * right before each click, because the page can shift it (a scrollbar appearing when
 * Stockfish's verdict lengthens the panel).
 */
export async function playMove(page, uci, orientation = 'white') {
  const board = page.locator('cg-board').first();
  const clickSquare = async (square) => {
    const { width } = await board.boundingBox();
    const size = width / 8;
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]);
    const col = orientation === 'white' ? file : 7 - file;
    const row = orientation === 'white' ? 8 - rank : rank - 1;
    await board.click({ position: { x: (col + 0.5) * size, y: (row + 0.5) * size } });
  };
  await clickSquare(uci.slice(0, 2));
  await clickSquare(uci.slice(2, 4));
}

/** In the trainer, play your moves of a line (UCI), waiting for each prompt. */
export async function playLine(page, moves, orientation = 'white') {
  for (let i = 0; i < moves.length; i++) {
    await expect(page.locator('.move-dots li.current')).toHaveCount(1);
    await playMove(page, moves[i], orientation);
    await expect(page.locator('.move-dots li.right')).toHaveCount(i + 1);
  }
}

/** Count document-level keydown handlers that are still attached (views add and remove these). */
export async function trackKeyHandlers(page) {
  await page.addInitScript(() => {
    const live = new Set();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, fn, opts) => { if (type === 'keydown') live.add(fn); return add(type, fn, opts); };
    document.removeEventListener = (type, fn, opts) => { if (type === 'keydown') live.delete(fn); return remove(type, fn, opts); };
    window.__liveKeyHandlers = () => live.size;
  });
  return () => page.evaluate(() => window.__liveKeyHandlers());
}
