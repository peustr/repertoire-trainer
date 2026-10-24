// The engine WebSocket (engine-socket.js) with scripted engines, store and Lichess client,
// so its timing and every kind of request can be met on purpose: throttled analysis
// progress, cancelling, puzzle searches and the Lichess rate-limit notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serveEngineSocket } from '../engine-socket.js';
import * as schema from '../settings-schema.js';
import { START_FEN, positionKey } from '../public/js/constants.js';
import { REQUEST, REPLY } from '../public/js/protocol.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

/** A stand-in for a ws WebSocket: records what is sent, and takes requests as a page sends them. */
function fakeSocket() {
  const ws = /** @type {any} */ (Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] }));
  ws.send = (text) => { ws.sent.push(JSON.parse(text)); };
  ws.request = (msg) => ws.emit('message', Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
  ws.replies = (id) => ws.sent.filter((m) => m.id === id);
  return ws;
}

/** Analyses that finish, or fail, when the test says so. */
function scriptedEngines(overrides = {}) {
  const analyses = [];
  return {
    analyses,
    info: () => ({ analysis: { kind: 'fake' }, tasks: { kind: 'fake' } }),
    analyse(msg, onInfo) {
      let finish, fail;
      const promise = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const run = {
        msg, onInfo, promise, finish, fail, cancelled: false,
        cancel() { run.cancelled = true; finish({ depth: 1, lines: [], bestmove: null, cancelled: true }); },
      };
      analyses.push(run);
      return run;
    },
    evaluate: async (msg) => ({ fen: msg.fen, best: { move: 'e2e4', score: { cp: 20 }, pv: ['e2e4'] }, moves: [] }),
    bestmove: async () => ({ move: 'e2e4', score: { cp: 20 } }),
    lines: async () => ({ lines: [] }),
    ...overrides,
  };
}

/** Start serving with these stand-ins; returns a connect() that opens a page's socket. */
function serve({ engines = scriptedEngines(), store = {}, lichess = {} } = {}) {
  const wss = new EventEmitter();
  const services = { engines, store, lichess: { events: new EventEmitter(), status: () => ({ connected: true }), ...lichess } };
  serveEngineSocket(wss, /** @type {any} */ (services));
  return {
    services,
    connect() {
      const ws = fakeSocket();
      wss.emit('connection', ws);
      return ws;
    },
  };
}

test('a page is greeted with the engine information; what it cannot read is ignored or answered', async () => {
  const ws = serve().connect();
  assert.deepEqual(ws.sent, [{ type: REPLY.HELLO, engine: { analysis: { kind: 'fake' }, tasks: { kind: 'fake' } } }]);
  for (const junk of ['not json', 'null', '5', '[1, 2]']) ws.request(junk);
  await settle();
  assert.equal(ws.sent.length, 1, 'no answer to something that is not a request');

  ws.request({ type: 'resign', id: 1 });
  await settle();
  assert.deepEqual(ws.replies(1), [{ type: REPLY.ERROR, id: 1, message: 'The server does not understand "resign" requests. Reload the page.' }]);
});

test('analysis progress goes out at most every 120 ms, and a new analysis replaces the old', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const engines = scriptedEngines();
  const ws = serve({ engines }).connect();
  ws.request({ type: REQUEST.ANALYSE, id: 1, fen: START_FEN });
  await settle();
  const [first] = engines.analyses;
  const infos = () => ws.replies(1).filter((m) => m.type === REPLY.INFO).map((m) => m.depth);

  first.onInfo({ depth: 1 }); // the first goes at once
  first.onInfo({ depth: 2 }); // then held back...
  first.onInfo({ depth: 3 });
  assert.deepEqual(infos(), [1]);
  t.mock.timers.tick(120); // ...and only the latest is sent
  assert.deepEqual(infos(), [1, 3]);
  t.mock.timers.tick(200);
  first.onInfo({ depth: 4 }); // after a quiet spell, at once again
  first.onInfo({ depth: 5 }); // held back, then made moot by the end
  first.finish({ depth: 5, lines: [], bestmove: 'e2e4' });
  await settle();
  t.mock.timers.tick(500);
  assert.deepEqual(infos(), [1, 3, 4]);
  assert.deepEqual(ws.replies(1).at(-1), { type: REPLY.DONE, depth: 5, lines: [], bestmove: 'e2e4', id: 1 });

  ws.request({ type: REQUEST.ANALYSE, id: 2, fen: START_FEN });
  await settle();
  ws.request({ type: REQUEST.ANALYSE, id: 3, fen: START_FEN });
  await settle();
  assert.equal(engines.analyses[1].cancelled, true, 'one live analysis per page');
  assert.equal(ws.replies(2).at(-1).cancelled, true);

  ws.request({ type: REQUEST.STOP, id: 3 });
  ws.request({ type: REQUEST.STOP, id: 99 }); // nothing running under that id
  await settle();
  assert.equal(engines.analyses[2].cancelled, true);
});

test('a failed analysis ends with its error, and leaves nothing behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const engines = scriptedEngines();
  const ws = serve({ engines }).connect();
  ws.request({ type: REQUEST.ANALYSE, id: 1, fen: START_FEN });
  await settle();
  const [run] = engines.analyses;
  run.onInfo({ depth: 1 }); // sent at once
  run.onInfo({ depth: 2 }); // held back for 120 ms...
  run.fail(new Error('Stockfish stopped responding, so it was restarted.'));
  await settle();
  t.mock.timers.tick(500); // ...and dropped: nothing may follow the error
  assert.deepEqual(ws.replies(1).map((m) => m.type), [REPLY.INFO, REPLY.ERROR]);
  assert.equal(ws.replies(1)[1].message, 'Stockfish stopped responding, so it was restarted.');

  ws.readyState = 3;
  ws.emit('close');
  await settle();
  assert.equal(run.cancelled, false, 'a run that has ended is not cancelled again');
});

test('evaluations and best moves are answered under their request id; failures as errors', async () => {
  const engines = scriptedEngines({
    evaluate: async ({ fen }) => {
      if (fen === 'bad') throw Object.assign(new Error('That is not a legal chess position.'), { status: 400 });
      return { fen, best: { move: 'e2e4', score: { cp: 20 }, pv: ['e2e4'] }, moves: [] };
    },
  });
  const ws = serve({ engines }).connect();
  ws.request({ type: REQUEST.EVALUATE, id: 1, fen: START_FEN, moves: [] });
  ws.request({ type: REQUEST.BESTMOVE, id: 2, fen: START_FEN });
  ws.request({ type: REQUEST.EVALUATE, id: 3, fen: 'bad', moves: [] });
  await settle();
  assert.equal(ws.replies(1)[0].best.move, 'e2e4');
  assert.deepEqual(ws.replies(2), [{ type: REPLY.RESULT, move: 'e2e4', score: { cp: 20 }, id: 2 }]);
  assert.deepEqual(ws.replies(3), [{ type: REPLY.ERROR, id: 3, message: 'That is not a legal chess position.' }]);
});

test('closing the page cancels what it was running, and nothing more is sent to it', async () => {
  const engines = scriptedEngines();
  const ws = serve({ engines }).connect();
  ws.request({ type: REQUEST.ANALYSE, id: 1, fen: START_FEN });
  await settle();
  ws.readyState = 3;
  ws.emit('close');
  await settle();
  assert.equal(engines.analyses[0].cancelled, true);
  assert.deepEqual(ws.replies(1), [], 'its answer is not sent to a closed socket');
});

test('when Lichess asks the app to wait, every open page hears it', () => {
  const { services, connect } = serve();
  const open = connect();
  const closing = connect();
  closing.readyState = 2;
  const gone = connect();
  gone.emit('close');
  services.lichess.events.emit('ratelimit', 1234);
  assert.deepEqual(open.sent.at(-1), { type: REPLY.LICHESS, status: { connected: true }, until: 1234 });
  assert.equal(closing.sent.length, 1, 'only the greeting');
  assert.equal(gone.sent.length, 1);
});

// --- puzzle searches -------------------------------------------------------------------------

const REP = { id: 'rep', color: 'white', pgn: '1. e4 e5 2. Nf3 *' };
const explorerMove = (uci, san, total) => ({ uci, san, total, white: total / 2, draws: 0, black: total / 2, averageRating: 1700 });

/** After 1.e4: e5 is prepared, f6 throws a pawn away (a puzzle), c5 is popular and unprepared (a gap). */
/**
 * @param {import('node:test').TestContext} t
 * @param {{ explorer?: (query: any) => Promise<any> }} [options]
 */
function searchServices(t, { explorer } = {}) {
  const store = {
    getRepertoire: (id) => (id === REP.id ? REP : null),
    getSettings: () => schema.defaults(),
    addPuzzles: t.mock.fn(),
    addGaps: t.mock.fn(),
  };
  const engines = scriptedEngines({
    async evaluate({ moves }) {
      return { best: { move: moves[0], score: { cp: 0 }, pv: [moves[0]] }, moves: moves.map((m) => ({ move: m, score: { cp: m === 'f7f6' ? 400 : 0 }, pv: [m] })) };
    },
    async lines() { return { lines: [{ pv: ['g1f3'], score: { cp: 400 } }] }; },
  });
  const answers = {
    [positionKey(AFTER_E4)]: { total: 1000, moves: [explorerMove('e7e5', 'e5', 500), explorerMove('f7f6', 'f6', 300), explorerMove('c7c5', 'c5', 200)] },
  };
  const lichess = {
    explorer: explorer || (async ({ fen }) => ({ cached: false, ...(answers[positionKey(fen)] || { total: 0, moves: [] }) })),
  };
  return { store, engines, lichess };
}

test('a puzzle search saves and reports what it finds, and answers with the puzzles’ ids', async (t) => {
  const services = searchServices(t);
  const ws = serve(services).connect();
  ws.request({ type: REQUEST.PUZZLE_SEARCH, id: 7, repId: 'rep', fen: START_FEN, prefix: { startFen: START_FEN, moves: [] } });
  for (let i = 0; i < 50 && !ws.replies(7).some((m) => m.type === REPLY.RESULT); i++) await settle();

  const events = ws.replies(7).filter((m) => m.type === REPLY.SEARCH_EVENT).map((m) => m.kind);
  assert.ok(events.includes('progress') && events.includes('found') && events.includes('gap'), events.join());
  const [puzzle] = services.store.addPuzzles.mock.calls[0].arguments[1];
  assert.equal(services.store.addPuzzles.mock.calls[0].arguments[0], 'rep');
  assert.equal(puzzle.mistake.san, 'f6');
  assert.equal(services.store.addGaps.mock.calls[0].arguments[1][0].san, 'c5');
  const result = ws.replies(7).at(-1);
  assert.equal(result.type, REPLY.RESULT);
  assert.deepEqual(result.puzzles, [puzzle.id]);
});

test('a puzzle search Lichess refuses ends with the reason', async (t) => {
  const refused = async () => { throw Object.assign(new Error('Connect your Lichess account first.'), { status: 401 }); };
  const ws = serve(searchServices(t, { explorer: refused })).connect();
  ws.request({ type: REQUEST.PUZZLE_SEARCH, id: 4, repId: 'rep', fen: START_FEN });
  for (let i = 0; i < 20 && !ws.replies(4).length; i++) await settle();
  assert.deepEqual(ws.replies(4), [{ type: REPLY.ERROR, id: 4, message: 'Connect your Lichess account first.' }]);
});

test('a puzzle search needs a repertoire and a legal position', async (t) => {
  const ws = serve(searchServices(t)).connect();
  ws.request({ type: REQUEST.PUZZLE_SEARCH, id: 1, repId: 'gone', fen: START_FEN });
  ws.request({ type: REQUEST.PUZZLE_SEARCH, id: 2, repId: 'rep', fen: '8/8/8/8/8/8/8/8 w - - 0 1' });
  await settle();
  assert.deepEqual(ws.replies(1), [{ type: REPLY.ERROR, id: 1, message: 'Repertoire not found' }]);
  assert.match(ws.replies(2)[0].message, /White has no king/);
});

test('a puzzle search stops when the page asks, or when the page goes away', async (t) => {
  /** @type {any} */
  let release;
  const held = () => new Promise((resolve) => { release = () => resolve({ cached: false, total: 1000, moves: [explorerMove('e7e5', 'e5', 1000)] }); });
  const services = searchServices(t, { explorer: held });
  const ws = serve(services).connect();

  ws.request({ type: REQUEST.PUZZLE_SEARCH, id: 1, repId: 'rep', fen: START_FEN });
  for (let i = 0; i < 20 && !release; i++) await settle();
  ws.request({ type: REQUEST.STOP, id: 1 });
  release();
  for (let i = 0; i < 50 && !ws.replies(1).some((m) => m.type === REPLY.RESULT); i++) await settle();
  assert.equal(ws.replies(1).at(-1).ended, 'stopped', 'stopped by the page');

  release = null;
  ws.request({ type: REQUEST.PUZZLE_SEARCH, id: 2, repId: 'rep', fen: START_FEN });
  for (let i = 0; i < 20 && !release; i++) await settle();
  ws.readyState = 3; // the page has gone, before the socket says so
  release();
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(ws.replies(2).filter((m) => m.type === REPLY.RESULT).length, 0, 'nothing is sent to a closed page');
  ws.emit('close');
});
