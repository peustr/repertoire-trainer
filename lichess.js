// Lichess API client.
//
// - Opening explorer (explorer.lichess.org) — needs a token since 2025, no scopes.
// - Study PGN export, account info.
// - OAuth 2 with PKCE for local apps (no client registration needed), or a
//   pasted personal access token.
//
// Lichess asks API clients to make one request at a time and to wait a minute
// after a 429, so every call goes through a single queue, and explorer answers
// are cached on disk.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const store = require('./store');

const LICHESS = process.env.LICHESS_URL || 'https://lichess.org';
const EXPLORER = process.env.LICHESS_EXPLORER_URL || 'https://explorer.lichess.org';
const USER_AGENT = 'RepertoireTrainer/0.2 (local opening trainer)';
const CLIENT_ID = 'repertoire-trainer-local';
const CACHE_DIR = path.join(store.DATA_DIR, 'cache', 'explorer');
const TOKEN_FILE = path.join(store.DATA_DIR, 'lichess.json');
const CACHE_TTL = 30 * 24 * 3600 * 1000; // explorer stats move slowly
// Lichess asks for a full minute after a 429. Tests shorten it with this variable.
const RATE_LIMIT_PAUSE = Number(process.env.LICHESS_RATE_LIMIT_PAUSE_MS) || 61000;
const SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
const RATING_GROUPS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

const events = new EventEmitter();

// --- token storage -------------------------------------------------------------

function readAuth() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (err) { return null; }
}

function writeAuth(auth) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  if (!auth) { try { fs.unlinkSync(TOKEN_FILE); } catch (err) { /* already gone */ } return; }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function token() {
  const auth = readAuth();
  return auth && auth.token;
}

// --- request queue --------------------------------------------------------------

let chain = Promise.resolve();
let pausedUntil = 0;
let pending = 0;

function status() {
  const auth = readAuth();
  return {
    connected: !!(auth && auth.token),
    username: auth ? auth.username : null,
    via: auth ? auth.via : null,
    ratingSuggestion: auth ? auth.ratingSuggestion || null : null,
    pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
    pending,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class LichessError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.status = statusCode;
  }
}

/** Run fetches strictly one at a time. */
function enqueue(task) {
  pending++;
  const run = chain.then(async () => {
    try {
      return await task();
    } finally {
      pending--;
    }
  });
  chain = run.catch(() => {});
  return run;
}

async function request(url, { auth = true, accept = 'application/json', method = 'GET', body, headers = {}, retries = 2 } = {}) {
  return enqueue(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const h = { 'User-Agent': USER_AGENT, Accept: accept, ...headers };
      const t = auth ? token() : null;
      if (t) h.Authorization = `Bearer ${t}`;
      let res;
      try {
        res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(20000) });
      } catch (err) {
        throw new LichessError(`Could not reach Lichess (${err.cause ? err.cause.code || err.cause.message : err.message}). Check your internet connection.`, 502);
      }
      if (res.status === 429) {
        pausedUntil = Date.now() + RATE_LIMIT_PAUSE;
        events.emit('ratelimit', pausedUntil);
        if (attempt < retries) continue;
        throw new LichessError('Lichess asked us to slow down. Try again in a minute.', 429);
      }
      if (res.status === 401) {
        throw new LichessError(t ? 'Lichess rejected the saved token. Connect your account again.' : 'The Lichess opening explorer needs you to connect a Lichess account first.', 401);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LichessError(`Lichess answered ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`, res.status);
      }
      await sleep(120); // a little breathing room between calls
      return accept === 'application/json' ? res.json() : res.text();
    }
  });
}

// --- explorer ---------------------------------------------------------------------

function cleanSpeeds(speeds) {
  const list = String(speeds || '').split(',').map((s) => s.trim()).filter((s) => SPEEDS.includes(s));
  return list.length ? list : ['blitz', 'rapid', 'classical'];
}

function cleanRatings(ratings) {
  const list = String(ratings || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => RATING_GROUPS.includes(n));
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : [1600, 1800, 2000];
}

const memCache = new Map();

function cacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

function cacheGet(url, ttl = CACHE_TTL) {
  const key = cacheKey(url);
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.at < ttl) return mem.data;
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${key}.json`), 'utf8'));
    if (Date.now() - entry.at < ttl) {
      memCache.set(key, entry);
      return entry.data;
    }
  } catch (err) { /* miss */ }
  return null;
}

function cachePut(url, data) {
  const key = cacheKey(url);
  memCache.set(key, { at: Date.now(), data });
  if (memCache.size > 5000) memCache.delete(memCache.keys().next().value);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), url, data }));
  } catch (err) { /* cache is best-effort */ }
}

/**
 * Opening explorer lookup.
 * source: 'lichess' (rated Lichess games, filtered) or 'masters' (OTB master games).
 * Returns { white, draws, black, total, opening, moves: [{uci, san, white, draws, black, total, averageRating}], cached }.
 */
async function explorer({ fen, source = 'lichess', speeds, ratings, since, moves = 12, cacheDays }) {
  if (!fen) throw new LichessError('Missing position', 400);
  const params = new URLSearchParams({ variant: 'standard', fen, moves: String(moves), topGames: '0', recentGames: '0' });
  if (source !== 'masters') {
    params.set('speeds', cleanSpeeds(speeds).join(','));
    params.set('ratings', cleanRatings(ratings).join(','));
  }
  if (since && /^\d{4}-\d{2}$/.test(since)) params.set('since', source === 'masters' ? since.slice(0, 4) : since);
  const url = `${EXPLORER}/${source === 'masters' ? 'masters' : 'lichess'}?${params}`;
  let data = cacheGet(url, cacheDays ? cacheDays * 24 * 3600 * 1000 : CACHE_TTL);
  let cached = true;
  if (!data) {
    if (!token()) throw new LichessError('The Lichess opening explorer needs you to connect a Lichess account first.', 401);
    data = await request(url);
    cachePut(url, data);
    cached = false;
  }
  const total = (data.white || 0) + (data.draws || 0) + (data.black || 0);
  return {
    source,
    total,
    white: data.white || 0,
    draws: data.draws || 0,
    black: data.black || 0,
    opening: data.opening || null,
    moves: (data.moves || []).map((m) => ({
      uci: normaliseCastling(m.uci, m.san),
      san: m.san,
      white: m.white,
      draws: m.draws,
      black: m.black,
      total: m.white + m.draws + m.black,
      averageRating: m.averageRating || null,
    })),
    cached,
  };
}

/** The explorer writes castling as king-takes-rook (e1h1); chess.js and our trees use e1g1. */
function normaliseCastling(uci, san) {
  if (san === 'O-O' || san === 'O-O-O') {
    const map = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };
    return map[uci] || uci;
  }
  return uci;
}

// --- account, studies -----------------------------------------------------------------

async function account(tokenOverride) {
  if (tokenOverride) {
    // Validate a token before saving it.
    const res = await enqueue(() => fetch(`${LICHESS}/api/account`, {
      headers: { Authorization: `Bearer ${tokenOverride}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    })).catch((err) => { throw new LichessError(`Could not reach Lichess (${err.message}).`, 502); });
    if (res.status === 401) throw new LichessError('Lichess did not accept that token.', 401);
    if (!res.ok) throw new LichessError(`Lichess answered ${res.status}`, res.status);
    return res.json();
  }
  return request(`${LICHESS}/api/account`);
}

/** Suggest explorer rating groups around the player's most-played rating. */
function ratingSuggestion(acc) {
  const perfs = (acc && acc.perfs) || {};
  const candidates = ['rapid', 'blitz', 'classical']
    .map((k) => ({ speed: k, ...(perfs[k] || {}) }))
    .filter((p) => p.rating && p.games);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.games - a.games);
  const main = candidates[0];
  const lo = main.rating - 150;
  const hi = main.rating + 150;
  const groups = RATING_GROUPS.filter((g, i) => {
    const next = RATING_GROUPS[i + 1] || 4000;
    return next > lo && g <= hi;
  });
  return { speed: main.speed, rating: main.rating, groups };
}

async function connectWithToken(tok, via = 'personal') {
  const t = String(tok || '').trim();
  if (!/^[A-Za-z0-9_]{8,}$/.test(t)) throw new LichessError('That does not look like a Lichess token.', 400);
  const acc = await account(t);
  writeAuth({ token: t, username: acc.username, via, connectedAt: new Date().toISOString(), ratingSuggestion: ratingSuggestion(acc) });
  return status();
}

async function disconnect() {
  const auth = readAuth();
  if (auth && auth.via === 'oauth') {
    // Tokens we created through sign-in are ours to revoke. Personal tokens belong to the user.
    await enqueue(() => fetch(`${LICHESS}/api/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}`, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) })).catch(() => {});
  }
  writeAuth(null);
  return status();
}

/** Accepts a study URL or id (optionally with a chapter). Returns { pgn, name }. */
async function studyPgn(input) {
  const m = String(input || '').trim().match(/(?:study\/)?([A-Za-z0-9]{8})(?:\/([A-Za-z0-9]{8}))?(?:[/?#].*)?$/);
  if (!m) throw new LichessError('Paste a Lichess study link, like https://lichess.org/study/abcd1234', 400);
  const [, studyId, chapterId] = m;
  const q = 'clocks=false&comments=true&variations=true&orientation=true';
  const url = chapterId ? `${LICHESS}/api/study/${studyId}/${chapterId}.pgn?${q}` : `${LICHESS}/api/study/${studyId}.pgn?${q}`;
  const pgn = await request(url, { accept: 'application/x-chess-pgn' });
  if (!pgn.trim()) throw new LichessError('That study is empty or private.', 404);
  const event = (pgn.match(/\[(?:StudyName|Event)\s+"([^"]+)"\]/) || [])[1] || 'Lichess study';
  const name = event.split(/:\s/)[0];
  const orientation = (pgn.match(/\[Orientation\s+"(white|black)"\]/) || [])[1] || null;
  return { pgn, name, orientation, studyId, chapterId: chapterId || null };
}

async function userStudies() {
  const auth = readAuth();
  if (!auth) throw new LichessError('Connect your Lichess account first.', 401);
  const text = await request(`${LICHESS}/api/study/by/${encodeURIComponent(auth.username)}`, { accept: 'application/x-ndjson' });
  return text.split('\n').filter(Boolean).map((l) => {
    try { const s = JSON.parse(l); return { id: s.id, name: s.name, updatedAt: s.updatedAt }; } catch (err) { return null; }
  }).filter(Boolean);
}

// --- OAuth 2 with PKCE --------------------------------------------------------------------

const pendingAuth = new Map(); // state -> { verifier, redirectUri, at }

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function oauthStart(redirectUri) {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  for (const [k, v] of pendingAuth) if (Date.now() - v.at > 15 * 60000) pendingAuth.delete(k);
  pendingAuth.set(state, { verifier, redirectUri, at: Date.now() });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: 'study:read',
    state,
  });
  return `${LICHESS}/oauth?${params}`;
}

async function oauthCallback({ code, state, error }) {
  if (error) throw new LichessError(`Lichess sign-in was cancelled (${error}).`, 400);
  const entry = pendingAuth.get(state);
  if (!entry) throw new LichessError('That sign-in link expired. Start again from the Lichess page.', 400);
  pendingAuth.delete(state);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: entry.verifier,
    redirect_uri: entry.redirectUri,
    client_id: CLIENT_ID,
  });
  const res = await enqueue(() => fetch(`${LICHESS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body,
    signal: AbortSignal.timeout(20000),
  }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new LichessError(data.error_description || data.error || `Token exchange failed (${res.status})`, 400);
  return connectWithToken(data.access_token, 'oauth');
}

module.exports = {
  events,
  status,
  explorer,
  account,
  connectWithToken,
  disconnect,
  studyPgn,
  userStudies,
  oauthStart,
  oauthCallback,
  cleanSpeeds,
  cleanRatings,
  RATING_GROUPS,
  SPEEDS,
  LichessError,
};
