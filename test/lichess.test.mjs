// The Lichess client (lichess.js) against the mock Lichess: tokens, the explorer
// and its cache, one request at a time, the 429 pause, studies and OAuth.
// Tests run in order and share the client's state, like the app does.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLichess } from './helpers/mock-lichess.mjs';
import { createLichessClient } from '../lichess.js';
import { START_FEN as START } from '../public/js/constants.js';
import { must } from './helpers/must.mjs';

const mock = await startMockLichess({ delay: 80 }); // slow enough to see overlapping requests
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-lichess-'));
const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-lichess-other-'));
const client = (dir) => createLichessClient({ dataDir: dir, baseUrl: mock.url, explorerUrl: mock.url, rateLimitPauseMs: 300 });
const lichess = client(dataDir);
const TOKEN_FILE = path.join(dataDir, 'lichess.json');

after(async () => {
  await mock.stop();
  for (const dir of [dataDir, otherDir]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';
const AFTER_C4 = 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1';
const AFTER_NF3 = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1';
const CAN_CASTLE = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

test('the explorer needs a connected account', async () => {
  await assert.rejects(lichess.explorer({ fen: START }), { status: 401, message: /connect a Lichess account/ });
});

test('a malformed token is refused before anything is stored', async () => {
  await assert.rejects(lichess.connectWithToken('no!'), { status: 400 });
  assert.ok(!fs.existsSync(TOKEN_FILE));
});

test('a personal token is checked, stored privately and never exposed', async () => {
  const st = await lichess.connectWithToken('lip_testToken123');
  assert.equal(st.connected, true);
  assert.equal(st.username, 'MockPlayer');
  assert.equal(st.via, 'personal');
  // Rapid is the most-played speed (1720): rating bands around 1570–1870.
  assert.deepEqual(st.ratingSuggestion, { speed: 'rapid', rating: 1720, groups: [1400, 1600, 1800] });
  assert.ok(!JSON.stringify(lichess.status()).includes('lip_testToken123'), 'status() never carries the token');
  assert.equal(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token, 'lip_testToken123');
  if (process.platform !== 'win32') assert.equal(fs.statSync(TOKEN_FILE).mode & 0o777, 0o600);
});

test('explorer answers: castling as e1g1, totals added up, then served from the cache', async () => {
  const before = (await mock.stats()).explorerCalls;
  const res = await lichess.explorer({ fen: CAN_CASTLE, speeds: 'blitz', ratings: '1600' });
  const castle = res.moves.find((m) => m.san === 'O-O');
  assert.equal(castle.uci, 'e1g1', 'the explorer says e1h1');
  assert.equal(res.total, res.white + res.draws + res.black);
  assert.equal(res.cached, false);

  const again = await lichess.explorer({ fen: CAN_CASTLE, speeds: 'blitz', ratings: '1600' });
  assert.equal(again.cached, true);
  assert.equal((await mock.stats()).explorerCalls, before + 1, 'asked Lichess once');
});

test("requests say which version of the trainer is asking, as Lichess asks clients to", async () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await lichess.explorer({ fen: 'rnbqkbnr/pppppppp/8/8/8/6P1/PPPPPP1P/RNBQKBNR b KQkq - 0 1' }); // 1. g3: not cached
  assert.equal((await mock.stats()).userAgent, `RepertoireTrainer/${version} (local opening trainer)`);
});

test('the explorer cache drops old answers and stays under its size cap', async () => {
  const dir = path.join(dataDir, 'cache', 'explorer');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name));
  const day = 24 * 3600 * 1000;
  const put = (name, daysOld) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ at: Date.now() - daysOld * day, url: name, data: {} }));
  put('old', 40);
  put('fresh1', 1);
  put('fresh2', 2);
  put('fresh3', 3);
  fs.writeFileSync(path.join(dir, 'damaged.json'), '{"at": 1');
  fs.writeFileSync(path.join(dir, 'README.txt'), 'not ours');

  const first = await lichess.pruneCache(30);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['README.txt', 'fresh1.json', 'fresh2.json', 'fresh3.json']);
  assert.equal(first.removed, 2, 'the 40-day-old answer and the damaged file');

  const second = await lichess.pruneCache(30, { maxFiles: 2 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['README.txt', 'fresh1.json', 'fresh2.json'], 'the newest are kept');
  assert.equal(second.removed, 1);

  assert.deepEqual(await lichess.pruneCache(30), { removed: 0, kept: 2 });
});

test('pruning a cache that does not exist yet is not an error', async () => {
  fs.rmSync(path.join(dataDir, 'cache'), { recursive: true, force: true });
  assert.deepEqual(await lichess.pruneCache(30), { removed: 0, kept: 0 });
});

test('Lichess is asked one question at a time', async () => {
  const before = await mock.stats();
  await Promise.all([AFTER_E4, AFTER_D4, AFTER_C4].map((fen) => lichess.explorer({ fen })));
  const after = await mock.stats();
  assert.equal(after.explorerCalls, before.explorerCalls + 3);
  assert.equal(after.maxInFlight, 1);
});

test('after a 429 the client pauses, warns the app, then retries', async () => {
  const warnings = [];
  const onRateLimit = (until) => warnings.push(until);
  lichess.events.on('ratelimit', onRateLimit);
  await mock.failNext(429);
  const t0 = Date.now();
  const res = await lichess.explorer({ fen: AFTER_NF3 });
  lichess.events.off('ratelimit', onRateLimit);
  assert.ok(res.total > 0, 'the retry got an answer');
  assert.equal(warnings.length, 1);
  assert.ok(Date.now() - t0 >= 300, 'waited out the pause');
});

test('a study is imported from its link', async () => {
  const st = await lichess.studyPgn('https://lichess.org/study/AbCd1234');
  assert.equal(st.name, 'Mock study');
  assert.equal(st.orientation, 'white');
  assert.equal(st.studyId, 'AbCd1234');
  assert.match(st.pgn, /Scotch/);
  await assert.rejects(lichess.studyPgn('not a study link'), { status: 400 });
});

test("the account's own studies are listed", async () => {
  const list = await lichess.userStudies();
  assert.deepEqual(list.map((s) => s.name), ['Mock study', 'Sicilian prep']);
});

test('disconnecting a personal token keeps it on Lichess', async () => {
  const before = (await mock.stats()).revoked;
  const st = await lichess.disconnect();
  assert.equal(st.connected, false);
  assert.ok(!fs.existsSync(TOKEN_FILE));
  assert.equal((await mock.stats()).revoked, before, 'personal tokens belong to the user');
});

test('OAuth sign-in with PKCE, and sign-out revokes the token', async () => {
  const start = new URL(lichess.oauthStart('http://localhost:3210/auth/lichess/callback'));
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(start.searchParams.get('code_challenge'));

  const approval = await fetch(start, { redirect: 'manual' });
  const back = new URL(must(approval.headers.get('location')));
  const answer = { code: must(back.searchParams.get('code')), state: must(back.searchParams.get('state')) };
  const st = await lichess.oauthCallback(answer);
  assert.equal(st.connected, true);
  assert.equal(st.via, 'oauth');
  await assert.rejects(lichess.oauthCallback(answer), /expired/, 'a sign-in link works once');

  const before = (await mock.stats()).revoked;
  await lichess.disconnect();
  assert.equal((await mock.stats()).revoked, before + 1, 'tokens we created are revoked');
});

test('each client keeps its own token and cache, in its own data folder', async () => {
  await lichess.connectWithToken('lip_testToken123');
  await lichess.explorer({ fen: CAN_CASTLE, speeds: 'blitz', ratings: '1600' });
  const other = client(otherDir);
  assert.equal(other.status().connected, false, 'signed in only where the token was saved');
  await assert.rejects(other.explorer({ fen: CAN_CASTLE, speeds: 'blitz', ratings: '1600' }), { status: 401 }, 'no answers from the first client\'s cache');
  assert.equal(fs.existsSync(path.join(otherDir, 'lichess.json')), false);
  await lichess.disconnect();
});
