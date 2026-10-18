// UCI engine bridge.
//
// Talks to Stockfish over the Universal Chess Interface (plain text over
// stdin/stdout). Works with either:
//   - a native binary (e.g. stockfish-windows-x86-64-avx2.exe) — fastest, or
//   - the WebAssembly build that ships in the `stockfish` npm package, run
//     under Node — zero setup, installed by `npm install`.

'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, 'engine');

// ---------------------------------------------------------------------------
// Locating an engine
// ---------------------------------------------------------------------------

function findNativeEngine(customPath) {
  for (const candidate of [customPath, process.env.STOCKFISH_PATH]) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
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
    const findEngine = require('stockfish').findEngine;
    return findEngine(flavour);
  } catch (err) {
    return null;
  }
}

const WASM_HASH_MAX = 512;

/**
 * Describe how to launch the engine for a role, from the user's settings.
 *  analysis: Explore and the eval bar
 *  tasks:    mistake verdicts, the mistake finder, audits, sparring
 */
function engineSpec(role, cfg = {}) {
  const cores = Math.max(1, os.cpus().length);
  const build = cfg.engineBuild || 'auto';
  const threads = Math.max(1, Math.min(cores, (role === 'analysis' ? cfg.analysisThreads : cfg.taskThreads) || 1));
  const hash = Math.max(16, (role === 'analysis' ? cfg.analysisHash : cfg.taskHash) || 64);
  const warnings = [];

  if (build === 'auto' || build === 'native') {
    const native = findNativeEngine(cfg.enginePath);
    if (native) {
      return { kind: 'native', cmd: native, args: [], label: path.basename(native), options: { Threads: threads, Hash: hash }, warnings };
    }
    if (build === 'native') warnings.push(cfg.enginePath ? `No engine found at ${cfg.enginePath}; using the built-in one.` : 'No stockfish .exe in the engine folder; using the built-in one.');
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
// One engine process with a job queue
// ---------------------------------------------------------------------------

let jobCounter = 0;

class UciEngine extends EventEmitter {
  constructor(role, getConfig = () => ({})) {
    super();
    this.role = role;
    this.getConfig = getConfig;
    this.proc = null;
    this.ready = null; // Promise resolved after uciok/readyok
    this.name = null;
    this.spec = null;
    this.optionState = {}; // last values we sent via setoption
    this.queue = [];
    this.current = null;
    this.buffer = '';
    this.lineWaiters = [];
  }

  start() {
    if (this.ready) return this.ready;
    const spec = engineSpec(this.role, this.getConfig());
    if (!spec) {
      this.ready = Promise.reject(new Error('No Stockfish engine found. Run "npm install" or put stockfish.exe in the engine folder.'));
      this.ready.catch(() => {});
      return this.ready;
    }
    this.spec = spec;
    this.optionState = {};
    const proc = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    // Ignore anything from a process we have already replaced (after a settings change).
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this._onData(chunk); });
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => { if (this.proc === proc) this._onExit(err); });
    proc.on('exit', (code) => { if (this.proc === proc) this._onExit(new Error(`Engine exited (code ${code})`)); });
    this.buffer = '';

    this.ready = (async () => {
      this.send('uci');
      await this._waitFor((l) => {
        if (l.startsWith('id name ')) this.name = l.slice(8).trim();
        return l === 'uciok';
      }, 60000);
      for (const [name, value] of Object.entries(spec.options)) this._setOption(name, value);
      await this.isReady();
    })();
    this.ready.catch(() => {});
    return this.ready;
  }

  send(cmd) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  async isReady() {
    this.send('isready');
    await this._waitFor((l) => l === 'readyok', 60000);
  }

  _setOption(name, value) {
    if (this.optionState[name] === value) return;
    this.optionState[name] = value;
    this.send(`setoption name ${name} value ${value}`);
  }

  _onData(chunk) {
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
      job.resolve(result);
      this._next();
    }
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
    if (!this.proc) return;
    this.proc = null;
    this.ready = null;
    for (const w of this.lineWaiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
    const pending = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    for (const job of pending) job.reject(err);
    this.emit('exit', err);
  }

  /**
   * Queue a search.
   * job: { fen, moves?, go: 'depth 18' | 'movetime 1000' | 'infinite', searchmoves?, options?, onInfo? }
   * Returns { id, promise, cancel() }.
   */
  submit(job) {
    const id = ++jobCounter;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const full = { ...job, id, resolve, reject, lines: new Map(), cancelled: false };
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

  async _next() {
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
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = job;

    const opts = { MultiPV: 1, 'Skill Level': 20, UCI_LimitStrength: 'false', ...(job.options || {}) };
    for (const [name, value] of Object.entries(opts)) this._setOption(name, value);
    if (job.newGame) this.send('ucinewgame');
    const moves = job.moves && job.moves.length ? ` moves ${job.moves.join(' ')}` : '';
    this.send(`position fen ${job.fen}${moves}`);
    const sm = job.searchmoves && job.searchmoves.length ? ` searchmoves ${job.searchmoves.join(' ')}` : '';
    this.send(`go ${job.go || 'depth 16'}${sm}`);
  }

  info() {
    const spec = this.spec || engineSpec(this.role, this.getConfig()) || {};
    return {
      role: this.role,
      running: !!this.proc,
      name: this.name,
      kind: spec.kind || null,
      file: spec.label || null,
      threads: spec.options ? spec.options.Threads : null,
      hash: spec.options ? spec.options.Hash : null,
      warnings: spec.warnings || [],
    };
  }

  /** Stop the process; the next job starts a fresh one with the current settings. */
  restart() {
    const proc = this.proc;
    if (!proc) { this.ready = null; this.spec = null; return; }
    this._onExit(new Error('Stockfish restarted with new settings'));
    try { proc.stdin.write('quit\n'); } catch (err) { /* already closed */ }
    setTimeout(() => { try { proc.kill(); } catch (err) { /* gone */ } }, 500);
    this.spec = null;
  }

  quit() {
    if (this.proc) {
      this.send('quit');
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch (e) { /* already gone */ } }, 500);
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

  /** Streaming multi-line analysis. */
  analyse({ fen, multipv = 3, depth, movetime, infinite }, onInfo) {
    const go = infinite ? 'infinite' : movetime ? `movetime ${movetime}` : `depth ${depth || 22}`;
    return this.analysis.submit({ fen, go, options: { MultiPV: Math.max(1, Math.min(5, multipv)) }, onInfo });
  }

  /**
   * Score specific moves in a position, plus the engine's own best move.
   * Returns { best: {move, score, pv}, moves: [{move, score, pv}] } with White-POV scores.
   */
  async evaluate({ fen, moves, depth = 14 }) {
    const bestRun = this.tasks.submit({ fen, go: `depth ${depth}`, options: { MultiPV: 1 } });
    const best = await bestRun.promise;
    const unique = [...new Set(moves || [])];
    let scored = [];
    if (unique.length) {
      const run = this.tasks.submit({
        fen,
        go: `depth ${depth}`,
        searchmoves: unique,
        options: { MultiPV: unique.length },
      });
      const res = await run.promise;
      scored = unique.map((m) => {
        const line = res.lines.find((l) => l.pv[0] === m);
        return { move: m, score: line ? line.score : null, pv: line ? line.pv : [] };
      });
    }
    const top = best.lines[0];
    return {
      fen,
      depth,
      best: top ? { move: top.pv[0], score: top.score, pv: top.pv } : { move: best.bestmove, score: null, pv: [] },
      moves: scored,
    };
  }

  /** A one-off MultiPV search on the task engine. Resolves to { lines, bestmove }. */
  async lines({ fen, depth = 14, multipv = 2 }) {
    const run = this.tasks.submit({ fen, go: `depth ${depth}`, options: { MultiPV: Math.max(1, Math.min(8, multipv)) } });
    const res = await run.promise;
    return { lines: res.lines, bestmove: res.bestmove };
  }

  /** Pick a move to play, optionally at a limited strength. */
  async bestmove({ fen, elo, movetime = 800, newGame = false }) {
    const limited = elo && elo < 3190;
    const options = limited
      ? { UCI_LimitStrength: 'true', UCI_Elo: Math.max(1320, Math.min(3190, Math.round(elo))) }
      : { UCI_LimitStrength: 'false' };
    const run = this.tasks.submit({ fen, go: `movetime ${Math.max(50, Math.min(10000, movetime))}`, options, newGame });
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

module.exports = { EngineManager, UciEngine, parseInfo, toWhitePov, findNativeEngine, engineSpec };
