// End-to-end smoke test: boots the real server against a throwaway data
// folder, checks the static files, the REST API and the Stockfish bridge.
// Run with:  npm run test:smoke
//
// Never touches ./data or the network: TRAINER_DATA_DIR points at a temp
// folder and the Lichess URLs point at a closed local port.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-smoke-'));
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    TRAINER_DATA_DIR: dataDir,
    LICHESS_URL: 'http://127.0.0.1:9',
    LICHESS_EXPLORER_URL: 'http://127.0.0.1:9',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });

function stopServer() {
  if (server.exitCode !== null) return;
  // The server spawns Stockfish children; on Windows kill() would orphan them.
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (err) { /* already gone */ }
  } else {
    server.kill('SIGTERM');
  }
}

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
  await withTimeout(new Promise((resolve, reject) => {
    server.stdout.on('data', () => { if (output.includes('is running')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited with code ${code}`)));
  }), 30000, 'server start');

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
} catch (err) {
  console.error(`  FAIL ${err.message}`);
  process.exitCode = 1;
} finally {
  stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (process.exitCode) console.error(`\nServer output:\n${output}`);
console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
