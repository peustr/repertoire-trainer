// How the Lichess client (lichess.js) handles each kind of answer: network failures,
// repeated rate limits, refusals and errors, explorer data with parts missing, the cache
// on disk, study links and the OAuth sign-in. fetch is scripted per test; lichess.test.mjs
// runs the client against the mock Lichess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLichessClient } from '../lichess.js';
import { START_FEN as START } from '../public/js/constants.js';
import { must } from './helpers/must.mjs';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const TOKEN = { token: 'lip_savedToken123', username: 'Me', via: 'personal' };

/**
 * A client with its own temp data folder (removed after the test), signed in when `auth` is given.
 * @param {import('node:test').TestContext} t
 * @param {{ auth?: object | null, memoryCacheSize?: number, rateLimitPauseMs?: number }} [options]
 */
function tempClient(t, { auth = null, ...options } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-lichess-answers-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  if (auth) fs.writeFileSync(path.join(dataDir, 'lichess.json'), JSON.stringify(auth));
  const client = createLichessClient({ dataDir, baseUrl: 'http://lichess.test', explorerUrl: 'http://explorer.test', rateLimitPauseMs: 5, ...options });
  return { client, dataDir };
}

/** Replace fetch for this test: handler(url, init) returns a Response or throws. Returns the URLs asked for. */
function scriptFetch(t, handler) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    urls.push(String(url));
    return handler(String(url), init);
  });
  return urls;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (body, status = 200) => new Response(body, { status });

test('a network failure says Lichess could not be reached, with the reason when there is one', async (t) => {
  const { client } = tempClient(t);
  const failures = [
    [new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } }), '(ECONNREFUSED)'],
    [new TypeError('fetch failed', { cause: { message: 'getaddrinfo failed' } }), '(getaddrinfo failed)'],
    [new Error('The operation was aborted due to timeout'), '(The operation was aborted due to timeout)'],
  ];
  for (const [err, reason] of failures) {
    scriptFetch(t, () => { throw err; });
    await assert.rejects(client.studyPgn('AbCd1234'), { status: 502, message: `Could not reach Lichess ${reason}. Check your internet connection.` });
  }
});

test('when Lichess keeps asking us to slow down, the client gives up after two retries', async (t) => {
  const { client } = tempClient(t);
  const urls = scriptFetch(t, () => json({ error: 'Too many requests' }, 429));
  const pauses = [];
  client.events.on('ratelimit', () => pauses.push(client.status().pausedUntil));
  await assert.rejects(client.studyPgn('AbCd1234'), { status: 429, message: 'Lichess asked us to slow down. Try again in a minute.' });
  assert.equal(urls.length, 3);
  assert.equal(pauses.length, 3);
  assert.ok(pauses.every((until) => typeof until === 'number'), 'the status shows the pause while it lasts');
});

test('a refused request asks you to connect again, or to connect at all', async (t) => {
  scriptFetch(t, () => json({ error: 'Unauthorized' }, 401));
  const signedIn = tempClient(t, { auth: TOKEN }).client;
  await assert.rejects(signedIn.explorer({ fen: START }), { status: 401, message: 'Lichess rejected the saved token. Connect your account again.' });
  const signedOut = tempClient(t).client;
  await assert.rejects(signedOut.studyPgn('AbCd1234'), { status: 401, message: 'Connect your Lichess account first.' }, 'about the account, not the explorer');
});

test('other errors give Lichess’s status and the start of its answer', async (t) => {
  const { client } = tempClient(t);
  /** @type {Array<[Response, string]>} */
  const answers = [
    [text('Internal error, sorry', 500), 'Lichess answered 500: Internal error, sorry'],
    [text('', 503), 'Lichess answered 503'],
    [new Response(new ReadableStream({ start(c) { c.error(new Error('connection reset')); } }), { status: 500 }), 'Lichess answered 500'],
  ];
  for (const [res, message] of answers) {
    scriptFetch(t, () => res);
    await assert.rejects(client.studyPgn('AbCd1234'), { status: res.status, message });
  }
});

test('explorer answers with parts missing count as zero, and the query follows the source', async (t) => {
  const { client } = tempClient(t, { auth: TOKEN });
  await assert.rejects(client.explorer({ fen: '' }), { status: 400, message: 'Missing position' });

  const urls = scriptFetch(t, (url) => json(url.includes('/masters')
    ? {}
    : { white: 3, moves: [{ uci: 'e1g1', san: 'O-O', white: 2, draws: 1, black: 0 }] }));
  const masters = await client.explorer({ fen: START, source: 'masters', since: '2015-06' });
  assert.deepEqual(masters, { source: 'masters', total: 0, white: 0, draws: 0, black: 0, opening: null, moves: [], cached: false });
  const query = new URL(urls[0]);
  assert.equal(query.pathname, '/masters');
  assert.equal(query.searchParams.get('since'), '2015', 'the masters database takes a year');
  assert.equal(query.searchParams.get('speeds'), null);

  const lichess = await client.explorer({ fen: AFTER_E4, since: 'last year' });
  assert.equal(lichess.total, 3);
  assert.deepEqual(lichess.moves, [{ uci: 'e1g1', san: 'O-O', white: 2, draws: 1, black: 0, total: 3, averageRating: null }], 'castling already written e1g1 stays');
  assert.equal(new URL(urls[1]).searchParams.get('since'), null, 'a malformed month is left out');
  await client.explorer({ fen: AFTER_E4, since: '2024-03' });
  assert.equal(new URL(urls[2]).searchParams.get('since'), '2024-03', 'the Lichess database takes the month');
});

test('cached answers come from disk for a new client, are asked again once too old, and memory stays small', async (t) => {
  const { client, dataDir } = tempClient(t, { auth: TOKEN, memoryCacheSize: 1 });
  const urls = scriptFetch(t, () => json({ white: 10, draws: 0, black: 0, moves: [] }));
  await client.explorer({ fen: START });
  await client.explorer({ fen: AFTER_E4 }); // pushes the first answer out of memory
  assert.equal((await client.explorer({ fen: START })).cached, true, 'read back from disk');
  assert.equal(urls.length, 2);

  const again = createLichessClient({ dataDir, baseUrl: 'http://lichess.test', explorerUrl: 'http://explorer.test' });
  assert.equal((await again.explorer({ fen: AFTER_E4 })).cached, true, 'a new client (a restart) reads the disk cache');
  assert.equal(urls.length, 2);

  const dir = path.join(dataDir, 'cache', 'explorer');
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), at: Date.now() - 2 * 864e5 }));
  }
  const later = createLichessClient({ dataDir, baseUrl: 'http://lichess.test', explorerUrl: 'http://explorer.test' });
  assert.equal((await later.explorer({ fen: AFTER_E4, cacheDays: 1 })).cached, false, 'older than the cache keeps answers');
  assert.equal(urls.length, 3);
});

test('an answer is still given when the cache cannot be written', async (t) => {
  const { client, dataDir } = tempClient(t, { auth: TOKEN });
  fs.mkdirSync(path.join(dataDir, 'cache'));
  fs.writeFileSync(path.join(dataDir, 'cache', 'explorer'), 'a file where the folder should be');
  scriptFetch(t, () => json({ white: 1, draws: 0, black: 0, moves: [] }));
  const res = await client.explorer({ fen: START });
  assert.equal(res.total, 1);
});

test('pruning the cache passes over what it cannot read or remove', async (t) => {
  const { client, dataDir } = tempClient(t);
  const dir = path.join(dataDir, 'cache', 'explorer');
  fs.mkdirSync(path.join(dir, 'odd.json'), { recursive: true }); // a folder: cannot be read as a file
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ at: 0 }));
  t.mock.method(fs.promises, 'rm', async () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); });
  assert.deepEqual(await client.pruneCache(30), { removed: 0, kept: 0 });
  assert.ok(fs.existsSync(path.join(dir, 'old.json')), 'in use: left for the next start');
});

test('a token is checked with Lichess: refused, failing, or out of reach', async (t) => {
  const { client, dataDir } = tempClient(t);
  await assert.rejects(client.connectWithToken(undefined), { status: 400, message: 'That does not look like a Lichess token.' });
  const cases = [
    [() => json({ error: 'No such token' }, 401), { status: 401, message: 'Lichess did not accept that token.' }],
    [() => json({ error: 'Oops' }, 500), { status: 500, message: 'Lichess answered 500' }],
    [() => { throw new TypeError('fetch failed'); }, { status: 502, message: 'Could not reach Lichess (fetch failed). Check your internet connection.' }],
  ];
  for (const [answer, expected] of cases) {
    scriptFetch(t, answer);
    await assert.rejects(client.connectWithToken('lip_validLooking123'), expected);
  }
  assert.ok(!fs.existsSync(path.join(dataDir, 'lichess.json')), 'nothing saved');
});

test('the token is saved whole or not at all, and a replaced one leaves no copy', async (t) => {
  const { client, dataDir } = tempClient(t);
  const file = path.join(dataDir, 'lichess.json');
  scriptFetch(t, () => json({ id: 'me', username: 'Me' }));
  await client.connectWithToken('lip_firstToken123');
  await client.connectWithToken('lip_secondToken123');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'lip_secondToken123');
  assert.deepEqual(fs.readdirSync(dataDir), ['lichess.json'], 'no backup holding the first token');

  // A save that fails part-way (a full disk) leaves the saved sign-in as it was.
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); });
  await assert.rejects(client.connectWithToken('lip_thirdToken123'), { code: 'ENOSPC' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'lip_secondToken123');
  assert.deepEqual(fs.readdirSync(dataDir), ['lichess.json'], 'and no temp file');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('an account without rated games gets no rating suggestion', async (t) => {
  const { client } = tempClient(t);
  scriptFetch(t, () => json({ id: 'newbie', username: 'Newbie' }));
  const st = await client.connectWithToken('lip_validLooking123');
  assert.equal(st.username, 'Newbie');
  assert.equal(st.ratingSuggestion, null);
});

test('disconnecting when not connected is fine', async (t) => {
  const { client } = tempClient(t);
  const st = await client.disconnect();
  assert.equal(st.connected, false);
  assert.equal(st.username, null);
});

test('study links: one chapter, an empty or private study, and a study without names', async (t) => {
  const { client } = tempClient(t);
  await assert.rejects(client.studyPgn(undefined), { status: 400 });
  const urls = scriptFetch(t, (url) => text(url.includes('/EfGh5678') ? '1. e4 e5 *' : '  \n'));
  const chapter = await client.studyPgn('https://lichess.org/study/AbCd1234/EfGh5678');
  assert.equal(new URL(urls[0]).pathname, '/api/study/AbCd1234/EfGh5678.pgn');
  assert.deepEqual([chapter.name, chapter.orientation, chapter.chapterId], ['Lichess study', null, 'EfGh5678']);
  await assert.rejects(client.studyPgn('AbCd1234'), { status: 404, message: 'That study is empty or private.' });
});

test('the studies list skips lines it cannot read; without an account there is no list', async (t) => {
  await assert.rejects(tempClient(t).client.userStudies(), { status: 401, message: 'Connect your Lichess account first.' });
  const { client } = tempClient(t, { auth: TOKEN });
  scriptFetch(t, () => text(`${JSON.stringify({ id: 'AbCd1234', name: 'Sicilian', updatedAt: 1 })}\n{not json\n`));
  assert.deepEqual(await client.userStudies(), [{ id: 'AbCd1234', name: 'Sicilian', updatedAt: 1 }]);
});

test('sign-in: cancelled, expired after 15 minutes, or refused by Lichess', async (t) => {
  const { client } = tempClient(t);
  const stateOf = (url) => must(new URL(url).searchParams.get('state'));
  await assert.rejects(client.oauthCallback({ error: 'access_denied' }), { status: 400, message: 'Lichess sign-in was cancelled (access_denied).' });

  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const stale = stateOf(client.oauthStart('http://localhost:3210/auth/lichess/callback'));
  t.mock.timers.tick(16 * 60000);
  client.oauthStart('http://localhost:3210/auth/lichess/callback'); // starting again clears links over 15 minutes old
  await assert.rejects(client.oauthCallback({ code: 'c', state: stale }), { message: /expired/ });
  t.mock.timers.reset();

  const refusals = [
    [json({ error: 'invalid_grant', error_description: 'The code has expired.' }, 400), 'The code has expired.'],
    [json({ error: 'invalid_grant' }, 400), 'invalid_grant'],
    [text('<html>Bad gateway</html>', 502), 'Token exchange failed (502)'],
    [json({ token_type: 'Bearer' }), 'Token exchange failed (200)'],
  ];
  for (const [res, message] of refusals) {
    scriptFetch(t, () => res);
    const state = stateOf(client.oauthStart('http://localhost:3210/auth/lichess/callback'));
    await assert.rejects(client.oauthCallback({ code: 'c', state }), { status: 400, message });
  }
});

test('sign-in that cannot reach Lichess says so, as every other call does', async (t) => {
  const { client } = tempClient(t);
  scriptFetch(t, () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); });
  const state = must(new URL(client.oauthStart('http://localhost:3210/auth/lichess/callback')).searchParams.get('state'));
  await assert.rejects(client.oauthCallback({ code: 'c', state }), { status: 502, message: 'Could not reach Lichess (ENOTFOUND). Check your internet connection.' });
});

test('a token check that Lichess rate-limits pauses every call, and the next one waits it out', async (t) => {
  const { client } = tempClient(t, { rateLimitPauseMs: 80 });
  const notices = [];
  client.events.on('ratelimit', (until) => notices.push(until));
  const asked = [];
  scriptFetch(t, () => {
    asked.push(Date.now());
    return asked.length === 1 ? json({}, 429) : json({ id: 'me', username: 'Me' });
  });
  await assert.rejects(client.connectWithToken('lip_validLooking123'), { status: 429, message: 'Lichess asked us to slow down. Try again in a minute.' });
  assert.equal(notices.length, 1, 'the open pages are told');
  assert.ok(client.status().pausedUntil, 'the pause shows in the status');
  assert.equal((await client.connectWithToken('lip_validLooking123')).username, 'Me');
  assert.ok(asked[1] - asked[0] >= 70, `the second call waited out the pause (${asked[1] - asked[0]} ms)`);
});
