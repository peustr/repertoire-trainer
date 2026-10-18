// The UCI engine wrapper, driven by a fake engine (test/fixtures/fake-uci-engine.js)
// so failures can be staged in milliseconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineManager, UciEngine, engineSpec, isNetworkPath } from '../engine.js';
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
    { fen: START_FEN, moves: ['e2e4 e7e5'] },
    { fen: START_FEN, options: { MultiPV: '1\nquit' } },
  ];
  for (const job of refused) {
    assert.throws(() => engine.submit({ go: 'depth 1', ...job }), { status: 400 }, JSON.stringify(job));
  }
  assert.equal(engine.proc, null, 'no engine was started for them');
  assert.equal((await search(engine)).bestmove, 'e2e4', 'a good search still runs');
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
