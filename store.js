// File-based storage. Everything lives in ./data as plain JSON so you can
// back it up, sync it with OneDrive/Dropbox, or edit it by hand.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.TRAINER_DATA_DIR || path.join(__dirname, 'data');
const REP_DIR = path.join(DATA_DIR, 'repertoires');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const schema = require('./settings-schema');

function ensureDirs() {
  fs.mkdirSync(REP_DIR, { recursive: true });
}

// Sync clients (OneDrive, Dropbox) and virus scanners briefly hold files open, and on
// Windows that makes a rename or read fail with EPERM/EBUSY. Waiting a moment fixes it.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS = [10, 20, 40, 80, 160, 320]; // about 0.6 s in all

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!TRANSIENT.has(err.code) || attempt >= RETRY_DELAYS.length) throw err;
      sleepSync(RETRY_DELAYS[attempt]);
    }
  }
}

/** Write via a temp file and rename, keeping the previous version as <file>.bak. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    if (fs.existsSync(file)) withRetry(() => fs.copyFileSync(file, `${file}.bak`));
    withRetry(() => fs.renameSync(tmp, file));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
    throw err;
  }
}

/** Parsed JSON, or the fallback if the file does not exist. Other read errors are thrown. */
function readJson(file, fallback) {
  let text;
  try {
    text = withRetry(() => fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return recoverDamaged(file, fallback);
  }
}

/**
 * A file that no longer parses (a crash, a full disk, a sync conflict) is never
 * overwritten: it is kept as <file>.corrupt-<time>, and the previous version comes
 * back from <file>.bak if there is one.
 */
function recoverDamaged(file, fallback) {
  const aside = `${file}.corrupt-${Date.now()}`;
  withRetry(() => fs.renameSync(file, aside));
  let restored = null;
  try { restored = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')); } catch (err) { /* no usable backup */ }
  if (restored !== null) {
    try { withRetry(() => fs.copyFileSync(`${file}.bak`, file)); } catch (err) { /* the next save writes it */ }
  }
  console.warn(`[store] ${path.basename(file)} could not be read. It is kept as ${path.basename(aside)}`
    + `${restored ? '; the previous version was restored.' : '.'}`);
  return restored === null ? fallback : restored;
}

/** Remove temp files left by saves that were interrupted. */
function sweepTempFiles() {
  for (const dir of [DATA_DIR, REP_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { continue; }
    for (const name of names) {
      if (!/\.json\.\d+\.\d+\.tmp$/.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); } catch (err) { /* still in use; next start */ }
    }
  }
}

function slug(text) {
  return String(text || 'repertoire')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 40) || 'repertoire';
}

function repFile(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw Object.assign(new Error('Invalid id'), { status: 400 });
  return path.join(REP_DIR, `${id}.json`);
}

function listRepertoires() {
  ensureDirs();
  return fs
    .readdirSync(REP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return readJson(path.join(REP_DIR, f), null);
      } catch (err) {
        console.warn(`[store] Skipped ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function getRepertoire(id) {
  const file = repFile(id);
  if (!fs.existsSync(file)) return null;
  return readJson(file, null);
}

function validateInput({ name, color, pgn }, partial = false) {
  const errors = [];
  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) errors.push('Give the repertoire a name.');
  }
  if (!partial || color !== undefined) {
    if (color !== 'white' && color !== 'black') errors.push('Choose White or Black.');
  }
  if (!partial || pgn !== undefined) {
    if (typeof pgn !== 'string' || !pgn.trim()) errors.push('Paste or upload some PGN.');
  }
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { status: 400 });
}

function createRepertoire(input) {
  validateInput(input);
  ensureDirs();
  const id = `${slug(input.name)}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const rep = {
    id,
    name: input.name.trim(),
    color: input.color,
    pgn: input.pgn,
    notes: input.notes || '',
    createdAt: now,
    updatedAt: now,
    cards: {},   // spaced-repetition state per (position, your move)
    audit: null, // last Stockfish audit
    history: [], // daily tallies for the streak chart
  };
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

function updateRepertoire(id, patch) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  validateInput(patch, true);
  for (const key of ['name', 'color', 'pgn', 'notes', 'audit']) {
    if (patch[key] !== undefined) rep[key] = typeof patch[key] === 'string' ? patch[key] : patch[key];
  }
  if (typeof rep.name === 'string') rep.name = rep.name.trim();
  rep.updatedAt = new Date().toISOString();
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

const APPLIED_SAVES_KEPT = 200;

/**
 * Merge spaced-repetition updates: { cards: {key: state|null}, tally: {date, correct, wrong}, saveId? }
 * The browser retries a save until it gets an answer, so the same save can arrive twice
 * (the reply to the first was lost). A saveId already applied is ignored, which keeps the
 * daily tally from counting twice.
 */
function patchProgress(id, { cards, tally, saveId }) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  if (typeof saveId === 'string' && saveId && saveId.length <= 64) {
    rep.appliedSaves = rep.appliedSaves || [];
    if (rep.appliedSaves.includes(saveId)) return rep;
    rep.appliedSaves.push(saveId);
    if (rep.appliedSaves.length > APPLIED_SAVES_KEPT) rep.appliedSaves.splice(0, rep.appliedSaves.length - APPLIED_SAVES_KEPT);
  }
  rep.cards = rep.cards || {};
  for (const [key, state] of Object.entries(cards || {})) {
    if (state === null) delete rep.cards[key];
    else rep.cards[key] = state;
  }
  if (tally && tally.date) {
    rep.history = rep.history || [];
    let day = rep.history.find((d) => d.date === tally.date);
    if (!day) {
      day = { date: tally.date, correct: 0, wrong: 0, lines: 0 };
      rep.history.push(day);
      rep.history.sort((a, b) => (a.date < b.date ? -1 : 1));
      if (rep.history.length > 400) rep.history.splice(0, rep.history.length - 400);
    }
    day.correct += tally.correct || 0;
    day.wrong += tally.wrong || 0;
    day.lines += tally.lines || 0;
  }
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

/** Merge puzzles found by the mistake search into a repertoire (deduplicated by id). */
function addPuzzles(id, puzzles) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  rep.puzzles = rep.puzzles || {};
  let added = 0;
  for (const p of puzzles || []) {
    if (!p || !p.id) continue;
    if (!rep.puzzles[p.id]) added++;
    rep.puzzles[p.id] = { ...(rep.puzzles[p.id] || {}), ...p };
  }
  writeJsonAtomic(repFile(id), rep);
  return { rep, added };
}

/** Remember popular replies the repertoire does not cover (deduplicated by position). */
function addGaps(id, gaps) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  rep.gaps = rep.gaps || {};
  for (const g of gaps || []) {
    if (!g || !g.fen) continue;
    const key = g.fen.split(' ').slice(0, 4).join(' ');
    rep.gaps[key] = { ...(rep.gaps[key] || {}), ...g, seenAt: new Date().toISOString() };
  }
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

function deleteGap(id, key) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  if (rep.gaps) delete rep.gaps[key];
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

function deletePuzzle(id, pid) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  if (rep.puzzles) delete rep.puzzles[pid];
  if (rep.cards) delete rep.cards[`pz|${pid}`];
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

function resetProgress(id) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  rep.cards = {};
  rep.history = [];
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

function deleteRepertoire(id) {
  const file = repFile(id);
  if (!fs.existsSync(file)) return false;
  withRetry(() => fs.unlinkSync(file));
  try { fs.unlinkSync(`${file}.bak`); } catch (err) { /* no backup yet */ }
  return true;
}

/** Saved settings on top of the defaults; anything stale or invalid falls back to the default. */
function getSettings() {
  return schema.validate(schema.defaults(), readJson(SETTINGS_FILE, {}));
}

function saveSettings(patch) {
  ensureDirs();
  const next = schema.validate(getSettings(), patch || {});
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

module.exports = {
  DATA_DIR,
  sweepTempFiles,
  listRepertoires,
  getRepertoire,
  createRepertoire,
  updateRepertoire,
  patchProgress,
  resetProgress,
  addPuzzles,
  deletePuzzle,
  addGaps,
  deleteGap,
  deleteRepertoire,
  getSettings,
  saveSettings,
};
