// File-based storage. Everything lives in ./data as plain JSON so you can
// back it up, sync it with OneDrive/Dropbox, or edit it by hand.

// The default fs object, not named imports: the tests swap its methods to simulate
// files held open by other programs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as schema from './settings-schema.js';
import { SCHEMA_VERSION, migrate, checkRepertoireInput, checkProgress, checkChapter } from './repertoire-format.js';

/** @typedef {import('./repertoire-format.js').RepertoireFile} RepertoireFile */

const DATA_DIR = process.env.TRAINER_DATA_DIR || path.join(import.meta.dirname, 'data');
const REP_DIR = path.join(DATA_DIR, 'repertoires');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

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

function withRetry(fn, attempt = 0) {
  try {
    return fn();
  } catch (err) {
    if (!TRANSIENT.has(err.code) || attempt >= RETRY_DELAYS.length) throw err;
    sleepSync(RETRY_DELAYS[attempt]);
    return withRetry(fn, attempt + 1);
  }
}

/**
 * Write via a temp file and rename, so a reader never sees half a file. The temp file
 * reaches the disk before the rename: otherwise a power cut can leave the renamed file
 * empty. The previous version is kept as <file>.bak, unless `backup` is false (the
 * Lichess token, which must not outlive a disconnect).
 * @param {string} file
 * @param {unknown} data
 * @param {{ backup?: boolean, mode?: number }} [options]  mode: the file's permissions
 */
function writeJsonAtomic(file, data, { backup = true, mode = 0o666 } = {}) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeToDisk(tmp, JSON.stringify(data, null, 2), mode);
    if (backup && fs.existsSync(file)) {
      withRetry(() => fs.copyFileSync(file, `${file}.bak`));
      // The backup is only a fallback: one that is not on disk yet must not stop the save.
      try { withRetry(() => syncToDisk(`${file}.bak`)); } catch (err) { /* written, just not flushed */ }
    }
    withRetry(() => fs.renameSync(tmp, file));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
    throw err;
  }
}

/** Write a new file and wait until it is on the disk. */
function writeToDisk(file, text, mode) {
  const fd = fs.openSync(file, 'w', mode);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Wait until a file written some other way (a copy) is on the disk. */
function syncToDisk(file) {
  const fd = fs.openSync(file, 'r+'); // Windows flushes only a file opened for writing
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
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
    let names;
    try { names = fs.readdirSync(dir); } catch (err) { continue; }
    for (const name of names) {
      if (!/\.json\.\d+\.\d+\.tmp$/.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); } catch (err) { /* still in use; next start */ }
    }
  }
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 40) || 'repertoire';
}

const ID = /^[a-z0-9-]+$/;

function repFile(id) {
  if (!ID.test(id)) throw Object.assign(new Error('Invalid id'), { status: 400 });
  return path.join(REP_DIR, `${id}.json`);
}

/**
 * A stored repertoire in the current format (older files are migrated as they are read;
 * the next save writes them in it), or null if there is none. Its id comes from the file
 * name, so a file copied under a new name is a repertoire of its own.
 * @param {string} id
 * @returns {RepertoireFile | null}
 */
function getRepertoire(id) {
  const file = repFile(id);
  const rep = readJson(file, null);
  return rep === null ? null : { ...migrate(rep, path.basename(file)), id };
}

function listRepertoires() {
  ensureDirs();
  return fs
    .readdirSync(REP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const id = f.slice(0, -'.json'.length);
        if (!ID.test(id)) throw new Error('rename it with only lower-case letters, digits and dashes, like my-repertoire.json.');
        return getRepertoire(id);
      } catch (err) {
        console.warn(`[store] Skipped ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function createRepertoire(input) {
  checkRepertoireInput(input);
  ensureDirs();
  const id = `${slug(input.name)}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  /** @type {RepertoireFile} */
  const rep = {
    schemaVersion: SCHEMA_VERSION,
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

/**
 * Change a repertoire's name, colour, PGN, notes or audit. A change that carries the
 * baseUpdatedAt it was made from is refused once the file has moved on (a chapter added
 * from another tab, say), rather than writing over what changed.
 * @param {string} id
 * @param {any} patch  as the browser sent it
 */
function updateRepertoire(id, patch) {
  checkRepertoireInput(patch, true);
  const rep = getRepertoire(id);
  if (!rep) return null;
  if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== rep.updatedAt) {
    throw Object.assign(new Error('This repertoire changed in another tab or window while you were editing it. Copy your changes, reload the page and edit it again.'), { status: 409 });
  }
  for (const key of ['name', 'color', 'pgn', 'notes', 'audit']) {
    if (patch[key] !== undefined) rep[key] = patch[key];
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
 * daily tally from counting twice. The body is checked first (checkProgress); a save that
 * does not fit is refused with a 400 and changes nothing.
 * @param {string} id
 * @param {any} patch  as the browser sent it
 * @returns {RepertoireFile | null}
 */
function patchProgress(id, patch) {
  checkProgress(patch);
  const { cards, tally, saveId } = patch;
  const rep = getRepertoire(id);
  if (!rep) return null;
  if (saveId) {
    rep.appliedSaves = rep.appliedSaves || [];
    if (rep.appliedSaves.includes(saveId)) return rep;
    rep.appliedSaves.push(saveId);
    if (rep.appliedSaves.length > APPLIED_SAVES_KEPT) rep.appliedSaves.splice(0, rep.appliedSaves.length - APPLIED_SAVES_KEPT);
  }
  for (const [key, state] of Object.entries(cards || {})) {
    if (state === null) delete rep.cards[key];
    else rep.cards[key] = state;
  }
  if (tally && tally.date) {
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

/**
 * Append a puzzle's line to the repertoire as a new PGN chapter and mark the puzzle as
 * added, in one save. A puzzle already added is left alone, so a repeat adds nothing.
 */
function addPuzzleLine(id, pid, chapter) {
  const rep = getRepertoire(id);
  if (!rep) return null;
  const puzzle = rep.puzzles && Object.hasOwn(rep.puzzles, pid) ? rep.puzzles[pid] : null;
  if (!puzzle) throw Object.assign(new Error('That puzzle is no longer in this repertoire.'), { status: 404 });
  if (puzzle.addedAt) return rep;
  if (typeof chapter !== 'string' || !chapter.trim()) throw Object.assign(new Error('The line to add is missing.'), { status: 400 });
  const now = new Date().toISOString();
  rep.pgn = `${(rep.pgn || '').trimEnd()}\n\n${chapter}`;
  puzzle.addedAt = now;
  rep.updatedAt = now;
  writeJsonAtomic(repFile(id), rep);
  return rep;
}

/**
 * Add one line to the end of a repertoire as a new chapter (a Surprise answer). The
 * server appends it, so an edit made meanwhile in another tab is kept. With gapKey, that
 * gap is now answered and is removed.
 * @param {string} id
 * @param {{ pgn?: unknown, gapKey?: unknown }} body
 */
function addLine(id, { pgn, gapKey } = {}) {
  const chapter = checkChapter(pgn);
  const rep = getRepertoire(id);
  if (!rep) return null;
  rep.pgn = `${(rep.pgn || '').trimEnd()}\n\n${chapter}\n`;
  if (typeof gapKey === 'string' && rep.gaps && Object.hasOwn(rep.gaps, gapKey)) delete rep.gaps[gapKey];
  rep.updatedAt = new Date().toISOString();
  writeJsonAtomic(repFile(id), rep);
  return rep;
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

/**
 * Delete a repertoire by moving its file, and its backup, to data/trash/<id>-<time>/, so a
 * mistaken delete can be undone by moving them back into data/repertoires.
 */
function deleteRepertoire(id) {
  const file = repFile(id);
  if (!fs.existsSync(file)) return false;
  const bin = path.join(TRASH_DIR, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(bin, { recursive: true });
  withRetry(() => fs.renameSync(file, path.join(bin, path.basename(file))));
  if (fs.existsSync(`${file}.bak`)) withRetry(() => fs.renameSync(`${file}.bak`, path.join(bin, `${path.basename(file)}.bak`)));
  return true;
}

/** Saved settings on top of the defaults; anything stale or invalid falls back to the default. */
function getSettings() {
  return schema.validate(schema.defaults(), schema.upgrade(readJson(SETTINGS_FILE, {})));
}

function saveSettings(patch) {
  ensureDirs();
  const next = schema.validate(getSettings(), patch || {});
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

export {
  DATA_DIR,
  writeJsonAtomic,
  sweepTempFiles,
  listRepertoires,
  getRepertoire,
  createRepertoire,
  updateRepertoire,
  patchProgress,
  resetProgress,
  addPuzzles,
  addPuzzleLine,
  addLine,
  deletePuzzle,
  addGaps,
  deleteGap,
  deleteRepertoire,
  getSettings,
  saveSettings,
};
