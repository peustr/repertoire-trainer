// Repertoire Trainer — local server.
// Serves the web app, stores repertoires as JSON files, and bridges the
// browser to Stockfish over a WebSocket.

'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const store = require('./store');
const { EngineManager } = require('./engine');
const lichess = require('./lichess');
const { searchMistakes } = require('./puzzles');

// The repertoire parser is shared with the browser (ES module), so load it lazily.
let repertoireModule = null;
function loadRepertoireModule() {
  if (!repertoireModule) repertoireModule = import('./public/js/repertoire.js');
  return repertoireModule;
}

const PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || '127.0.0.1'; // only reachable from this computer

const schema = require('./settings-schema');
const engines = new EngineManager(() => store.getSettings());

const app = express();
app.use(express.json({ limit: '20mb' }));

// --- static files ----------------------------------------------------------

function packageDir(name) {
  // Some packages hide package.json behind an "exports" map, so look on disk.
  for (const base of module.paths) {
    const dir = path.join(base, ...name.split('/'));
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  throw new Error(`Missing dependency ${name}. Run "npm install" first.`);
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/vendor/chessground', express.static(packageDir('@lichess-org/chessground')));
app.use('/vendor/chess.js', express.static(packageDir('chess.js')));
app.use('/vendor/fonts/shantell-sans', express.static(packageDir('@fontsource/shantell-sans')));
app.use('/vendor/fonts/nunito', express.static(packageDir('@fontsource/nunito')));

// --- REST API ----------------------------------------------------------------

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out === undefined) return;
    if (out === null) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

app.get('/api/repertoires', wrap(() => store.listRepertoires()));
app.get('/api/repertoires/:id', wrap((req) => store.getRepertoire(req.params.id)));
app.post('/api/repertoires', wrap((req) => store.createRepertoire(req.body || {})));
app.put('/api/repertoires/:id', wrap((req) => store.updateRepertoire(req.params.id, req.body || {})));
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

const SAMPLES_DIR = path.join(__dirname, 'samples');
app.get('/api/samples', wrap(() => {
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  return fs.readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith('.pgn'))
    .map((file) => {
      const pgn = fs.readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
      const color = /\[Repertoire\s+"black"\]/i.test(pgn) ? 'black' : 'white';
      const name = (pgn.match(/\[RepertoireName\s+"([^"]+)"\]/) || [])[1] || file.replace(/\.pgn$/, '');
      return { file, name, color, pgn };
    });
}));

app.get('/api/engine', wrap(() => engines.info()));

// --- Lichess -------------------------------------------------------------------

const wrapAsync = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out === undefined) return;
    if (out === null) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (err) {
    res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message });
  }
};

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
// Client -> server
//   { type: 'analyse',  id, fen, multipv, depth?, movetime?, infinite? }
//   { type: 'stop',     id }
//   { type: 'evaluate', id, fen, moves: [uci], depth }
//   { type: 'bestmove', id, fen, elo?, movetime?, newGame? }
// Server -> client
//   { type: 'info',  id, depth, lines }     (streamed while analysing)
//   { type: 'done',  id, depth, lines, bestmove }
//   { type: 'result', id, ...payload }      (evaluate / bestmove)
//   { type: 'error', id, message }

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();
lichess.events.on('ratelimit', (until) => {
  for (const c of clients) if (c.readyState === c.OPEN) c.send(JSON.stringify({ type: 'lichess', status: lichess.status(), until }));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  const runs = new Map(); // client id -> engine run (for cancelling)
  const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  send({ type: 'hello', engine: engines.info() });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const { id } = msg;
    try {
      if (msg.type === 'analyse') {
        // A client only ever has one live analysis: a new one replaces the old.
        for (const [key, run] of runs) if (run.kind === 'analyse') { run.cancel(); runs.delete(key); }
        let last = 0;
        let pending = null;
        const flush = () => { pending = null; last = Date.now(); send({ type: 'info', ...latest, id }); };
        let latest = null;
        const run = engines.analyse(msg, (snap) => {
          latest = snap;
          const wait = 120 - (Date.now() - last);
          if (wait <= 0) flush();
          else if (!pending) pending = setTimeout(flush, wait);
        });
        run.kind = 'analyse';
        runs.set(id, run);
        const res = await run.promise;
        if (pending) clearTimeout(pending);
        runs.delete(id);
        send({ type: 'done', ...res, id });
      } else if (msg.type === 'stop') {
        const run = runs.get(id);
        if (run) run.cancel();
      } else if (msg.type === 'evaluate') {
        const res = await engines.evaluate(msg);
        send({ type: 'result', ...res, id });
      } else if (msg.type === 'bestmove') {
        const res = await engines.bestmove(msg);
        send({ type: 'result', ...res, id });
      } else if (msg.type === 'status') {
        send({ type: 'result', id, engine: engines.info() });
      } else if (msg.type === 'puzzle-search') {
        const rep = store.getRepertoire(msg.repId);
        if (!rep) throw Object.assign(new Error('Repertoire not found'), { status: 404 });
        const { buildRepertoire } = await loadRepertoireModule();
        const model = buildRepertoire(rep);
        const s = store.getSettings();
        const o = msg.options || {};
        let stopped = false;
        runs.set(id, { kind: 'search', cancel: () => { stopped = true; } });
        const result = await searchMistakes({
          rep,
          model,
          fen: msg.fen,
          prefix: msg.prefix,
          engines,
          options: {
            maxPositions: o.positions || s.puzzlePositions,
            maxOppDepth: o.depthMoves || s.puzzleDepthMoves,
            candidates: s.puzzleCandidates,
            minShare: (o.minShare || s.puzzleMinShare) / 100,
            minGames: o.minGames || s.puzzleMinGames,
            threshold: o.threshold || s.puzzleThreshold,
            minAdvantage: s.puzzleMinAdvantage,
            depth: s.puzzleEngineDepth,
            solveDepth: s.puzzleSolveDepth,
            uniqueGap: s.puzzleUniqueGap,
            maxLength: s.puzzleMaxLength,
            maxPuzzles: s.puzzleMaxPerSearch,
            beyondBook: s.puzzleBeyondBook,
            gapShare: s.puzzleGapShare / 100,
            speeds: o.speeds || s.lichessSpeeds,
            ratings: o.ratings || s.lichessRatings,
            since: s.lichessSince,
            cacheDays: s.cacheDays,
          },
          cancelled: () => stopped || ws.readyState !== ws.OPEN,
          onEvent: (ev) => {
            if (ev.kind === 'found') store.addPuzzles(rep.id, [ev.puzzle]);
            if (ev.kind === 'gap') store.addGaps(rep.id, [ev.gap]);
            send({ type: 'search-event', id, ...ev });
          },
        });
        runs.delete(id);
        send({ type: 'result', id, ...result, puzzles: result.puzzles.map((p) => p.id) });
      }
    } catch (err) {
      send({ type: 'error', id, message: err.message });
    }
  });

  ws.on('close', () => {
    for (const run of runs.values()) run.cancel();
    runs.clear();
  });
});

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
  engines.warmUp();
  if (process.argv.includes('--open')) openBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is the trainer already running? Try http://localhost:${PORT}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function openBrowser(url) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function shutdown() {
  engines.quit();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
