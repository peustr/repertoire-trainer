// The engine WebSocket protocol (public/js/protocol.js) as the real server speaks it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from './helpers/server.mjs';
import { REQUEST, REPLY } from '../public/js/protocol.js';

let server;
before(async () => { server = await startServer(); });
after(() => server && server.stop());

/** Open the socket as the app's own page would, and collect what the server sends. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: server.base } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const next = (match, what) => {
    const seen = inbox.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${what} within 5 s`)), 5000);
      waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };
  return { ws, next, send: (msg) => ws.send(JSON.stringify(msg)) };
}

test('the server greets each page with the engines it runs', async () => {
  const { ws, next } = await connect();
  const hello = await next((m) => m.type === REPLY.HELLO, 'hello');
  assert.ok(hello.engine && hello.engine.analysis && hello.engine.tasks);
  ws.close();
});

test('a request the server does not know is answered with an error, not silence', async () => {
  const { ws, next, send } = await connect();
  send({ type: 'analyze', id: 8 }); // misspelt
  const res = await next((m) => m.id === 8, 'answer to an unknown request');
  assert.equal(res.type, REPLY.ERROR);
  assert.match(res.message, /analyze/);
  ws.close();
});

test('the protocol names each message once', () => {
  const values = [...Object.values(REQUEST), ...Object.values(REPLY)];
  assert.equal(new Set(Object.values(REQUEST)).size, Object.values(REQUEST).length);
  assert.equal(new Set(Object.values(REPLY)).size, Object.values(REPLY).length);
  assert.ok(values.every((v) => typeof v === 'string' && v));
  assert.ok(Object.isFrozen(REQUEST) && Object.isFrozen(REPLY));
});

test('a message that is not a request object is ignored, and the server keeps going', async () => {
  const junk = await connect();
  for (const raw of ['null', '5', '"analyse"', '[]', 'not json']) junk.ws.send(raw);
  await new Promise((r) => setTimeout(r, 500)); // long enough for a crash to happen
  junk.ws.close();
  const { ws, next } = await connect();
  assert.ok((await next((m) => m.type === REPLY.HELLO, 'greeting after the junk')).engine);
  ws.close();
});

test('an illegal position is refused at once instead of tying up Stockfish', async (t) => {
  const res = await fetch(`${server.base}/api/repertoires`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bad positions', color: 'white', pgn: '1. e4 e5 *' }),
  });
  const rep = await res.json();
  const { ws, next, send } = await connect();
  t.after(() => ws.close()); // an open socket would keep the test process alive after a failure
  const kingless = '8/8/8/8/8/8/8/8 w - - 0 1';
  const crowded = 'rnbqkbnr/pppppppp/8/3n4/3N4/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'; // 34 pieces: Stockfish refuses it, then goes silent
  send({ type: REQUEST.ANALYSE, id: 10, fen: kingless, depth: 5 });
  send({ type: REQUEST.PUZZLE_SEARCH, id: 11, repId: rep.id, fen: kingless });
  send({ type: REQUEST.EVALUATE, id: 12, fen: crowded, moves: ['e2e4'], depth: 5 });
  for (const id of [10, 11, 12]) {
    const answer = await next((m) => m.id === id && m.type !== REPLY.INFO, `answer to request ${id}`);
    assert.equal(answer.type, REPLY.ERROR);
    assert.match(answer.message, /not a legal chess position/);
  }
});
