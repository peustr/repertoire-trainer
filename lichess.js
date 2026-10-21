// Lichess API client.
//
// - Opening explorer (explorer.lichess.org) — needs a token since 2025, no scopes.
// - Study PGN export, account info.
// - OAuth 2 with PKCE for local apps (no client registration needed), or a
//   pasted personal access token.
//
// Lichess asks API clients to make one request at a time and to wait a minute
// after a 429, so every call goes through a single queue, and explorer answers
// are cached on disk. createLichessClient() makes a client with its own token
// file, cache and queue. The app makes exactly one (server.js): a second would
// have its own queue and could ask Lichess two things at once.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { defaults } from './settings-schema.js';
import { writeJsonAtomic } from './store.js';
import { SPEEDS, RATING_GROUPS } from './public/js/constants.js';

const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8'));
const USER_AGENT = `RepertoireTrainer/${version} (local opening trainer)`;
const CLIENT_ID = 'repertoire-trainer-local';
const CACHE_TTL = 30 * 24 * 3600 * 1000; // explorer stats move slowly
const CACHE_MAX_FILES = 20000; // a few kB each
const { lichessSpeeds: DEFAULT_SPEEDS, lichessRatings: DEFAULT_RATINGS } = defaults();

class LichessError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.status = statusCode;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Valid explorer time controls from "blitz,rapid", or the settings' default. */
function cleanSpeeds(speeds) {
  const list = String(speeds || '').split(',').map((s) => s.trim()).filter((s) => SPEEDS.includes(s));
  return list.length ? list : DEFAULT_SPEEDS.split(',');
}

/** Valid explorer rating groups from "1600,1800", sorted, or the settings' default. */
function cleanRatings(ratings) {
  const list = String(ratings || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => RATING_GROUPS.includes(n));
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : DEFAULT_RATINGS.split(',').map(Number);
}

/** The explorer writes castling as king-takes-rook (e1h1); chess.js and our trees use e1g1. */
function normaliseCastling(uci, san) {
  if (san === 'O-O' || san === 'O-O-O') {
    const map = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };
    return map[uci] || uci;
  }
  return uci;
}

/** Suggest explorer rating groups around the player's most-played rating. */
function ratingSuggestion(acc) {
  const perfs = acc.perfs || {};
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

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What /api/lichess/status answers. Never the token.
 * @typedef {{ connected: boolean, username: string | null, via: string | null,
 *   ratingSuggestion: { speed: string, rating: number, groups: number[] } | null, pausedUntil: number | null, pending: number }} LichessStatus
 */

/**
 * A Lichess client. Its token lives in <dataDir>/lichess.json and its explorer answers
 * in <dataDir>/cache/explorer.
 * @param {{ dataDir: string, baseUrl?: string, explorerUrl?: string, rateLimitPauseMs?: number, memoryCacheSize?: number }} options
 *   rateLimitPauseMs: how long to wait after a 429. Lichess asks for a full minute.
 *   memoryCacheSize: explorer answers also kept in memory (the oldest go first).
 */
function createLichessClient({ dataDir, baseUrl = 'https://lichess.org', explorerUrl = 'https://explorer.lichess.org', rateLimitPauseMs = 61000, memoryCacheSize = 5000 }) {
  const CACHE_DIR = path.join(dataDir, 'cache', 'explorer');
  const TOKEN_FILE = path.join(dataDir, 'lichess.json');
  const events = new EventEmitter();

  // --- token storage -------------------------------------------------------------

  function readAuth() {
    try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (err) { return null; }
  }

  function writeAuth(auth) {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    if (!auth) { try { fs.unlinkSync(TOKEN_FILE); } catch (err) { /* already gone */ } return; }
    // Atomic, so a crash mid-write cannot lose the sign-in; no .bak, so a replaced or
    // disconnected token does not stay on disk.
    writeJsonAtomic(TOKEN_FILE, auth, { backup: false, mode: 0o600 });
  }

  function token() {
    const auth = readAuth();
    return auth && auth.token;
  }

  // --- request queue --------------------------------------------------------------

  let chain = Promise.resolve();
  let pausedUntil = 0;
  let pending = 0;

  /** @returns {LichessStatus} */
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

  /**
   * One call to Lichess, made in the queue like every other. It waits out a rate-limit
   * pause first; a 429 starts a new pause, tells every page, and is retried `retries`
   * times; a network failure becomes a 502 the user can act on. `read` turns any other
   * answer into the result (or an error), still in the queue, so the next call starts only
   * once this one has fully arrived.
   * @template T
   * @param {string} url
   * @param {{ method?: string, accept?: string, body?: any, headers?: Record<string, string>,
   *   auth?: string | null, retries?: number }} options  auth: the token to send; the saved one
   *   when left out, none when null
   * @param {(res: Response, sentToken: string | null | undefined) => Promise<T>} read
   * @returns {Promise<T>}
   */
  function call(url, { method = 'GET', accept = 'application/json', body, headers = {}, auth, retries = 0 }, read) {
    return enqueue(async () => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const wait = pausedUntil - Date.now();
        if (wait > 0) await sleep(wait);
        /** @type {Record<string, string>} */
        const h = { 'User-Agent': USER_AGENT, Accept: accept, ...headers };
        const t = auth === undefined ? token() : auth;
        if (t) h.Authorization = `Bearer ${t}`;
        let res;
        try {
          res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(20000) });
        } catch (err) {
          throw new LichessError(`Could not reach Lichess (${err.cause ? err.cause.code || err.cause.message : err.message}). Check your internet connection.`, 502);
        }
        if (res.status === 429) {
          pausedUntil = Date.now() + rateLimitPauseMs;
          events.emit('ratelimit', pausedUntil);
          continue;
        }
        const out = await read(res, t);
        await sleep(120); // a little breathing room between calls
        return out;
      }
      throw new LichessError('Lichess asked us to slow down. Try again in a minute.', 429);
    });
  }

  /**
   * A GET with the saved token, answered in JSON (or text, for another `accept`), and
   * tried again twice after a 429.
   * @param {string} url
   * @param {{ accept?: string }} [options]
   */
  function request(url, { accept = 'application/json' } = {}) {
    return call(url, { accept, retries: 2 }, async (res, sentToken) => {
      if (res.status === 401) {
        throw new LichessError(sentToken ? 'Lichess rejected the saved token. Connect your account again.' : 'Connect your Lichess account first.', 401);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LichessError(`Lichess answered ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`, res.status);
      }
      return accept === 'application/json' ? res.json() : res.text();
    });
  }

  // --- explorer ---------------------------------------------------------------------

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
    if (memCache.size > memoryCacheSize) memCache.delete(memCache.keys().next().value);
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), url, data }));
    } catch (err) { /* cache is best-effort */ }
  }

  /**
   * Delete explorer answers saved more than maxAgeDays ago, damaged ones, and the oldest
   * beyond maxFiles, so the cache cannot grow without end. Best-effort: never rejects.
   * @param {number} maxAgeDays
   * @param {{ maxFiles?: number }} [options]
   * @returns {Promise<{ removed: number, kept: number }>}
   */
  async function pruneCache(maxAgeDays, { maxFiles = CACHE_MAX_FILES } = {}) {
    let names = [];
    try { names = await fs.promises.readdir(CACHE_DIR); } catch (err) { /* no cache yet */ }
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const keep = [];
    let removed = 0;
    const remove = async (name) => {
      try {
        await fs.promises.rm(path.join(CACHE_DIR, name), { force: true });
        removed++;
      } catch (err) { /* in use; try again next start */ }
    };
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let text;
      try { text = await fs.promises.readFile(path.join(CACHE_DIR, name), 'utf8'); } catch (err) { continue; }
      let at = NaN;
      try { at = JSON.parse(text).at; } catch (err) { /* damaged */ }
      if (Number.isFinite(at) && at >= cutoff) keep.push({ name, at });
      else await remove(name);
    }
    if (keep.length > maxFiles) {
      keep.sort((a, b) => b.at - a.at);
      for (const { name } of keep.splice(maxFiles)) await remove(name);
    }
    return { removed, kept: keep.length };
  }

  /**
   * Opening explorer lookup.
   * source: 'lichess' (rated Lichess games, filtered) or 'masters' (OTB master games).
   * Returns { white, draws, black, total, opening, moves: [{uci, san, white, draws, black, total, averageRating}], cached }.
   * speeds and ratings fall back to the settings' defaults; cacheDays to 30.
   * @param {{ fen: string, source?: 'lichess' | 'masters', speeds?: string, ratings?: string, since?: string,
   *   moves?: number, cacheDays?: number }} query
   */
  async function explorer({ fen, source = 'lichess', speeds, ratings, since, moves = 12, cacheDays }) {
    if (!fen) throw new LichessError('Missing position', 400);
    const params = new URLSearchParams({ variant: 'standard', fen, moves: String(moves), topGames: '0', recentGames: '0' });
    if (source !== 'masters') {
      params.set('speeds', cleanSpeeds(speeds).join(','));
      params.set('ratings', cleanRatings(ratings).join(','));
    }
    if (since && /^\d{4}-\d{2}$/.test(since)) params.set('since', source === 'masters' ? since.slice(0, 4) : since);
    const url = `${explorerUrl}/${source === 'masters' ? 'masters' : 'lichess'}?${params}`;
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

  // --- account, studies -----------------------------------------------------------------

  /** The account a token belongs to: checks a token before it is saved. */
  function account(tok) {
    return call(`${baseUrl}/api/account`, { auth: tok }, async (res) => {
      if (res.status === 401) throw new LichessError('Lichess did not accept that token.', 401);
      if (!res.ok) throw new LichessError(`Lichess answered ${res.status}`, res.status);
      return res.json();
    });
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
      // Best effort: the token is forgotten here whatever Lichess answers.
      await call(`${baseUrl}/api/token`, { method: 'DELETE', auth: auth.token }, async () => null).catch(() => {});
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
    const url = chapterId ? `${baseUrl}/api/study/${studyId}/${chapterId}.pgn?${q}` : `${baseUrl}/api/study/${studyId}.pgn?${q}`;
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
    const text = await request(`${baseUrl}/api/study/by/${encodeURIComponent(auth.username)}`, { accept: 'application/x-ndjson' });
    return text.split('\n').filter(Boolean).map((l) => {
      try { const s = JSON.parse(l); return { id: s.id, name: s.name, updatedAt: s.updatedAt }; } catch (err) { return null; }
    }).filter(Boolean);
  }

  // --- OAuth 2 with PKCE --------------------------------------------------------------------

  const pendingAuth = new Map(); // state -> { verifier, redirectUri, at }

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
    return `${baseUrl}/oauth?${params}`;
  }

  /**
   * Finish the OAuth sign-in with what Lichess sent back to /auth/lichess/callback.
   * @param {{ code?: string, state?: string, error?: string }} query
   */
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
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const data = await call(`${baseUrl}/api/token`, { method: 'POST', auth: null, headers, body }, async (res) => {
      const answer = await res.json().catch(() => ({}));
      if (!res.ok || !answer.access_token) throw new LichessError(answer.error_description || answer.error || `Token exchange failed (${res.status})`, 400);
      return answer;
    });
    return connectWithToken(data.access_token, 'oauth');
  }

  return {
    events,
    status,
    explorer,
    pruneCache,
    connectWithToken,
    disconnect,
    studyPgn,
    userStudies,
    oauthStart,
    oauthCallback,
  };
}

/** @typedef {ReturnType<typeof createLichessClient>} LichessClient */

export { createLichessClient, cleanSpeeds, cleanRatings, LichessError };
