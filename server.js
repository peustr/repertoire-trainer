// Repertoire Trainer — local server.
// Serves the web app, stores repertoires as JSON files, and bridges the
// browser to Stockfish over a WebSocket.

import './check-node.cjs'; // first: a friendly message on a too-old Node.js

import express from 'express';
import http from 'node:http';
import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as schema from './settings-schema.js';
import { EngineManager } from './engine.js';
import { createLichessClient } from './lichess.js';
import { serveEngineSocket } from './engine-socket.js';

const PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || '127.0.0.1'; // only reachable from this computer

const engines = new EngineManager(() => store.getSettings());
// The app's one Lichess client: one request queue for everything that asks Lichess.
const lichess = createLichessClient({
  dataDir: store.DATA_DIR,
  baseUrl: process.env.LICHESS_URL || undefined,
  explorerUrl: process.env.LICHESS_EXPLORER_URL || undefined,
});

const app = express();

// --- only this computer's own pages may use the server ------------------------
//
// Listening on 127.0.0.1 keeps other computers out, but not other websites open in
// the same browser: they can reach localhost too, and DNS rebinding can make the
// browser treat them as this server. So only answer requests addressed to a local
// name, and refuse cross-site requests (and WebSockets) from other pages.

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]',
  ...String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]);
if (!['0.0.0.0', '::'].includes(HOST)) ALLOWED_HOSTS.add(HOST.toLowerCase());

function parseUrl(url) {
  try { return new URL(url); } catch (err) { return null; }
}

/** Why a request must be refused, or null if it may go ahead. */
function refusal(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const target = parseUrl(`http://${host}`);
  if (!target || !ALLOWED_HOSTS.has(target.hostname)) return `Unexpected host "${host}"`;
  const origin = req.headers.origin;
  if (origin === undefined) return null; // not sent by a page (curl, top-level navigation)
  const from = parseUrl(origin);
  if (!from || !['http:', 'https:'].includes(from.protocol) || from.host !== target.host) return `Cross-site request from ${origin}`;
  return null;
}

app.use((req, res, next) => {
  const why = refusal(req);
  if (!why) return next();
  res.status(403).json({ error: `${why}. Open the trainer at http://localhost:${PORT}.` });
});

app.use(express.json({ limit: '20mb' }));

// --- static files ----------------------------------------------------------

function packageDir(name) {
  // Some packages hide package.json behind an "exports" map, so look on disk, in the
  // node_modules folders Node itself would search.
  // (resolve.paths gives null only for Node's own modules.)
  for (const base of createRequire(import.meta.url).resolve.paths(name)) {
    const dir = path.join(base, ...name.split('/'));
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  /* c8 ignore next: only with an incomplete npm install, which the tests cannot stage */
  throw new Error(`Missing dependency ${name}. Run "npm install" first.`);
}

app.use(express.static(path.join(import.meta.dirname, 'public'), { extensions: ['html'] }));
app.use('/vendor/chessground', express.static(packageDir('@lichess-org/chessground')));
app.use('/vendor/chess.js', express.static(packageDir('chess.js')));
app.use('/vendor/fonts/inter', express.static(packageDir('@fontsource-variable/inter')));

// --- REST API ----------------------------------------------------------------

// A handler returns a value for JSON or null for a 404, or throws an error with .status.
function answer(res, out) {
  if (out === null) return res.status(404).json({ error: 'Not found' });
  res.json(out);
}
const failure = (res, err) => res.status(err.status || 500).json({ error: err.message });
const wrap = (fn) => (req, res) => {
  try { answer(res, fn(req)); } catch (err) { failure(res, err); }
};
const wrapAsync = (fn) => async (req, res) => {
  try { answer(res, await fn(req)); } catch (err) { failure(res, err); }
};

app.get('/api/repertoires', wrap(() => store.listRepertoires()));
app.get('/api/repertoires/:id', wrap((req) => store.getRepertoire(req.params.id)));
app.post('/api/repertoires', wrap((req) => store.createRepertoire(req.body || {})));
app.put('/api/repertoires/:id', wrap((req) => store.updateRepertoire(req.params.id, req.body || {})));
app.post('/api/repertoires/:id/lines', wrap((req) => store.addLine(req.params.id, req.body || {})));
app.patch('/api/repertoires/:id/progress', wrap((req) => store.patchProgress(req.params.id, req.body || {})));
app.delete('/api/repertoires/:id/progress', wrap((req) => store.resetProgress(req.params.id)));
app.delete('/api/repertoires/:id', wrap((req) => (store.deleteRepertoire(req.params.id) ? { ok: true } : null)));

app.get('/api/settings', wrap(() => store.getSettings()));
app.put('/api/settings', wrap((req) => {
  const before = store.getSettings();
  const after = store.saveSettings(req.body || {});
  // Engine settings take effect by restarting Stockfish.
  if (schema.ENGINE_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) engines.restart();
  return after;
}));
app.get('/api/settings/schema', wrap(() => ({
  sections: schema.buildSchema(),
  defaults: schema.defaults(),
  machine: schema.machine(),
  engine: engines.info(),
})));

const SAMPLES_DIR = path.join(import.meta.dirname, 'samples');
app.get('/api/samples', wrap(() => {
  /* c8 ignore next: the samples ship with the app; this only covers someone deleting the folder */
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  return fs.readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith('.pgn'))
    .map((file) => {
      const pgn = fs.readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
      const color = /\[Repertoire\s+"black"\]/i.test(pgn) ? 'black' : 'white';
      const name = pgn.match(/\[RepertoireName\s+"([^"]+)"\]/)[1]; // every sample has one (test/server-api.test.mjs)
      return { file, name, color, pgn };
    });
}));

app.get('/api/engine', wrap(() => engines.info()));

// --- Lichess -------------------------------------------------------------------

app.get('/api/lichess/status', wrap(() => lichess.status()));
app.post('/api/lichess/token', wrapAsync((req) => lichess.connectWithToken((req.body || {}).token, 'personal')));
app.delete('/api/lichess/token', wrapAsync(() => lichess.disconnect()));
app.get('/api/lichess/explorer', wrapAsync((req) => {
  const s = store.getSettings();
  return lichess.explorer({
    fen: req.query.fen,
    source: req.query.source === 'masters' ? 'masters' : 'lichess',
    speeds: req.query.speeds || s.lichessSpeeds,
    ratings: req.query.ratings || s.lichessRatings,
    since: s.lichessSince,
    cacheDays: s.cacheDays,
  });
}));
app.get('/api/lichess/study', wrapAsync((req) => lichess.studyPgn(req.query.url)));
app.get('/api/lichess/studies', wrapAsync(() => lichess.userStudies()));

app.post('/api/repertoires/:id/puzzles', wrap((req) => {
  const out = store.addPuzzles(req.params.id, (req.body || {}).puzzles || []);
  return out ? out.rep : null;
}));
app.post('/api/repertoires/:id/puzzles/:pid/add-line', wrap((req) => store.addPuzzleLine(req.params.id, req.params.pid, (req.body || {}).pgn)));
app.delete('/api/repertoires/:id/puzzles/:pid', wrap((req) => store.deletePuzzle(req.params.id, req.params.pid)));
app.delete('/api/repertoires/:id/gaps', wrap((req) => store.deleteGap(req.params.id, String(req.query.key || ''))));

app.get('/auth/lichess/start', (req, res) => {
  const redirectUri = `http://${req.headers.host}/auth/lichess/callback`;
  res.redirect(lichess.oauthStart(redirectUri));
});
app.get('/auth/lichess/callback', async (req, res) => {
  try {
    await lichess.oauthCallback(req.query);
    res.redirect('/#/lichess?connected=1');
  } catch (err) {
    res.redirect(`/#/lichess?error=${encodeURIComponent(err.message)}`);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

// --- WebSocket engine bridge ---------------------------------------------------
//
// The messages and what answers each are described in public/js/protocol.js.

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Browsers let any page open a WebSocket to localhost; only our own pages may.
  verifyClient: ({ req }, done) => {
    const why = refusal(req);
    done(!why, 403, why || undefined);
  },
});
serveEngineSocket(wss, { engines, store, lichess });

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  Repertoire Trainer is running.');
  console.log(`  Open ${url} in your browser.`);
  console.log(`  Data folder: ${store.DATA_DIR}`);
  const a = engines.info().analysis;
  console.log(`  Engine: ${a.kind === 'native' ? `native (${a.file})` : `built-in Stockfish (${a.file})`}, ${a.threads} thread${a.threads === 1 ? '' : 's'}, ${a.hash} MB hash`);
  for (const w of a.warnings) console.log(`  Note: ${w}`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  store.sweepTempFiles();
  void lichess.pruneCache(store.getSettings().cacheDays);
  engines.warmUp();
  /* c8 ignore next: opens the user's browser, which no test should do */
  if (process.argv.includes('--open')) openBrowser(url);
});

// ws passes the HTTP server's errors on to the WebSocket server, so they are handled there:
// unhandled, Node would stop with a stack trace before any handler on `server` ran.
wss.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is the trainer already running? Try http://localhost:${PORT}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

/* c8 ignore start: opens the user's browser (npm start, start.bat), which no test should do */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
/* c8 ignore stop */

function shutdown() {
  engines.quit();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Started by another Node.js program with an IPC channel (the tests): stop when it lets
// go. Unlike a signal, this works on Windows too.
if (process.send) process.on('disconnect', shutdown);
