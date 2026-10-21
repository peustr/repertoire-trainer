// The REST API of the real server (server.js) against the mock Lichess: requests without a
// body, bodies it cannot read, unexpected errors, the settings schema and samples, the
// Lichess routes and sign-in, and the puzzle routes. Runs against a throwaway data folder.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { startMockLichess } from './helpers/mock-lichess.mjs';
import { START_FEN } from '../public/js/constants.js';

const PGN = '1. e4 e5 2. Nf3 Nc6 *';
let mock;
let server;
before(async () => {
  mock = await startMockLichess();
  server = await startServer({ env: { LICHESS_URL: mock.url, LICHESS_EXPLORER_URL: mock.url } });
});
after(async () => {
  if (server) await server.stop();
  if (mock) await mock.stop();
});

/**
 * A request as the app's pages make it; a body is sent as JSON.
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body]
 */
async function api(method, url, body) {
  const init = { method, redirect: /** @type {const} */ ('manual'), headers: {} };
  if (body !== undefined) Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const res = await fetch(server.base + url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
  return { status: res.status, json, location: res.headers.get('location') };
}

test('requests sent without a body get the same answers as an empty one', async () => {
  assert.deepEqual(await api('POST', '/api/repertoires'), { status: 400, json: { error: 'Give the repertoire a name. Choose White or Black. Paste or upload some PGN.' }, location: null });
  const rep = (await api('POST', '/api/repertoires', { name: 'Bodiless', color: 'white', pgn: PGN })).json;
  assert.equal((await api('PUT', `/api/repertoires/${rep.id}`)).json.name, 'Bodiless', 'nothing to change');
  assert.equal((await api('POST', `/api/repertoires/${rep.id}/lines`)).json.error, 'The line to add is missing.');
  assert.deepEqual((await api('PATCH', `/api/repertoires/${rep.id}/progress`)).json.cards, {});
  assert.equal((await api('PUT', '/api/settings')).json.reviewBatch, 20);
  assert.equal((await api('POST', '/api/lichess/token')).json.error, 'That does not look like a Lichess token.');
  assert.equal((await api('POST', `/api/repertoires/${rep.id}/puzzles/p1/add-line`)).status, 404);
  assert.equal((await api('DELETE', `/api/repertoires/${rep.id}/gaps`)).status, 200, 'no key: nothing removed');
});

test('the settings page gets its schema, and an engine setting restarts the engine with it', async () => {
  const { json } = await api('GET', '/api/settings/schema');
  assert.ok(json.sections.length > 0);
  assert.equal(json.defaults.reviewBatch, 20);
  assert.ok(json.machine.cores >= 1);
  assert.ok(json.engine.analysis);
  assert.equal((await api('PUT', '/api/settings', { analysisHash: 48 })).json.analysisHash, 48);
  assert.equal((await api('GET', '/api/engine')).json.analysis.hash, 48, 'the restarted engine uses it');
});

test('the samples are offered with their names and colours', async () => {
  const { json } = await api('GET', '/api/samples');
  const byFile = Object.fromEntries(json.map((s) => [s.file, s]));
  assert.deepEqual([byFile['caro-kann-black.pgn'].name, byFile['caro-kann-black.pgn'].color], ['Caro-Kann (Black)', 'black']);
  assert.deepEqual([byFile['italian-game-white.pgn'].name, byFile['italian-game-white.pgn'].color], ['Italian Game (White)', 'white']);
  for (const sample of json) {
    assert.match(sample.pgn, /\[RepertoireName "[^"]+"\]/, `${sample.file} names its repertoire`);
    assert.match(sample.pgn, /\[Repertoire "(white|black)"\]/, `${sample.file} gives its colour`);
  }
});

test('the explorer, studies and account go through the app’s Lichess client', async () => {
  assert.equal((await api('POST', '/api/lichess/token', { token: 'no!' })).status, 400);
  assert.equal((await api('POST', '/api/lichess/token', { token: 'lip_testToken123' })).json.connected, true);
  const fen = encodeURIComponent(START_FEN);
  const masters = await api('GET', `/api/lichess/explorer?fen=${fen}&source=masters&speeds=blitz&ratings=1600`);
  assert.equal(masters.json.source, 'masters');
  const lichess = await api('GET', `/api/lichess/explorer?fen=${fen}`);
  assert.equal(lichess.json.source, 'lichess', 'speeds and ratings from the settings');
  assert.ok(lichess.json.total > 0);
  assert.equal((await api('GET', '/api/lichess/study?url=AbCd1234')).json.studyId, 'AbCd1234');
  assert.deepEqual((await api('GET', '/api/lichess/studies')).json.map((s) => s.name), ['Mock study', 'Sicilian prep']);
  assert.equal((await api('DELETE', '/api/lichess/token')).json.connected, false);
});

test('Lichess sign-in: the start goes to Lichess, and the way back connects or says why not', async () => {
  const start = await api('GET', '/auth/lichess/start');
  assert.equal(start.status, 302);
  const approval = await fetch(start.location, { redirect: 'manual' });
  const back = new URL(approval.headers.get('location'));
  assert.equal(back.origin, server.base, 'Lichess sends the user back to this server');
  const done = await api('GET', back.pathname + back.search);
  assert.equal(done.location, '/#/lichess?connected=1');
  const cancelled = await api('GET', '/auth/lichess/callback?error=access_denied');
  assert.equal(cancelled.location, `/#/lichess?error=${encodeURIComponent('Lichess sign-in was cancelled (access_denied).')}`);
  await api('DELETE', '/api/lichess/token');
});

test('puzzles are added as a line and dismissed; gaps too; progress reset; repertoires deleted', async () => {
  const rep = (await api('POST', '/api/repertoires', { name: 'Puzzled', color: 'white', pgn: PGN })).json;
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  // Only the mistake search saves puzzles: the page has no route to write them.
  assert.deepEqual((await api('POST', `/api/repertoires/${rep.id}/puzzles`, { puzzles: [{ id: 'p1', fen }] })).json, { error: 'Unknown API route' });
  const file = path.join(server.dataDir, 'repertoires', `${rep.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), puzzles: { p1: { id: 'p1', fen }, p2: { id: 'p2', fen } } }));
  const added = await api('POST', `/api/repertoires/${rep.id}/puzzles/p1/add-line`, { pgn: '1. e4 e5 2. Qh5 *' });
  assert.match(added.json.pgn, /Qh5/);
  assert.deepEqual(Object.keys((await api('DELETE', `/api/repertoires/${rep.id}/puzzles/p2`)).json.puzzles), ['p1']);

  await api('PATCH', `/api/repertoires/${rep.id}/progress`, { cards: { k: { level: 2, due: 0 } } });
  assert.deepEqual((await api('DELETE', `/api/repertoires/${rep.id}/progress`)).json.cards, {});
  assert.deepEqual((await api('DELETE', `/api/repertoires/${rep.id}/gaps?key=${encodeURIComponent('x')}`)).json.gaps, undefined);
  assert.deepEqual((await api('DELETE', `/api/repertoires/${rep.id}`)).json, { ok: true });
  assert.equal((await api('DELETE', `/api/repertoires/${rep.id}`)).status, 404);
  assert.deepEqual((await api('GET', '/api/nothing-here')).json, { error: 'Unknown API route' });
});

test('a body that is not JSON, in an unknown charset or too large gets a JSON answer', async () => {
  const post = (headers, body) => fetch(`${server.base}/api/repertoires`, { method: 'POST', headers, body });
  const broken = await post({ 'Content-Type': 'application/json' }, '{"name": ');
  assert.deepEqual([broken.status, await broken.json()], [400, { error: 'The request was not valid JSON.' }]);
  const charset = await post({ 'Content-Type': 'application/json; charset=latin1' }, '{}');
  assert.equal(charset.status, 415);
  assert.match((await charset.json()).error, /unsupported charset "LATIN1"/);

  // Over the 20 MB limit. The server answers once the whole body has arrived.
  const tooLarge = await post({ 'Content-Type': 'application/json' }, ' '.repeat(21 * 2 ** 20));
  const answer = await tooLarge.text();
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(JSON.parse(answer), { error: 'That is too much to send in one go: the trainer takes at most 20 MB at a time.' });
});

test('a request without a Host header is refused', async () => {
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(server.port, '127.0.0.1', () => socket.end('GET /api/settings HTTP/1.0\r\n\r\n'));
    let text = '';
    socket.on('data', (d) => { text += d; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.\d 403/);
  assert.match(reply, /Unexpected host \\"\\"/);
});

test('an unexpected failure is a 500 with its message, for plain and Lichess routes alike', async (t) => {
  const broken = await startServer();
  t.after(() => broken.stop());
  await fetch(`${broken.base}/api/lichess/status`); // answered once start-up (which reads the settings) is over
  fs.mkdirSync(path.join(broken.dataDir, 'settings.json')); // a folder where the settings file should be
  const settings = await fetch(`${broken.base}/api/settings`);
  assert.equal(settings.status, 500);
  assert.match((await settings.json()).error, /EISDIR/);
  const explorer = await fetch(`${broken.base}/api/lichess/explorer?fen=${encodeURIComponent(START_FEN)}`);
  assert.equal(explorer.status, 500);
});
