// The engine WebSocket (/ws): runs the engine requests the browser sends and sends back
// their answers, as described in public/js/protocol.js, and tells every open page when
// Lichess asks the app to wait. server.js attaches it to the server's WebSocket.

import { checkFen } from './engine.js';
import { searchMistakes } from './puzzles.js';
import * as schema from './settings-schema.js';
import { buildRepertoire } from './public/js/repertoire.js'; // shared with the browser
import { REQUEST, REPLY } from './public/js/protocol.js';

/**
 * Serve engine requests on every connection the WebSocket server accepts.
 * @param {import('node:events').EventEmitter} wss  a ws WebSocketServer
 * @param {{ engines: import('./engine.js').EngineManager, store: typeof import('./store.js'),
 *   lichess: import('./lichess.js').LichessClient }} services
 */
export function serveEngineSocket(wss, { engines, store, lichess }) {
  const clients = new Set();
  lichess.events.on('ratelimit', (until) => {
    for (const c of clients) if (c.readyState === c.OPEN) c.send(JSON.stringify({ type: REPLY.LICHESS, status: lichess.status(), until }));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    const runs = new Map(); // client id -> engine run (for cancelling)
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

    send({ type: REPLY.HELLO, engine: engines.info() });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      // Not a request (null, a number, a list): ignore it. Reading msg.id from null here,
      // outside the try below, would stop the whole server.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      const { id } = msg;
      try {
        if (msg.type === REQUEST.ANALYSE) {
          // A client only ever has one live analysis: a new one replaces the old.
          for (const [key, run] of runs) if (run.kind === 'analyse') { run.cancel(); runs.delete(key); }
          let last = 0;
          let pending = null;
          const flush = () => { pending = null; last = Date.now(); send({ type: REPLY.INFO, ...latest, id }); };
          let latest = null;
          const run = engines.analyse(msg, (snap) => {
            latest = snap;
            const wait = 120 - (Date.now() - last);
            if (wait <= 0) flush();
            else if (!pending) pending = setTimeout(flush, wait);
          });
          run.kind = 'analyse';
          runs.set(id, run);
          let res;
          try {
            res = await run.promise;
          } finally {
            // Also when it fails: no progress may follow the error, and it is not cancelled again.
            if (pending) clearTimeout(pending);
            runs.delete(id);
          }
          send({ type: REPLY.DONE, ...res, id });
        } else if (msg.type === REQUEST.STOP) {
          const run = runs.get(id);
          if (run) run.cancel();
        } else if (msg.type === REQUEST.EVALUATE) {
          const res = await engines.evaluate(msg);
          send({ type: REPLY.RESULT, ...res, id });
        } else if (msg.type === REQUEST.BESTMOVE) {
          const res = await engines.bestmove(msg);
          send({ type: REPLY.RESULT, ...res, id });
        } else if (msg.type === REQUEST.STATUS) {
          send({ type: REPLY.RESULT, id, engine: engines.info() });
        } else if (msg.type === REQUEST.PUZZLE_SEARCH) {
          const rep = store.getRepertoire(msg.repId);
          if (!rep) throw Object.assign(new Error('Repertoire not found'), { status: 404 });
          const fen = checkFen(msg.fen);
          let stopped = false;
          runs.set(id, { kind: 'search', cancel: () => { stopped = true; } });
          let result;
          try {
            result = await searchMistakes({
              rep,
              model: buildRepertoire(rep),
              fen,
              prefix: msg.prefix,
              engines,
              lichess,
              options: schema.finderOptions(store.getSettings()),
              cancelled: () => stopped || ws.readyState !== ws.OPEN,
              onEvent: (ev) => {
                if (ev.kind === 'found') store.addPuzzles(rep.id, [ev.puzzle]);
                if (ev.kind === 'gap') store.addGaps(rep.id, [ev.gap]);
                send({ type: REPLY.SEARCH_EVENT, id, ...ev });
              },
            });
          } finally {
            runs.delete(id);
          }
          send({ type: REPLY.RESULT, id, ...result, puzzles: result.puzzles.map((p) => p.id) });
        } else {
          // Without an answer the page would wait for its timeout.
          throw new Error(`The server does not understand "${String(msg.type)}" requests. Reload the page.`);
        }
      } catch (err) {
        send({ type: REPLY.ERROR, id, message: err.message });
      }
    });

    ws.on('close', () => {
      for (const run of runs.values()) run.cancel();
      runs.clear();
    });
  });
}
