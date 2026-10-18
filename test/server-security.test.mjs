// Other websites open in the same browser must not be able to use the local server:
// not by DNS rebinding (a foreign Host header), not by cross-site requests, and not
// by opening the engine WebSocket.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

let server;
before(async () => { server = await startServer(); });
after(() => server && server.stop());

// Raw requests, so the Host and Origin headers are exactly what a browser would send.
function request({ method = 'GET', path = '/api/settings', host, origin, body } = {}) {
  const headers = { Host: host || `localhost:${server.port}` };
  if (origin) headers.Origin = origin;
  if (body) headers['Content-Type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function openSocket(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, origin ? { origin } : {});
    ws.once('message', (m) => { ws.close(); resolve(`open: ${JSON.parse(m).type}`); });
    ws.once('unexpected-response', (req, res) => { ws.terminate(); resolve(`refused: ${res.statusCode}`); });
    ws.once('error', (err) => resolve(`error: ${err.message}`));
  });
}

test('requests addressed to a local name are served', async () => {
  for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`, `[::1]:${server.port}`]) {
    assert.equal((await request({ host })).status, 200, host);
  }
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const host = `rebind.attacker.example:${server.port}`;
  assert.equal((await request({ host })).status, 403);
  assert.equal((await request({ host, path: '/' })).status, 403, 'static files too');
  const change = await request({ host, method: 'PUT', body: { enginePath: '\\\\attacker\\share\\x.exe' } });
  assert.equal(change.status, 403);
  assert.match(change.text, /Unexpected host/);
});

test('cross-site requests are refused and change nothing', async () => {
  for (const origin of ['https://some-other-site.example', `http://localhost:${server.port + 1}`, 'null']) {
    const res = await request({ method: 'PUT', origin, body: { reviewBatch: 99 } });
    assert.equal(res.status, 403, origin);
  }
  assert.equal(JSON.parse((await request()).text).reviewBatch, 20);
});

test("the app's own pages can still make changes", async () => {
  const origin = `http://localhost:${server.port}`;
  const res = await request({ method: 'PUT', origin, body: { reviewBatch: 33 } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).reviewBatch, 33);
});

test('the engine WebSocket only opens for our own pages', async () => {
  assert.equal(await openSocket('https://some-other-site.example'), 'refused: 403');
  assert.equal(await openSocket(`http://127.0.0.1:${server.port}`), 'open: hello');
  assert.equal(await openSocket(), 'open: hello', 'non-browser clients send no Origin');
});
