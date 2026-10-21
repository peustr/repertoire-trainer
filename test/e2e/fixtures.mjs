// Shared fixtures for the browser tests.
//
// `app` starts the real server for one test, on a free port with a throwaway data
// folder, and offers helpers to seed data through the API. With
// `test.use({ lichess: true })` it also starts the mock Lichess (test/mock-lichess.js)
// and connects the trainer to it. `playMove` moves a piece on the chessground board by
// clicking its square and then the destination. `fakeEngine` stands in for Stockfish.

import { test as base, expect } from '@playwright/test';
import { Chess } from 'chess.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { startMockLichess } from '../helpers/mock-lichess.mjs';
import { REQUEST, REPLY } from '../../public/js/protocol.js';

const SAMPLES = fileURLToPath(new URL('../../samples', import.meta.url));

/**
 * @typedef {Awaited<ReturnType<typeof startServer>> & {
 *   api: (method: string, url: string, body?: object) => Promise<any>,
 *   seedSample: (file: string, name?: string) => Promise<any>,
 *   editRepertoire: (id: string, change: (rep: any) => void) => void,
 *   open: (hash?: string) => Promise<unknown>,
 * }} App
 * @typedef {import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions} TestArgs
 * @typedef {import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions} WorkerArgs
 */

/** @type {import('@playwright/test').TestType<TestArgs & { app: App, lichess: boolean }, WorkerArgs>} */
export const test = base.extend({
  lichess: [false, { option: true }],
  app: async ({ page, lichess }, use) => {
    const mock = lichess ? await startMockLichess() : null;
    const server = await startServer(mock ? { env: { LICHESS_URL: mock.url, LICHESS_EXPLORER_URL: mock.url } } : {}).catch((err) => {
      if (mock) mock.stop();
      throw err;
    });
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
    try {
      // Fast, quiet training: opponent moves play at once, no sounds or animation.
      await api('PUT', '/api/settings', { moveDelay: 0, knownDelay: 0, animation: 0, sounds: false });
      if (mock) await api('POST', '/api/lichess/token', { token: 'lip_mockPersonalToken' }); // gitleaks:allow (fake token for the mock)
      await use(app);
    } finally {
      await server.stop();
      if (mock) mock.stop();
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

/**
 * Replace the engine WebSocket with a fake that answers the page's requests: bestmove
 * with the first legal move, evaluate and analyse as the test says, and the mistake
 * search with the events and result `search` gives (no events and an empty result by
 * default). Nothing waits on a real search. Returns every request the page sent.
 * @param {import('@playwright/test').Page} page
 * @param {{ evaluate?: (msg: any) => object, analyse?: (msg: any) => object[],
 *   search?: (msg: any) => { events?: object[], result?: object } }} [script]
 */
export async function fakeEngine(page, {
  evaluate = () => ({ best: { move: null, score: null, pv: [] }, moves: [] }),
  analyse = () => [],
  search = () => ({}),
} = {}) {
  const asked = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.send(JSON.stringify({ type: REPLY.HELLO, engine: null }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      asked.push(msg);
      const reply = (body) => ws.send(JSON.stringify({ ...body, id: msg.id }));
      if (msg.type === REQUEST.BESTMOVE) {
        const [first] = new Chess(msg.fen).moves({ verbose: true });
        reply({ type: REPLY.RESULT, move: first.from + first.to + (first.promotion || ''), score: { cp: 0 } });
      } else if (msg.type === REQUEST.EVALUATE) {
        reply({ type: REPLY.RESULT, fen: msg.fen, depth: msg.depth, ...evaluate(msg) });
      } else if (msg.type === REQUEST.ANALYSE) {
        const lines = analyse(msg);
        reply({ type: REPLY.DONE, depth: 12, lines, bestmove: lines.length ? lines[0].pv[0] : null });
      } else if (msg.type === REQUEST.PUZZLE_SEARCH) {
        const { events = [], result = {} } = search(msg);
        for (const event of events) reply({ type: REPLY.SEARCH_EVENT, ...event });
        reply({ type: REPLY.RESULT, puzzles: [], gaps: [], stats: { positions: 1, lookups: 1, cached: 0 }, exhausted: true, cancelled: false, ...result });
      }
    });
  });
  return asked;
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
    /** @type {any} */ (window).__liveKeyHandlers = () => live.size;
  });
  return () => page.evaluate(() => /** @type {any} */ (window).__liveKeyHandlers());
}
