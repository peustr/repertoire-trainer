// The UCI engine wrapper, driven by a fake engine (test/fixtures/fake-uci-engine.js)
// so failures can be staged in milliseconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UciEngine, engineSpec, isNetworkPath } = require('../engine.js');

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci-engine.js', import.meta.url));
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
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
