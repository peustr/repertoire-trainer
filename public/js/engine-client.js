// Browser side of the Stockfish bridge (see server.js for the protocol).

let ws = null;
let seq = 0;
let connecting = null;
const pending = new Map(); // id -> { resolve, reject, onInfo }
const listeners = new Set();
let status = { connected: false, engine: null };

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of listeners) fn(status);
}

export function onEngineStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    sock.onopen = () => {
      ws = sock;
      connecting = null;
      setStatus({ connected: true });
      resolve(sock);
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      const wasOpen = ws === sock;
      ws = null;
      connecting = null;
      setStatus({ connected: false });
      for (const [id, p] of pending) { p.reject(new Error('Lost connection to the engine')); pending.delete(id); }
      if (!wasOpen) reject(new Error('Could not reach the local server'));
      setTimeout(() => connect().catch(() => {}), 2000);
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'hello') { setStatus({ engine: msg.engine }); return; }
      if (msg.type === 'lichess') { for (const fn of lichessListeners) fn(msg); return; }
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'info' || msg.type === 'search-event') p.onInfo && p.onInfo(msg);
      else if (msg.type === 'error') { pending.delete(msg.id); p.reject(new Error(msg.message)); }
      else { pending.delete(msg.id); p.resolve(msg); }
    };
  });
  return connecting;
}

async function request(payload, onInfo) {
  const sock = await connect();
  const id = ++seq;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject, onInfo }));
  sock.send(JSON.stringify({ ...payload, id }));
  return { id, promise };
}

/**
 * Live analysis. onUpdate receives { depth, lines: [{ multipv, depth, score: {cp}|{mate}, pv: [uci] }] }.
 * Returns a handle with stop().
 */
export function analyse(fen, { multipv = 3, depth = 22 } = {}, onUpdate) {
  let stopped = false;
  let id = null;
  const ready = request({ type: 'analyse', fen, multipv, depth }, (msg) => { if (!stopped) onUpdate(msg, false); })
    .then((r) => {
      id = r.id;
      if (stopped) stop();
      return r.promise.then((msg) => { if (!stopped) onUpdate(msg, true); });
    })
    .catch(() => {});
  function stop() {
    stopped = true;
    if (id != null && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop', id }));
  }
  return { stop, ready };
}

/** Score specific moves (UCI) in a position. Resolves to { best, moves }. */
export async function evaluate(fen, moves, depth = 14) {
  const r = await request({ type: 'evaluate', fen, moves, depth });
  return r.promise;
}

/** Ask the engine for a move, optionally at limited strength. */
export async function bestmove(fen, { elo, movetime = 700, newGame = false } = {}) {
  const r = await request({ type: 'bestmove', fen, elo, movetime, newGame });
  return r.promise;
}

const lichessListeners = new Set();
/** Server-pushed Lichess notices (e.g. "rate limited until …"). */
export function onLichessNotice(fn) {
  lichessListeners.add(fn);
  return () => lichessListeners.delete(fn);
}

/**
 * Run the opponent-mistake search on the server.
 * onEvent receives { kind: 'progress' | 'found' | 'gap', ... } as the search goes.
 * Returns { promise, stop }.
 */
export function searchMistakes({ repId, fen, prefix, options }, onEvent) {
  let id = null;
  let stopRequested = false;
  const promise = request({ type: 'puzzle-search', repId, fen, prefix, options }, (msg) => onEvent(msg))
    .then((r) => {
      id = r.id;
      if (stopRequested) stop();
      return r.promise;
    });
  function stop() {
    stopRequested = true;
    if (id != null && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop', id }));
  }
  return { promise, stop };
}

export function engineReady() {
  return connect().then(() => true, () => false);
}

// --- score helpers -------------------------------------------------------------

/** Centipawns from White's view, with mates mapped to large numbers. */
export function scoreToCp(score) {
  if (!score) return 0;
  if ('mate' in score) return score.mate === 0 ? 0 : Math.sign(score.mate) * (10000 - Math.abs(score.mate) * 10);
  return score.cp;
}

export function formatScore(score) {
  if (!score) return '…';
  if ('mate' in score) return score.mate === 0 ? '#' : `${score.mate > 0 ? '+' : '−'}M${Math.abs(score.mate)}`;
  const v = score.cp / 100;
  if (Math.abs(v) < 0.05) return '0.00';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
}

/** Fraction (0–1) of the eval bar that belongs to White. */
export function evalBarShare(score) {
  if (!score) return 0.5;
  if ('mate' in score) return score.mate > 0 ? 1 : score.mate < 0 ? 0 : 0.5;
  // Logistic curve similar to the win-probability models chess sites use.
  return 1 / (1 + Math.exp(-0.00368208 * score.cp));
}
