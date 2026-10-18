// End-to-end smoke test: boots the real server against a throwaway data
// folder, checks the static files, the REST API and the Stockfish bridge.
// Run with:  npm run test:smoke

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.mjs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

let server = null;
let base;
let port;
let dataDir;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
  return { status: res.status, json, text };
}

try {
  server = await startServer();
  ({ base, port, dataDir } = server);

  await test('app shell and vendored packages are served', async () => {
    const page = await api('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /importmap/);
    for (const url of ['/js/app.js', '/vendor/chess.js/dist/esm/chess.js', '/vendor/chessground/dist/chessground.js',
      '/vendor/chessground/assets/chessground.cburnett.css']) {
      assert.equal((await api('GET', url)).status, 200, url);
    }
  });

  await test('settings: defaults, save and validation', async () => {
    const s = await api('GET', '/api/settings');
    assert.equal(s.json.reviewBatch, 20);
    const saved = await api('PUT', '/api/settings', { reviewBatch: 30, theme: 'purple' });
    assert.equal(saved.json.reviewBatch, 30);
    assert.equal(saved.json.theme, 'light');
    assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')), 'settings written to TRAINER_DATA_DIR');
    const schema = await api('GET', '/api/settings/schema');
    assert.ok(schema.json.sections.length > 0);
  });

  await test('repertoire create, read, progress, delete', async () => {
    const samples = await api('GET', '/api/samples');
    assert.equal(samples.json.length, 2);
    const sample = samples.json.find((s) => s.color === 'white');
    const created = await api('POST', '/api/repertoires', { name: sample.name, color: sample.color, pgn: sample.pgn });
    assert.equal(created.status, 200, created.text);
    const { id } = created.json;
    assert.equal((await api('GET', '/api/repertoires')).json.length, 1);
    assert.equal((await api('GET', `/api/repertoires/${id}`)).json.name, sample.name);
    const patched = await api('PATCH', `/api/repertoires/${id}/progress`, {
      cards: { k: { level: 1, due: 0 } }, tally: { date: '2026-01-01', correct: 2, wrong: 1, lines: 1 },
    });
    assert.deepEqual(patched.json.history[0], { date: '2026-01-01', correct: 2, wrong: 1, lines: 1 });
    assert.equal((await api('DELETE', `/api/repertoires/${id}`)).json.ok, true);
    assert.equal((await api('GET', `/api/repertoires/${id}`)).status, 404);
  });

  await test('bad input is rejected', async () => {
    assert.equal((await api('POST', '/api/repertoires', { name: '', color: 'red', pgn: '' })).status, 400);
    assert.equal((await api('GET', '/api/repertoires/..%2Fsettings')).status, 400);
    assert.equal((await api('GET', '/api/nope')).status, 404);
  });

  await test('lichess starts disconnected', async () => {
    const s = await api('GET', '/api/lichess/status');
    assert.equal(s.json.connected, false);
  });

  await test('Stockfish answers over the WebSocket bridge', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      const result = await withTimeout(new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'evaluate', id: 1, fen: START_FEN, moves: ['e2e4', 'g1f3'], depth: 8 }));
          if (msg.id === 1 && msg.type === 'result') resolve(msg);
          if (msg.id === 1 && msg.type === 'error') reject(new Error(msg.message));
        });
      }), 90000, 'engine evaluate');
      assert.match(result.best.move, /^[a-h][1-8][a-h][1-8]/);
      assert.equal(result.moves.length, 2);
      assert.ok(result.moves.every((m) => m.score), 'every move scored');
    } finally {
      ws.close();
    }
  });

  await test('changing an engine setting mid-search does not fail the search', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const answers = new Map();
    const answer = (id) => new Promise((resolve, reject) => answers.set(id, { resolve, reject }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const waiting = answers.get(msg.id);
      if (waiting && msg.type === 'result') waiting.resolve(msg);
      if (waiting && msg.type === 'error') waiting.reject(new Error(msg.message));
    });
    try {
      await withTimeout(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }), 10000, 'socket open');
      const first = answer(2);
      ws.send(JSON.stringify({ type: 'evaluate', id: 2, fen: START_FEN, moves: ['d2d4'], depth: 12 }));
      const saved = await api('PUT', '/api/settings', { taskHash: 32 }); // restarts Stockfish
      assert.equal(saved.status, 200);
      assert.ok((await withTimeout(first, 90000, 'search during restart')).best.move, 'the running search still answered');
      const second = answer(3);
      ws.send(JSON.stringify({ type: 'evaluate', id: 3, fen: START_FEN, moves: ['e2e4'], depth: 8 }));
      assert.ok((await withTimeout(second, 90000, 'search after restart')).best.move, 'the restarted engine answers');
    } finally {
      ws.close();
    }
  });
} catch (err) {
  console.error(`  FAIL ${err.message}`);
  process.exitCode = 1;
} finally {
  if (server) server.stop();
}

if (process.exitCode && server) console.error(`\nServer output:\n${server.output()}`);
console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
