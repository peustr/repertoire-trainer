// Client-side cache of repertoires, parsed models and settings.

import { api } from './api.js';
import { buildRepertoire, hash } from './repertoire.js';
import { setFigurines, setSounds } from './ui.js';
import { setIntervals, setStepback } from './srs.js';
import { setBoardPrefs } from './board.js';

export const state = {
  settings: null,
  lichess: { connected: false },
  reps: new Map(),
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

export function applySettings() {
  const s = state.settings;
  setFigurines(s.figurines);
  setSounds(s.sounds, s.volume);
  setIntervals(s.srsIntervals);
  setStepback(s.stepbackLevels);
  setBoardPrefs({ coordinates: s.coordinates, showDests: s.showDests, animation: s.animation });
  applyTheme();
}

export async function saveSettings(patch) {
  state.settings = await api.saveSettings({ ...state.settings, ...patch });
  applySettings();
  return state.settings;
}

export async function loadLichess() {
  try { state.lichess = await api.lichess.status(); } catch (err) { state.lichess = { connected: false, error: err.message }; }
  return state.lichess;
}

export async function loadReps() {
  const list = await api.list();
  state.reps = new Map(list.map((r) => [r.id, r]));
  return list;
}

export async function getRep(id, { fresh = false } = {}) {
  if (fresh || !state.reps.has(id)) {
    const rep = await api.get(id);
    state.reps.set(id, rep);
  }
  return state.reps.get(id);
}

export function putRep(rep) {
  state.reps.set(rep.id, rep);
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

/** Persist card updates (and a daily tally) for one repertoire. */
export async function saveCards(repId, cards, tally) {
  const rep = state.reps.get(repId);
  if (rep) {
    rep.cards = rep.cards || {};
    for (const [k, v] of Object.entries(cards)) {
      if (v === null) delete rep.cards[k];
      else rep.cards[k] = v;
    }
  }
  const updated = await api.progress(repId, { cards, tally: tally ? { date: today(), ...tally } : undefined });
  state.reps.set(repId, { ...updated, cards: rep ? rep.cards : updated.cards });
  return updated;
}
