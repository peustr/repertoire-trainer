// Client-side cache of repertoires, parsed models and settings.

import { api } from './api.js';
import { buildRepertoire, hash } from './repertoire.js';
import { setFigurines, setSounds, toast } from './ui.js';
import { createOutbox, applyCards, webStorage } from './outbox.js';
import { setBoardPrefs } from './board.js';

/** @typedef {import('../../repertoire-format.js').RepertoireFile} RepertoireFile */

export const state = {
  // Null only until boot() has loaded them, which it does before any page is drawn.
  settings: /** @type {Record<string, any>} */ (/** @type {unknown} */ (null)),
  lichess: /** @type {Partial<import('../../lichess.js').LichessStatus> & { error?: string }} */ ({ connected: false }),
  reps: /** @type {Map<string, import('../../repertoire-format.js').RepertoireFile>} */ (new Map()),
  models: new Map(), // id -> { sig, model }
};

export async function loadSettings() {
  state.settings = await api.settings();
  applySettings();
  return state.settings;
}

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
if (darkQuery) darkQuery.addEventListener('change', () => state.settings && applyTheme());

function applyTheme() {
  const t = state.settings.theme;
  const dark = t === 'dark' || (t === 'system' && darkQuery && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function applySettings() {
  const s = state.settings;
  setFigurines(s.figurines);
  setSounds(s.sounds, s.volume);
  setBoardPrefs({ coordinates: s.coordinates, showDests: s.showDests, animation: s.animation });
  applyTheme();
}

/** Save only what changed: the server merges it, so another tab's changes are kept. */
export async function saveSettings(patch) {
  state.settings = await api.saveSettings(patch);
  applySettings();
  return state.settings;
}

export async function loadLichess() {
  try { state.lichess = await api.lichess.status(); } catch (err) { state.lichess = { connected: false, error: err.message }; }
  return state.lichess;
}

export async function loadReps() {
  const list = (await api.list()).map(withUnsaved);
  state.reps = new Map(list.map((r) => [r.id, r]));
  return list;
}

/**
 * A repertoire, from this page's copy unless `fresh` or not loaded yet. The API answers 404
 * (and this rejects) for one that does not exist.
 * @param {string} id
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<RepertoireFile>}
 */
export async function getRep(id, { fresh = false } = {}) {
  if (fresh || !state.reps.has(id)) {
    const rep = withUnsaved(await api.get(id));
    state.reps.set(id, rep);
  }
  return /** @type {RepertoireFile} */ (state.reps.get(id));
}

/** Keep a repertoire the server sent, with any answers it does not have yet laid on top. */
export function putRep(rep) {
  state.reps.set(rep.id, withUnsaved(rep));
  return rep;
}

export function dropRep(id) {
  state.reps.delete(id);
  state.models.delete(id);
}

/** Parsed model for a repertoire, rebuilt only when its PGN or colour changes. */
export function modelFor(rep) {
  const sig = hash(`${rep.color}|${rep.pgn}`);
  const cached = state.models.get(rep.id);
  if (cached && cached.sig === sig) {
    cached.model.rep = rep;
    return cached.model;
  }
  const model = buildRepertoire(rep);
  state.models.set(rep.id, { sig, model });
  return model;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- progress saves ---------------------------------------------------------------
// Answers go through an outbox (outbox.js): kept in localStorage until the server
// has them, so a server restart, a sleeping laptop or a locked file loses nothing.

const OUTBOX_KEY = 'repertoire-trainer.unsaved-progress';
const KEEP_TAB_OPEN = 'Your progress could not be saved just now, and this browser will not store it either. Keep this tab open: it will be saved as soon as the trainer answers again.';

let saveFailing = false; // the server is not taking saves just now
const outboxStorage = webStorage(() => localStorage, OUTBOX_KEY, {
  // localStorage is full or blocked, so only this tab holds those saves: say so if the
  // server is not taking them either.
  onUnstored: () => { if (saveFailing) toast(KEEP_TAB_OPEN, 'bad'); },
});

const outbox = createOutbox({
  storage: outboxStorage,
  send: (e) => api.progress(e.repId, { cards: e.cards, tally: e.tally, saveId: e.saveId }),
  onChange({ error, recovered, dropped }) {
    if (dropped) {
      toast(`Some progress could not be saved: ${error.message}`, 'bad');
    } else if (error) {
      saveFailing = true;
      toast(outboxStorage.unstored() ? KEEP_TAB_OPEN : 'Your progress could not be saved just now. It is kept in this browser and will be saved as soon as the trainer answers again.', 'bad');
    } else if (recovered) {
      saveFailing = false;
      toast('Your progress is saved.');
    }
  },
});

/** A repertoire from the server, with any card updates it does not have yet laid on top. */
function withUnsaved(rep) {
  const unsaved = outbox.pendingCards(rep.id);
  if (Object.keys(unsaved).length) rep.cards = applyCards({ ...(rep.cards || {}) }, unsaved);
  return rep;
}

/** Send any progress left over from before (call at start-up). Never fails. */
export function flushProgress() {
  return outbox.flush();
}

/** Save card updates (and a daily tally) for one repertoire. Never fails: see the outbox. */
export async function saveCards(repId, cards, tally) {
  const rep = state.reps.get(repId);
  if (rep) rep.cards = applyCards(rep.cards || {}, cards);
  await outbox.add({ repId, cards, tally: tally ? { date: today(), ...tally } : undefined });
}
