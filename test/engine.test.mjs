// The UCI engine wrapper, driven by a fake engine (test/fixtures/fake-uci-engine.js)
// so failures can be staged in milliseconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import stockfish from 'stockfish';
import { EngineManager, UciEngine, checkFen, engineSpec, isNetworkPath, parseInfo, toWhitePov, findNativeEngine } from '../engine.js';
import { START_FEN } from '../public/js/constants.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci-engine.js', import.meta.url));
const fake = (mode, ...flags) => ({ kind: 'wasm', cmd: process.execPath, args: [FAKE, mode, ...flags], label: 'fake', options: {}, warnings: [] });
const search = (engine, go = 'depth 1') => engine.submit({ fen: START_FEN, go }).promise;

async function exited(proc) {
  if (proc.exitCode === null && proc.signalCode === null) await once(proc, 'exit');
}

async function waitUntil(condition, ms = 5000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// --- basics and start-up -------------------------------------------------------------

test('a working engine answers queued searches in turn', async () => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok') });
  const [a, b] = await Promise.all([search(engine), search(engine)]);
  assert.equal(a.bestmove, 'e2e4');
  assert.equal(b.bestmove, 'e2e4');
  assert.deepEqual(a.lines[0].score, { cp: 30 });
  engine.quit();
});

test('an engine that never finishes starting is replaced on the next job', async () => {
  let mode = 'mute';
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake(mode), startTimeout: 300 });
  const pending = search(engine);
  const stuck = engine.proc;
  await assert.rejects(pending, /did not respond in time/);

  assert.equal(engine.proc, null, 'the stuck process is dropped');
  await exited(stuck);

  mode = 'ok';
  assert.equal((await search(engine)).bestmove, 'e2e4', 'the next job starts a fresh engine');
  assert.notEqual(engine.proc, stuck);
  engine.quit();
});

test('a missing engine is looked for again on the next job', async () => {
  let spec = null;
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => spec });
  await assert.rejects(search(engine), /No Stockfish engine found/);

  spec = fake('ok');
  assert.equal((await search(engine)).bestmove, 'e2e4');
  engine.quit();
});

// --- stuck and slow searches (#3) ----------------------------------------------------

test('a stuck search is abandoned and the queue carries on with a fresh engine', async () => {
  let spawns = 0;
  const engine = new UciEngine('tasks', () => ({}), {
    specFor: () => (spawns++ === 0 ? fake('hang') : fake('ok', '--move=d2d4')),
    stallTimeout: 200,
    stopGrace: 100,
  });
  const stuckSearch = search(engine);
  const queued = search(engine);
  await waitUntil(() => engine.current);
  const stuck = engine.proc;

  await assert.rejects(stuckSearch, /stopped responding/);
  assert.equal((await queued).bestmove, 'd2d4', 'the queued search ran on a fresh engine');
  await exited(stuck);
  engine.quit();
});

test('a silent but healthy search is stopped, keeps its answer and its engine', async () => {
  const engine = new UciEngine('tasks', () => ({}), {
    specFor: () => fake('ok', '--until-stop', '--stop-move=g1f3'),
    stallTimeout: 200,
    stopGrace: 1000,
  });
  const result = search(engine);
  await waitUntil(() => engine.current);
  const proc = engine.proc;
  assert.equal((await result).bestmove, 'g1f3');
  assert.equal(engine.proc, proc, 'not replaced');
  engine.quit();
});

test('a long search that keeps reporting progress is left alone', async () => {
  const engine = new UciEngine('tasks', () => ({}), {
    specFor: () => fake('ok', '--delay=700', '--chatty', '--stop-move=a2a3'),
    stallTimeout: 200,
  });
  assert.equal((await search(engine)).bestmove, 'e2e4', 'finished on its own, never stopped');
  engine.quit();
});

// --- settings restarts (#12) ---------------------------------------------------------

test('a restart lets the running search finish and moves queued ones to a fresh engine', async () => {
  let move = 'e2e4';
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok', '--delay=300', `--move=${move}`) });
  const running = search(engine);
  const queued = search(engine);
  await waitUntil(() => engine.current);
  const old = engine.proc;

  move = 'd2d4'; // what the engine started with the new settings plays
  engine.restart();
  assert.equal((await running).bestmove, 'e2e4', 'finished on the old engine');
  assert.equal((await queued).bestmove, 'd2d4', 'ran on the new engine');
  assert.notEqual(engine.proc, old);
  await exited(old);
  engine.quit();
});

test('an endless analysis is stopped so a restart is not held up', async () => {
  let move = 'e2e4';
  const engine = new UciEngine('analysis', () => ({}), { specFor: () => fake('ok', `--move=${move}`) });
  const analysis = search(engine, 'infinite');
  await waitUntil(() => engine.current);

  move = 'd2d4';
  engine.restart();
  assert.equal((await analysis).bestmove, 'e2e4', 'answered, not failed');
  assert.equal((await search(engine)).bestmove, 'd2d4');
  engine.quit();
});

test('a restart during start-up applies to the engine being started', async () => {
  let move = 'e2e4';
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok', '--start-delay=200', `--move=${move}`) });
  const pending = search(engine);

  move = 'd2d4';
  engine.restart();
  assert.equal((await pending).bestmove, 'd2d4');
  engine.quit();
});

// --- what reaches the engine ---------------------------------------------------------

test('an illegal position or a smuggled command is refused before it reaches the engine', async (t) => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok') });
  t.after(() => engine.quit()); // even when an assertion fails, so the fake engine never outlives the test
  const refused = [
    { fen: '8/8/8/8/8/8/8/8 w - - 0 1' }, // no kings: Stockfish hangs on it
    { fen: '4k3/8/8/8/8/8/8/4R1K1 w - - 0 1' }, // Black is in check with White to move
    { fen: 'rnbqkbnr/pppppppp/8/3n4/3N4/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }, // 34 pieces: Stockfish refuses it, then goes silent
    { fen: `${START_FEN}\nquit` },
    { fen: START_FEN, go: 'depth 1\nquit' },
    { fen: START_FEN, searchmoves: ['e2e4\nquit'] },
    { fen: START_FEN, searchmoves: ['e2e4 e7e5'] },
    { fen: START_FEN, options: { MultiPV: '1\nquit' } },
    { fen: START_FEN, options: { 'MultiPV value 1\nquit': 1 } },
  ];
  for (const job of refused) {
    assert.throws(() => engine.submit({ go: 'depth 1', ...job }), { status: 400 }, JSON.stringify(job));
  }
  assert.equal(engine.proc, null, 'no engine was started for them');
  assert.equal((await search(engine)).bestmove, 'e2e4', 'a good search still runs');
});

test('a position is refused in words a player can act on, and stray spaces are forgiven', () => {
  assert.equal(checkFen(` ${START_FEN} \n`), START_FEN);
  /** @type {Array<[string, RegExp]>} */
  const refused = [
    [`${START_FEN} extra`, /\(a FEN has six parts separated by spaces\)/],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1', /\(the board needs 8 ranks separated by \/\)/],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w kq - 0 1', /\(White has no king\)/],
    ['4k3/8/8/8/8/8/8/4K2P w - - 0 1', /\(there is a pawn on the first or last rank\)/],
  ];
  for (const [fen, message] of refused) assert.throws(() => checkFen(fen), { status: 400, message }, fen);
});

test('a search Stockfish refuses fails at once, and the one behind it runs on a fresh engine', async (t) => {
  let starts = 0;
  const engine = new UciEngine('tasks', () => ({}), {
    specFor: () => fake(starts++ ? 'ok' : 'refuse'), // the first engine refuses, as Stockfish does past 32 pieces
    stallTimeout: 5000,
    stopGrace: 500,
  });
  t.after(() => engine.quit());
  const began = Date.now();
  const refused = search(engine);
  const behind = search(engine);
  const first = engine.proc;

  await assert.rejects(refused, { status: 400, message: /could not search that position \(Invalid FEN\. More than 32 pieces on the board\)/ });
  assert.ok(Date.now() - began < 2000, 'without waiting for the watchdog');
  assert.equal((await behind).bestmove, 'e2e4');
  assert.notEqual(engine.proc, first, 'the silent engine was replaced');
  await exited(first);
});

/** An engine manager on fake engines that records each job it submits. */
function recordingManager() {
  const engines = new EngineManager();
  const sent = [];
  for (const role of /** @type {const} */ (['analysis', 'tasks'])) {
    const engine = new UciEngine(role, () => ({}), { specFor: () => fake('ok') });
    const submit = engine.submit.bind(engine);
    engine.submit = (job) => { sent.push(job); return submit(job); };
    engines[role] = engine;
  }
  return { engines, sent };
}

test('numbers from the page are kept in range, and illegal moves are not searched', async (t) => {
  const { engines, sent } = recordingManager();
  t.after(() => engines.quit());

  await engines.analyse({ fen: START_FEN, depth: '5\nquit', multipv: 'lots' }, () => {}).promise;
  assert.equal(sent[0].go, 'depth 22');
  assert.equal(sent[0].options.MultiPV, 3);

  sent.length = 0;
  await assert.rejects(engines.evaluate({ fen: '8/8/8/8/8/8/8/8 w - - 0 1', moves: ['e2e4'] }), { status: 400 });
  assert.equal(sent.length, 0, 'a bad position is refused before any search is queued');
  const res = await engines.evaluate({ fen: START_FEN, moves: ['e2e4', 'e2e5', 'zz', 7], depth: 99 });
  assert.deepEqual(sent.map((j) => j.go), ['depth 50', 'depth 50']);
  assert.deepEqual(sent[1].searchmoves, ['e2e4'], 'only the legal move is searched');
  assert.deepEqual(res.moves.map((m) => [m.move, m.score]), [['e2e4', { cp: 30 }], ['e2e5', null], ['zz', null], ['7', null]]);

  sent.length = 0;
  await engines.bestmove({ fen: START_FEN, elo: '1500', movetime: 'soon' });
  await engines.bestmove({ fen: START_FEN, elo: null, movetime: 1e9 });
  assert.equal(sent[0].options.UCI_Elo, 1500);
  assert.equal(sent[0].go, 'movetime 800');
  assert.equal(sent[1].options.UCI_LimitStrength, 'false');
  assert.equal(sent[1].go, 'movetime 10000');
});

// --- engine paths --------------------------------------------------------------------

test('engines on a network share are never run or even looked at', (t) => {
  const realExists = fs.existsSync;
  const checked = [];
  t.mock.method(fs, 'existsSync', (p) => { checked.push(String(p)); return realExists(p); });

  for (const enginePath of ['\\\\attacker\\share\\sf.exe', '//attacker/share/sf.exe', '\\\\?\\UNC\\attacker\\share\\sf.exe']) {
    const spec = engineSpec('tasks', { engineBuild: 'native', enginePath });
    assert.ok(!String(spec.cmd).includes('attacker'), enginePath);
    assert.match(spec.warnings.join(' '), /network share/);
  }
  assert.deepEqual(checked.filter((p) => p.includes('attacker')), [], 'Windows would contact the server just to check');
});

test('local engine paths still work', () => {
  const spec = engineSpec('tasks', { engineBuild: 'native', enginePath: process.execPath });
  assert.equal(spec.kind, 'native');
  assert.equal(spec.cmd, path.resolve(process.execPath));
  assert.deepEqual(spec.warnings, []);
  for (const local of ['C:\\Chess\\sf.exe', '\\\\?\\C:\\Chess\\sf.exe', '\\\\.\\D:\\sf.exe', '/usr/local/bin/stockfish']) {
    assert.equal(isNetworkPath(local), false, local);
  }
});

// --- an engine that dies ---------------------------------------------------------------

test('an engine that dies mid-search fails its searches, and talking to it then does not stop the app', async (t) => {
  let starts = 0;
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake(starts++ ? 'ok' : 'crash') });
  t.after(() => engine.quit());
  // The app keeps writing to the engine (stop, a new position) until it hears of the exit;
  // a write in between fails with EPIPE, which must not become an uncaught error.
  const chatter = setInterval(() => engine.send('isready'), 1);
  t.after(() => clearInterval(chatter));
  const running = search(engine);
  const queued = search(engine);

  await assert.rejects(running, /Engine exited \(code 1\)/);
  await assert.rejects(queued, /Engine exited \(code 1\)/, 'the searches behind it fail too, rather than wait forever');
  await new Promise((resolve) => setTimeout(resolve, 100));
  clearInterval(chatter);
  assert.equal((await search(engine)).bestmove, 'e2e4', 'the next search starts a fresh engine');
});

test('an engine file that has gone fails its start, and the next job looks again', async (t) => {
  const gone = { ...fake('ok'), cmd: path.join(os.tmpdir(), 'no-such-dir', 'stockfish.exe'), args: [] };
  let spec = gone;
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => spec });
  t.after(() => engine.quit());
  await assert.rejects(search(engine), { code: 'ENOENT' });
  assert.equal(engine.proc, null);
  spec = fake('ok');
  assert.equal((await search(engine)).bestmove, 'e2e4');
});

test('an engine that cannot even be launched fails its start, and warming up does not stop the app', async (t) => {
  // Windows refuses some files at once, as spawn() throwing (EFTYPE: not a program; EINVAL: a .bat or .cmd);
  // a null byte in the path makes every system do the same.
  const bad = { ...fake('ok'), cmd: 'stock\u0000fish.exe', label: 'stockfish.exe' };
  const engine = new UciEngine('analysis', () => ({}), { specFor: () => bad });
  t.after(() => engine.quit());
  let start;
  assert.doesNotThrow(() => { start = engine.start(); });
  await assert.rejects(start, { message: 'Could not start stockfish.exe (ERR_INVALID_ARG_VALUE). Check the engine path in Settings.' });
  assert.equal(engine.proc, null);
  assert.equal(engine.info().file, 'stockfish.exe', 'looked for again, not remembered');

  const engines = new EngineManager();
  engines.analysis = engine;
  const warned = t.mock.method(console, 'warn', () => {});
  assert.doesNotThrow(() => engines.warmUp());
  await waitUntil(() => warned.mock.callCount() > 0);
  assert.match(warned.mock.calls[0].arguments[1], /^Could not start stockfish\.exe/);
});

// --- what the engine says ------------------------------------------------------------

test('UCI info lines are read field by field', () => {
  assert.equal(parseInfo('bestmove e2e4'), null);
  assert.equal(parseInfo('info string NNUE evaluation using nn-1111.nnue'), null, 'free text');
  assert.deepEqual(
    parseInfo('info depth 20 seldepth 28 multipv 2 score mate -3 upperbound nodes 1000 nps 500 hashfull 12 tbhits 0 time 2000 wdl 10 20 970 currmove e2e4 pv e7e5 g1f3'),
    { depth: 20, seldepth: 28, multipv: 2, score: { mate: -3 }, bound: 'upperbound', nodes: 1000, nps: 500, hashfull: 12, tbhits: 0, time: 2000, wdl: [10, 20, 970], pv: ['e7e5', 'g1f3'] },
  );
  assert.deepEqual(parseInfo('info depth 5 score cp 31 lowerbound pv e2e4'), { depth: 5, score: { cp: 31 }, bound: 'lowerbound', pv: ['e2e4'] });
});

test('scores are turned to White’s side', () => {
  const black = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  assert.equal(toWhitePov(null, black), null);
  assert.deepEqual(toWhitePov({ cp: 40 }, START_FEN), { cp: 40 });
  assert.deepEqual(toWhitePov({ cp: 40 }, black), { cp: -40 });
  assert.deepEqual(toWhitePov({ mate: 2 }, black), { mate: -2 });
  assert.deepEqual(toWhitePov({ mate: 2 }, undefined), { mate: 2 }, 'no position: as given');
});

test('a missing position, Black to move with White in check, or a problem in unfamiliar words, are all refused plainly', (t) => {
  assert.throws(() => checkFen(undefined), { status: 400, message: 'That is not a legal chess position (a FEN has six parts separated by spaces).' });
  assert.throws(() => checkFen('4k3/8/8/8/8/8/8/r3K3 b - - 0 1'), { status: 400, message: /the side not to move is in check/ });
  t.mock.method(Chess.prototype, 'load', () => { throw new Error('Invalid FEN: something new'); });
  assert.throws(() => checkFen(START_FEN), { status: 400, message: 'That is not a legal chess position.' });
});

/** An engine whose every command is recorded. */
function recorded(engine) {
  const sent = [];
  const send = engine.send.bind(engine);
  engine.send = (cmd) => { sent.push(cmd); send(cmd); };
  return sent;
}

test('the engine’s lines: a missing MultiPV number is line 1, a bound does not replace a settled line, no move is null', async (t) => {
  const info = [
    'info depth 6 score cp 20 pv e2e4 e7e5',
    'info depth 6 score cp 90 lowerbound pv d2d4',
    'info depth 7 multipv 2 score cp 10 upperbound pv c2c4',
  ].join('|');
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok', '--move=(none)', `--info=${info}`) });
  t.after(() => engine.quit());
  const sent = recorded(engine);
  const res = await engine.submit({ fen: START_FEN, newGame: true }).promise;
  assert.equal(res.bestmove, null, '"bestmove (none)": no legal move');
  assert.deepEqual(res.lines.map((l) => [l.multipv, l.pv[0], l.score, l.bound]), [[1, 'e2e4', { cp: 20 }, null], [2, 'c2c4', { cp: 10 }, 'upperbound']]);
  assert.equal(res.depth, 6);
  assert.ok(sent.includes('ucinewgame'));
  assert.ok(sent.includes(`position fen ${START_FEN}`), 'the position alone: the score is from its side to move');
  assert.ok(sent.includes('go depth 16'), 'the default search');
});

test('a search answered without any lines has depth 0', async (t) => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok', '--info=') });
  t.after(() => engine.quit());
  const res = await search(engine);
  assert.deepEqual([res.depth, res.lines, res.bestmove], [0, [], 'e2e4']);
});

// --- the queue ---------------------------------------------------------------------------

test('a queued search can be cancelled, and a running one is stopped with its answer so far', async (t) => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok', '--until-stop', '--stop-move=d2d4') });
  t.after(() => engine.quit());
  const sent = recorded(engine);
  const running = engine.submit({ fen: START_FEN, go: 'depth 30' });
  const queued = engine.submit({ fen: START_FEN, go: 'depth 30' });
  queued.cancel();
  assert.deepEqual(await queued.promise, { id: queued.id, fen: START_FEN, depth: 0, lines: [], bestmove: null, cancelled: true });

  await waitUntil(() => engine.current);
  running.cancel();
  running.cancel(); // a second click sends no second stop
  engine.cancel(-1); // and an unknown search is ignored
  const res = await running.promise;
  assert.equal(res.cancelled, true);
  assert.equal(res.bestmove, 'd2d4');
  assert.equal(sent.filter((c) => c === 'stop').length, 1);
});

test('a search cancelled while the engine starts never runs', async (t) => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok', '--start-delay=150') });
  t.after(() => engine.quit());
  const sent = recorded(engine);
  const run = engine.submit({ fen: START_FEN, go: 'depth 1' });
  run.cancel();
  assert.equal((await run.promise).cancelled, true);
  await engine.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.current, null);
  assert.ok(!sent.some((c) => c.startsWith('go')), 'nothing was searched');
});

test('an unexpected failure while starting the next search is logged, not thrown', async (t) => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok') });
  t.after(() => engine.quit());
  const logged = t.mock.method(console, 'error', () => {});
  const swap = t.mock.method(engine, '_swapIfRestarting', () => { throw new Error('unexpected'); });
  const stuck = engine.submit({ fen: START_FEN, go: 'depth 1' });
  await waitUntil(() => logged.mock.callCount() > 0);
  assert.equal(logged.mock.calls[0].arguments[0], '[engine]');
  assert.equal(engine._starting, false, 'the next search can still start');
  swap.mock.restore();
  engine._next();
  assert.equal((await stuck.promise).bestmove, 'e2e4');
});

test('a watchdog that outlives its search leaves the engine alone', async (t) => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok'), stallTimeout: 30, stopGrace: 10 });
  t.after(() => engine.quit());
  await engine.start(); // its start-up timers are cleared normally
  const sent = recorded(engine);
  // Every search clears its watchdog when it ends; here it cannot, so the watchdog fires late.
  const clear = t.mock.method(globalThis, 'clearTimeout', () => {});
  await search(engine);
  await new Promise((resolve) => setTimeout(resolve, 80));
  clear.mock.restore();
  assert.ok(!sent.includes('stop'), 'no stop for a search that is over');
  assert.equal((await search(engine)).bestmove, 'e2e4', 'and the same engine carries on');
});

test('a restart during a search that has no search limit lets it finish', async (t) => {
  const engine = new UciEngine('tasks', () => ({}), { specFor: () => fake('ok', '--delay=100') });
  t.after(() => engine.quit());
  const sent = recorded(engine);
  const run = engine.submit({ fen: START_FEN });
  await waitUntil(() => engine.current);
  engine.restart();
  assert.equal((await run.promise).bestmove, 'e2e4');
  assert.ok(!sent.includes('stop'), 'only an endless analysis is asked to stop');
});

// --- set-up and information -------------------------------------------------------------------

test('an engine made without settings is started with none, and its options are sent', async (t) => {
  let given;
  const engine = new UciEngine('tasks', undefined, { specFor: (role, cfg) => { given = cfg; return { ...fake('ok'), options: { Threads: 2, Hash: 32 } }; } });
  t.after(() => engine.quit());
  await search(engine);
  assert.deepEqual(given, {});
  assert.equal(engine.optionState.Threads, 2);
  assert.equal(engine.optionState.Hash, 32);
});

test('with no engine to be found, the engine information says so', () => {
  const engine = new UciEngine('analysis', undefined, { specFor: () => null });
  assert.deepEqual(engine.info(), { role: 'analysis', running: false, name: null, kind: null, file: null, threads: null, hash: null, warnings: [] });
});

/** An engine manager whose two engines are fake ones started with these flags. */
function fakeManager(t, ...flags) {
  const engines = new EngineManager();
  for (const role of /** @type {const} */ (['analysis', 'tasks'])) engines[role] = new UciEngine(role, () => ({}), { specFor: () => fake('ok', ...flags) });
  t.after(() => engines.quit());
  return engines;
}

test('the engine manager: endless and timed analysis, one-off lines, and answers without lines', async (t) => {
  const engines = fakeManager(t, '--info=', '--until-stop');
  const sent = { analysis: recorded(engines.analysis), tasks: recorded(engines.tasks) };
  const endless = engines.analyse({ fen: START_FEN, infinite: true });
  await waitUntil(() => engines.analysis.current);
  endless.cancel();
  await endless.promise;
  assert.ok(sent.analysis.includes('go infinite'));

  const quick = fakeManager(t, '--info=');
  const timed = quick.analyse({ fen: START_FEN, movetime: '20' }, undefined);
  assert.equal((await timed.promise).bestmove, 'e2e4');
  assert.deepEqual(await quick.lines({ fen: START_FEN, depth: '', multipv: null }), { lines: [], bestmove: 'e2e4' });
  const ev = await quick.evaluate({ fen: START_FEN, moves: 'e2e4' });
  assert.deepEqual(ev.best, { move: 'e2e4', score: null, pv: [] }, 'no lines: the best move without a score');
  assert.deepEqual(ev.moves, [], 'moves that are not a list are not searched');
  assert.deepEqual(await quick.bestmove({ fen: START_FEN, newGame: true }), { move: 'e2e4', score: null });
});

test('restarting the engine manager restarts both engines and warms up analysis', async (t) => {
  const engines = fakeManager(t);
  const analysis = t.mock.method(engines.analysis, 'restart');
  const tasks = t.mock.method(engines.tasks, 'restart');
  engines.restart();
  assert.equal(analysis.mock.callCount(), 1);
  assert.equal(tasks.mock.callCount(), 1);
  await waitUntil(() => engines.analysis.proc);
  await engines.analysis.ready;
});

test('an engine manager made without settings reads none', () => {
  const info = new EngineManager().info();
  assert.deepEqual(Object.keys(info), ['analysis', 'tasks']);
  assert.equal(info.analysis.role, 'analysis');
});

// --- where the engine comes from ------------------------------------------------------------------

const ENGINE_DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'engine');
const dirent = (name, file = true) => ({ name, isFile: () => file });

/** Run fn as if on this platform, with no STOCKFISH_PATH. */
function asIf(t, platform) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  const saved = process.env.STOCKFISH_PATH;
  delete process.env.STOCKFISH_PATH;
  t.after(() => {
    Object.defineProperty(process, 'platform', real);
    if (saved !== undefined) process.env.STOCKFISH_PATH = saved;
  });
}

test('the engine folder: a Windows .exe, or on other systems a binary that is not a network or data file', (t) => {
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, options) => (path.resolve(String(dir)) === ENGINE_DIR
    ? [dirent('stockfish.nnue'), dirent('README.txt'), dirent('stockfish_16.exe'), dirent('stockfish-ubuntu'), dirent('stockfish-old', false), dirent('notes.md')]
    : realReaddir(dir, options)));
  asIf(t, 'win32');
  assert.equal(findNativeEngine(), path.join(ENGINE_DIR, 'stockfish_16.exe'));
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  assert.equal(findNativeEngine(), path.join(ENGINE_DIR, 'stockfish-ubuntu'));
});

test('without an engine folder or a native engine, the built-in one is used', (t) => {
  asIf(t, process.platform);
  const realExists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => (path.resolve(String(p)) === ENGINE_DIR ? false : realExists(p)));
  assert.equal(findNativeEngine(), null);
  const spec = engineSpec('tasks');
  assert.equal(spec.kind, 'wasm');
  assert.deepEqual(spec.warnings, []);
  assert.match(engineSpec('tasks', { engineBuild: 'native' }).warnings[0], /^No stockfish \.exe in the engine folder; using the built-in one\.$/);
  assert.match(engineSpec('tasks', { engineBuild: 'native', enginePath: 'C:\\nowhere\\sf.exe' }).warnings[0], /^No engine found at C:\\nowhere\\sf\.exe; using the built-in one\.$/);
});

test('the built-in engine: the lite build for tasks, a fallback build, a hash cap, and none at all', (t) => {
  asIf(t, process.platform);
  const realExists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => (path.resolve(String(p)) === ENGINE_DIR ? false : realExists(p)));
  const asked = [];
  const find = t.mock.method(stockfish, 'findEngine', (flavour) => {
    asked.push(flavour);
    if (flavour === 'lite-single') return '/engines/stockfish-lite-single.js';
    throw new Error(`no ${flavour} build`);
  });
  const spec = engineSpec('analysis', { engineBuild: 'builtin-lite', analysisHash: 4096 });
  assert.deepEqual(asked, ['lite', 'lite-single']);
  assert.equal(spec.label, 'stockfish-lite-single.js');
  assert.equal(spec.options.Hash, 512);
  assert.match(spec.warnings.join(' '), /at most 512 MB/);

  find.mock.mockImplementation(() => { throw new Error('not installed'); });
  assert.equal(engineSpec('tasks'), null);
});
