// UCI engine bridge.
//
// Talks to Stockfish over the Universal Chess Interface (plain text over
// stdin/stdout). Works with either:
//   - a native binary (e.g. stockfish-windows-x86-64-avx2.exe) — fastest, or
//   - the WebAssembly build that ships in the `stockfish` npm package, run
//     under Node — zero setup, installed by `npm install`.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stockfish from 'stockfish';
import { Chess } from 'chess.js';
import { WASM_HASH_MAX } from './settings-schema.js';

const ENGINE_DIR = path.join(import.meta.dirname, 'engine');

// ---------------------------------------------------------------------------
// Locating an engine
// ---------------------------------------------------------------------------

/**
 * \\server\share\x.exe or //server/share/x: never run, and never even checked,
 * because checking makes Windows connect to that server and offer the user's
 * login. (\\?\C:\... and \\.\C:\... are local paths.)
 */
function isNetworkPath(p) {
  return /^[\\/]{2}(?![?.][\\/][a-z]:)/i.test(String(p));
}

function findNativeEngine(customPath) {
  for (const candidate of [customPath, process.env.STOCKFISH_PATH]) {
    if (!candidate || isNetworkPath(candidate)) continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }
  if (!fs.existsSync(ENGINE_DIR)) return null;
  const isWin = process.platform === 'win32';
  const candidates = fs
    .readdirSync(ENGINE_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && /^stockfish/i.test(d.name))
    .map((d) => d.name)
    .filter((name) => (isWin ? /\.exe$/i.test(name) : !/\.(js|wasm|txt|md|zip|tar|gz|nnue)$/i.test(name)))
    .sort();
  return candidates.length ? path.join(ENGINE_DIR, candidates[0]) : null;
}

function findBundledEngine(flavour) {
  try {
    return stockfish.findEngine(flavour);
  } catch (err) {
    return null;
  }
}

/**
 * How to launch an engine: the command, its UCI options and any warnings for the user.
 * @typedef {{ kind: string, cmd: string, args: string[], label: string, options: Record<string, number | string>, warnings: string[] }} EngineSpec
 */

/**
 * Describe how to launch the engine for a role, from the user's settings.
 *  analysis: Explore and the eval bar
 *  tasks:    mistake verdicts, the mistake finder, audits, sparring
 * @param {string} role
 * @param {Record<string, any>} [cfg]
 * @returns {EngineSpec | null}
 */
function engineSpec(role, cfg = {}) {
  const cores = Math.max(1, os.cpus().length);
  const build = cfg.engineBuild || 'auto';
  const threads = Math.max(1, Math.min(cores, (role === 'analysis' ? cfg.analysisThreads : cfg.taskThreads) || 1));
  const hash = Math.max(16, (role === 'analysis' ? cfg.analysisHash : cfg.taskHash) || 64);
  const warnings = [];
  const networkPath = !!cfg.enginePath && isNetworkPath(cfg.enginePath);
  if (networkPath) warnings.push('Engines on a network share are not run. Copy the .exe to this computer and point at the copy.');

  if (build === 'auto' || build === 'native') {
    const native = findNativeEngine(cfg.enginePath);
    if (native) {
      return { kind: 'native', cmd: native, args: [], label: path.basename(native), options: { Threads: threads, Hash: hash }, warnings };
    }
    if (build === 'native' && !networkPath) warnings.push(cfg.enginePath ? `No engine found at ${cfg.enginePath}; using the built-in one.` : 'No stockfish .exe in the engine folder; using the built-in one.');
  }
  const flavour = build === 'builtin-lite' || role === 'tasks' ? 'lite' : 'full';
  const file = findBundledEngine(flavour) || findBundledEngine('lite-single');
  if (!file) return null;
  if (hash > WASM_HASH_MAX) warnings.push(`The built-in engine can use at most ${WASM_HASH_MAX} MB; using ${WASM_HASH_MAX} MB.`);
  return {
    kind: 'wasm',
    cmd: process.execPath,
    args: [file],
    label: path.basename(file),
    options: { Threads: threads, Hash: Math.min(hash, WASM_HASH_MAX) },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Parsing UCI output
// ---------------------------------------------------------------------------

function parseInfo(line) {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  const info = {};
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': info.depth = +t[++i]; break;
      case 'seldepth': info.seldepth = +t[++i]; break;
      case 'multipv': info.multipv = +t[++i]; break;
      case 'nodes': info.nodes = +t[++i]; break;
      case 'nps': info.nps = +t[++i]; break;
      case 'time': info.time = +t[++i]; break;
      case 'hashfull': info.hashfull = +t[++i]; break;
      case 'tbhits': info.tbhits = +t[++i]; break;
      case 'score': {
        const kind = t[++i];
        const value = +t[++i];
        info.score = kind === 'mate' ? { mate: value } : { cp: value };
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') info.bound = t[++i];
        break;
      }
      case 'wdl': info.wdl = [+t[++i], +t[++i], +t[++i]]; break;
      case 'pv': info.pv = t.slice(i + 1); i = t.length; break;
      case 'string': return null; // free text from the engine, not search info
      default: break;
    }
  }
  return info;
}

/** UCI scores are from the side to move; flip them so + always means White is better. */
function toWhitePov(score, fen) {
  if (!score) return null;
  const blackToMove = (fen || '').split(/\s+/)[1] === 'b';
  if (!blackToMove) return { ...score };
  if ('mate' in score) return { mate: -score.mate };
  return { cp: -score.cp };
}

// ---------------------------------------------------------------------------
// Checking what reaches the engine
// ---------------------------------------------------------------------------
//
// Searches come from the browser. Stockfish trusts what it is told: a position with
// no king makes it hang until the watchdog replaces it, holding up every job behind
// it, and a line break inside any value would pass a command of its own. A position it
// does check (more than 32 pieces) it refuses and then stops answering altogether, so
// those are refused here too, and UciEngine replaces an engine that refuses anyway.

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const GO = /^(depth \d+|movetime \d+|infinite)$/;
const MAX_DEPTH = 50; // past every setting (the highest is 40); deeper would run for hours

/** What chess.js finds wrong with a FEN, in words a player can act on. @type {Array<[RegExp, string]>} */
const FEN_PROBLEMS = [
  [/six space-delimited fields/, 'a FEN has six parts separated by spaces'],
  [/move number/, 'the move number must be 1 or more'],
  [/half move counter/, 'the half-move count must be 0 or more'],
  [/en-passant/, 'the en passant square is wrong'],
  [/castling/, 'the castling rights are wrong'],
  [/side-to-move/, 'the side to move must be w or b'],
  [/8 '\/'-delimited rows/, 'the board needs 8 ranks separated by /'],
  [/piece data is invalid/, 'one of the ranks is not written correctly'],
  [/missing white king/, 'White has no king'],
  [/missing black king/, 'Black has no king'],
  [/too many white kings/, 'White has more than one king'],
  [/too many black kings/, 'Black has more than one king'],
  [/pawns are on the edge rows/, 'there is a pawn on the first or last rank'],
];

/**
 * The position as a chess.js game, or a 400 error when Stockfish could not search it safely.
 * @param {unknown} fen
 * @returns {Chess}
 */
function parsePosition(fen) {
  let chess;
  try {
    chess = new Chess(String(fen || '').trim()); // a pasted FEN often ends in a space
  } catch (err) {
    const known = FEN_PROBLEMS.find(([pattern]) => pattern.test(String(err.message)));
    throw badRequest(known ? `That is not a legal chess position (${known[1]}).` : 'That is not a legal chess position.');
  }
  if (chess.board().flat().filter(Boolean).length > 32) throw badRequest('That is not a legal chess position (more than 32 pieces).');
  // The side that has just moved cannot be in check: that position never arises.
  const turn = chess.turn();
  const [king] = chess.findPiece({ type: 'k', color: turn === 'w' ? 'b' : 'w' });
  if (chess.isAttacked(king, turn)) throw badRequest('That is not a legal chess position (the side not to move is in check).');
  return chess;
}

/**
 * The position in a form Stockfish can search safely, or a 400 error.
 * @param {unknown} fen
 * @returns {string}
 */
function checkFen(fen) {
  return parsePosition(fen).fen();
}

/** A whole number from min to max, or the fallback when it is not a number. */
function clampInt(value, min, max, fallback) {
  const n = value === null || value === '' ? NaN : Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Refuse a job that could make the engine read more than one command per line. */
function checkJob(job) {
  if ((job.searchmoves || []).some((m) => !UCI_MOVE.test(m))) throw badRequest('Moves must be in UCI form, like e2e4.');
  if (job.go !== undefined && !GO.test(job.go)) throw badRequest(`Unknown search "${job.go}".`);
  for (const [name, value] of Object.entries(job.options || {})) {
    if (!/^[\w ]+$/.test(name) || !/^[\w .-]*$/.test(String(value))) throw badRequest('Engine options must be plain names and values.');
  }
  return { ...job, fen: checkFen(job.fen) };
}

// ---------------------------------------------------------------------------
// One engine process with a job queue
// ---------------------------------------------------------------------------

let jobCounter = 0;

class UciEngine extends EventEmitter {
  /**
   * options.specFor(role, config): how to launch the engine (tests pass a fake one).
   * options.startTimeout: ms to wait for the engine's uciok/readyok.
   * options.stallTimeout: ms a search may stay silent before the engine is asked to stop.
   * options.stopGrace: ms to wait for an answer to that stop before replacing the engine.
   * @param {string} role
   * @param {() => Record<string, any>} [getConfig]
   * @param {{ specFor?: (role: string, config: Record<string, any>) => EngineSpec | null, startTimeout?: number,
   *   stallTimeout?: number, stopGrace?: number }} [options]
   */
  constructor(role, getConfig = () => ({}), { specFor = engineSpec, startTimeout = 60000, stallTimeout = 45000, stopGrace = 3000 } = {}) {
    super();
    this.role = role;
    this.getConfig = getConfig;
    this.specFor = specFor;
    this.startTimeout = startTimeout;
    this.stallTimeout = stallTimeout;
    this.stopGrace = stopGrace;
    this.restartPending = false;
    this.lastOutput = 0;
    this.proc = null;
    this.ready = null; // Promise resolved after uciok/readyok
    this.name = null;
    this.spec = null;
    this.optionState = {}; // last values we sent via setoption
    this.queue = [];
    this.current = null;
    this.buffer = '';
    this.lineWaiters = [];
    this._starting = false; // start() is awaited for the next queued job
  }

  start() {
    if (this.ready != null) return this.ready;
    const spec = this.specFor(this.role, this.getConfig());
    if (!spec) {
      // Not remembered: the next job looks again, in case an engine was installed since.
      return Promise.reject(new Error('No Stockfish engine found. Run "npm install" or put stockfish.exe in the engine folder.'));
    }
    let proc;
    try {
      proc = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      // Windows refuses some files at once rather than through 'error' (EFTYPE: not a
      // program; EINVAL: a .bat or .cmd). Not remembered: the next job tries again.
      return Promise.reject(new Error(`Could not start ${spec.label} (${err.code}). Check the engine path in Settings.`));
    }
    this.spec = spec;
    this.optionState = {};
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    // Ignore anything from a process we have already replaced (after a settings change).
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this._onData(chunk); });
    proc.stderr.on('data', () => {});
    // A write to an engine that has just died fails with EPIPE, and an 'error' nobody
    // listens for would stop the whole app. Its exit is handled below.
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => { if (this.proc === proc) this._onExit(err); });
    proc.on('exit', (code) => { if (this.proc === proc) this._onExit(new Error(`Engine exited (code ${code})`)); });
    this.buffer = '';

    const ready = (async () => {
      this.send('uci');
      await this._waitFor((l) => {
        if (l.startsWith('id name ')) this.name = l.slice(8).trim();
        return l === 'uciok';
      }, this.startTimeout);
      for (const [name, value] of Object.entries(spec.options)) this._setOption(name, value);
      await this.isReady();
    })();
    this.ready = ready;
    // A failed start (no answer in time) must not stick: drop this process so the
    // next job starts a fresh one instead of getting the same error forever.
    ready.catch(() => {
      if (this.proc !== proc) return; // already handled by _onExit or a restart
      this.proc = null;
      this.ready = null;
      this.spec = null;
      this.restartPending = false; // the next start uses the current settings anyway
      proc.kill(); // does not throw, even for a process that has already exited
    });
    return ready;
  }

  send(cmd) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  async isReady() {
    this.send('isready');
    await this._waitFor((l) => l === 'readyok', this.startTimeout);
  }

  _setOption(name, value) {
    if (this.optionState[name] === value) return;
    this.optionState[name] = value;
    this.send(`setoption name ${name} value ${value}`);
  }

  _onData(chunk) {
    this.lastOutput = Date.now();
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    for (const w of [...this.lineWaiters]) {
      if (w.test(line)) {
        this.lineWaiters.splice(this.lineWaiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(line);
      }
    }
    const job = this.current;
    if (!job) return;
    if (line.startsWith('info string CRITICAL ERROR')) {
      // Stockfish refused a command of this search ("... failed. Reason: ...") and now
      // answers nothing at all, not even "stop": replace it now, not after the watchdog.
      const reason = line.replace(/^.*?Reason:\s*/, '').replace(/\.$/, '');
      this._replaceStuck(badRequest(`Stockfish could not search that position (${reason}).`));
      return;
    }
    if (line.startsWith('info ')) {
      const info = parseInfo(line);
      if (info && info.pv && info.score) {
        const mpv = info.multipv || 1;
        const entry = {
          multipv: mpv,
          depth: info.depth,
          seldepth: info.seldepth,
          nodes: info.nodes,
          nps: info.nps,
          time: info.time,
          bound: info.bound || null,
          score: toWhitePov(info.score, job.fen),
          pv: info.pv,
        };
        // Don't let an upper/lower-bound fail-high replace a settled line of the same depth.
        const prev = job.lines.get(mpv);
        if (!(entry.bound && prev && prev.depth >= entry.depth)) job.lines.set(mpv, entry);
        if (job.onInfo) job.onInfo(this._snapshot(job));
      }
    } else if (line.startsWith('bestmove')) {
      const parts = line.split(/\s+/);
      const result = this._snapshot(job);
      result.bestmove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
      result.ponder = parts[3] || null;
      result.cancelled = job.cancelled;
      this.current = null;
      clearTimeout(job.watchdog);
      job.resolve(result);
      this._swapIfRestarting();
      this._next();
    }
  }

  /**
   * Watch a running search. Stockfish prints progress at least every few seconds;
   * if it goes quiet for stallTimeout, ask it to stop. A slow search then answers
   * with its best move so far. A stuck engine does not, so it is replaced: only this
   * search fails, and the queue carries on with a fresh engine.
   */
  _watch(job) {
    this.lastOutput = Date.now();
    const check = () => {
      if (this.current !== job) return;
      const quiet = Date.now() - this.lastOutput;
      if (quiet < this.stallTimeout) {
        job.watchdog = setTimeout(check, this.stallTimeout - quiet);
        return;
      }
      this.send('stop');
      job.watchdog = setTimeout(() => {
        if (this.current === job) this._replaceStuck(new Error('Stockfish stopped responding, so it was restarted.'));
      }, this.stopGrace);
    };
    job.watchdog = setTimeout(check, this.stallTimeout);
  }

  _replaceStuck(err) {
    const proc = /** @type {import('node:child_process').ChildProcess} */ (this.proc); // a search was running on it
    const job = this.current;
    this.current = null;
    this.proc = null;
    this.ready = null;
    this.spec = null;
    this.restartPending = false; // the replacement starts with the current settings anyway
    proc.kill();
    clearTimeout(job.watchdog);
    job.reject(err);
    this._next();
  }

  _snapshot(job) {
    const lines = [...job.lines.values()].sort((a, b) => a.multipv - b.multipv);
    return { id: job.id, fen: job.fen, depth: lines.length ? Math.min(...lines.map((l) => l.depth)) : 0, lines };
  }

  _waitFor(test, timeout) {
    return new Promise((resolve, reject) => {
      const w = { test, resolve, reject };
      w.timer = setTimeout(() => {
        this.lineWaiters.splice(this.lineWaiters.indexOf(w), 1);
        reject(new Error('Engine did not respond in time'));
      }, timeout);
      this.lineWaiters.push(w);
    });
  }

  _onExit(err) {
    this.proc = null;
    this.ready = null;
    this.restartPending = false;
    for (const w of this.lineWaiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
    const pending = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    for (const job of pending) { clearTimeout(job.watchdog); job.reject(err); }
    this.emit('exit', err);
  }

  /**
   * Queue a search.
   * job: { fen, go: 'depth 18' | 'movetime 1000' | 'infinite', searchmoves?, options?, newGame?, onInfo? }
   * Returns { id, promise, cancel() }. Throws a 400 error, before anything is queued, for
   * an illegal position or a value that is not what UCI expects (see checkJob).
   */
  submit(job) {
    const checked = checkJob(job);
    const id = ++jobCounter;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const full = { ...checked, id, resolve, reject, lines: new Map(), cancelled: false };
    this.queue.push(full);
    this._next();
    return { id, promise, cancel: () => this.cancel(id) };
  }

  cancel(id) {
    const qi = this.queue.findIndex((j) => j.id === id);
    if (qi >= 0) {
      const [job] = this.queue.splice(qi, 1);
      job.cancelled = true;
      job.resolve({ id, fen: job.fen, depth: 0, lines: [], bestmove: null, cancelled: true });
      return;
    }
    if (this.current && this.current.id === id && !this.current.cancelled) {
      this.current.cancelled = true;
      this.send('stop');
    }
  }

  /**
   * Start the next queued search if the engine is free. Never rejects: on the server
   * an unhandled rejection would stop the whole app.
   */
  _next() {
    this._runNext().catch((err) => {
      this._starting = false;
      console.error('[engine]', err);
    });
  }

  async _runNext() {
    if (this.current || !this.queue.length || this._starting) return;
    this._starting = true;
    try {
      await this.start();
    } catch (err) {
      this._starting = false;
      for (const job of this.queue.splice(0)) job.reject(err);
      return;
    }
    this._starting = false;
    // Settings changed while this engine was starting: start again with the new ones.
    if (this._swapIfRestarting()) { this._next(); return; }
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = job;

    const opts = { MultiPV: 1, 'Skill Level': 20, UCI_LimitStrength: 'false', ...(job.options || {}) };
    for (const [name, value] of Object.entries(opts)) this._setOption(name, value);
    if (job.newGame) this.send('ucinewgame');
    this.send(`position fen ${job.fen}`);
    const sm = job.searchmoves && job.searchmoves.length ? ` searchmoves ${job.searchmoves.join(' ')}` : '';
    this.send(`go ${job.go || 'depth 16'}${sm}`);
    this._watch(job);
  }

  info() {
    const spec = this.spec || this.specFor(this.role, this.getConfig());
    return {
      role: this.role,
      running: !!this.proc,
      name: this.name,
      kind: spec ? spec.kind : null,
      file: spec ? spec.label : null,
      threads: spec ? spec.options.Threads : null,
      hash: spec ? spec.options.Hash : null,
      warnings: spec ? spec.warnings : [],
    };
  }

  /**
   * Pick up new settings without failing anything in progress: a running search
   * finishes on the old process (an endless analysis is asked to stop), and queued
   * searches wait for a fresh process started with the new settings.
   */
  restart() {
    this.restartPending = true;
    if (this.current && /^infinite\b/.test(this.current.go || '')) this.send('stop');
    if (!this._starting) this._swapIfRestarting();
  }

  /** If a restart is due and no search is running, retire the old process. */
  _swapIfRestarting() {
    if (!this.restartPending || this.current) return false;
    this.restartPending = false;
    const proc = this.proc;
    this.send('quit'); // to the old process, while it is still this.proc
    this.proc = null;
    this.ready = null;
    this.spec = null;
    if (proc) setTimeout(() => proc.kill(), 500);
    return true;
  }

  quit() {
    if (this.proc) {
      this.send('quit');
      const p = this.proc;
      setTimeout(() => p.kill(), 500);
    }
  }
}

// ---------------------------------------------------------------------------
// High-level operations used by the web socket layer
// ---------------------------------------------------------------------------

class EngineManager {
  constructor(getConfig = () => ({})) {
    this.getConfig = getConfig;
    this.analysis = new UciEngine('analysis', getConfig);
    this.tasks = new UciEngine('tasks', getConfig);
  }

  restart() {
    this.analysis.restart();
    this.tasks.restart();
    this.warmUp();
  }

  warmUp() {
    this.analysis.start().catch((e) => console.warn('[engine]', e.message));
  }

  /**
   * Streaming multi-line analysis. The values come from the page: numbers are kept in
   * range, and a bad position is refused (see checkJob).
   * @param {{ fen: string, multipv?: unknown, depth?: unknown, movetime?: unknown, infinite?: unknown }} request
   * @param {(snapshot: any) => void} [onInfo]
   */
  analyse({ fen, multipv, depth, movetime, infinite }, onInfo) {
    const go = infinite ? 'infinite' : movetime ? `movetime ${clampInt(movetime, 50, 600000, 1000)}` : `depth ${clampInt(depth, 1, MAX_DEPTH, 22)}`;
    return this.analysis.submit({ fen, go, options: { MultiPV: clampInt(multipv, 1, 5, 3) }, onInfo });
  }

  /**
   * Score specific moves in a position, plus the engine's own best move.
   * Returns { best: {move, score, pv}, moves: [{move, score, pv}] } with White-POV scores.
   * A move that is not legal there is not searched and comes back with a null score.
   * @param {{ fen: string, moves?: unknown, depth?: unknown }} request
   */
  async evaluate({ fen, moves, depth }) {
    const d = clampInt(depth, 1, MAX_DEPTH, 14);
    const legal = new Set(parsePosition(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || '')));
    const unique = [...new Set(Array.isArray(moves) ? moves.map(String) : [])];
    const searched = unique.filter((m) => legal.has(m));
    const bestRun = this.tasks.submit({ fen, go: `depth ${d}`, options: { MultiPV: 1 } });
    const best = await bestRun.promise;
    let lines = [];
    if (searched.length) {
      const run = this.tasks.submit({
        fen,
        go: `depth ${d}`,
        searchmoves: searched,
        options: { MultiPV: searched.length },
      });
      lines = (await run.promise).lines;
    }
    const scored = unique.map((m) => {
      const line = lines.find((l) => l.pv[0] === m);
      return { move: m, score: line ? line.score : null, pv: line ? line.pv : [] };
    });
    const top = best.lines[0];
    return {
      fen,
      depth: d,
      best: top ? { move: top.pv[0], score: top.score, pv: top.pv } : { move: best.bestmove, score: null, pv: [] },
      moves: scored,
    };
  }

  /**
   * A one-off MultiPV search on the task engine. Resolves to { lines, bestmove }.
   * @param {{ fen: string, depth?: unknown, multipv?: unknown }} request
   */
  async lines({ fen, depth, multipv }) {
    const run = this.tasks.submit({ fen, go: `depth ${clampInt(depth, 1, MAX_DEPTH, 14)}`, options: { MultiPV: clampInt(multipv, 1, 8, 2) } });
    const res = await run.promise;
    return { lines: res.lines, bestmove: res.bestmove };
  }

  /**
   * Pick a move to play, optionally at a limited strength.
   * @param {{ fen: string, elo?: unknown, movetime?: unknown, newGame?: unknown }} request
   */
  async bestmove({ fen, elo, movetime, newGame = false }) {
    const rating = elo ? clampInt(elo, 1320, 3190, 3190) : 3190; // no Elo: full strength
    const options = rating < 3190
      ? { UCI_LimitStrength: 'true', UCI_Elo: rating }
      : { UCI_LimitStrength: 'false' };
    const run = this.tasks.submit({ fen, go: `movetime ${clampInt(movetime, 50, 10000, 800)}`, options, newGame: newGame === true });
    const res = await run.promise;
    const top = res.lines[0];
    return { move: res.bestmove, score: top ? top.score : null };
  }

  info() {
    return { analysis: this.analysis.info(), tasks: this.tasks.info() };
  }

  quit() {
    this.analysis.quit();
    this.tasks.quit();
  }
}

export { EngineManager, UciEngine, checkFen, parseInfo, toWhitePov, findNativeEngine, engineSpec, isNetworkPath };
