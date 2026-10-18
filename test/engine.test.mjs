// The UCI engine wrapper, driven by a fake engine (test/fixtures/fake-uci-engine.js)
// so failures can be staged in milliseconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UciEngine } = require('../engine.js');

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci-engine.js', import.meta.url));
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const fake = (mode) => ({ kind: 'wasm', cmd: process.execPath, args: [FAKE, mode], label: 'fake', options: {}, warnings: [] });
const search = (engine) => engine.submit({ fen: START_FEN, go: 'depth 1' }).promise;

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
  if (stuck.exitCode === null && stuck.signalCode === null) await once(stuck, 'exit'); // and killed

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
