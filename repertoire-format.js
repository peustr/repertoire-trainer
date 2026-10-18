// The repertoire file format: the one definition of what data/repertoires/<id>.json
// holds, its version, the migration that brings older files up to date when they are
// read, and the checks on what the browser may write (store.js applies them).
//
// To change the format: raise SCHEMA_VERSION, add a step to migrate() that turns the
// previous version into the new one, update the typedefs, and add a test with a file
// in the old format.

import { MAX_LEVEL } from './public/js/srs.js';
import { parsePgn } from './public/js/pgn.js';

export const SCHEMA_VERSION = 1;

/**
 * A card's place in the memory schedule (srs.js).
 * @typedef {object} CardState
 * @property {number} level   1–8
 * @property {number} due     when it is next asked, in ms since 1970
 * @property {number} [reps]  answers so far
 * @property {number} [lapses] mistakes so far
 * @property {number} [last]  when it was last answered
 */

/**
 * One day's answers, for the streak chart.
 * @typedef {{ date: string, correct: number, wrong: number, lines: number }} DayTally
 */

/**
 * The last Stockfish audit (views/audit.js): the moves that lose at least `threshold`
 * centipawns, keyed by card key.
 * @typedef {{ at: string, depth: number, threshold: number, checked: number, complete: boolean,
 *   flags: Record<string, { loss: number, label: string, bestLabel: string, best: string }> }} Audit
 */

/**
 * A repertoire as stored in data/repertoires/<id>.json. The server writes it; the browser
 * reads it through the API and sends changes back (PUT for the text and the audit, PATCH
 * …/progress for cards and tallies).
 * @typedef {object} RepertoireFile
 * @property {number} schemaVersion  the format version (SCHEMA_VERSION)
 * @property {string} id             also the file name; [a-z0-9-]
 * @property {string} name
 * @property {'white' | 'black'} color
 * @property {string} pgn            the whole repertoire, one game per chapter
 * @property {string} notes
 * @property {string} createdAt      ISO time
 * @property {string} updatedAt      ISO time
 * @property {Record<string, CardState>} cards  keyed by cardKey(): positionKey(fen)|uci, or pz|<puzzle id>.
 *   Changing how keys are made resets everyone's progress.
 * @property {DayTally[]} history    oldest first, at most 400 days
 * @property {Audit | null} audit
 * @property {Record<string, object>} [puzzles]  found by the mistake search (puzzles.js), keyed by puzzle id
 * @property {Record<string, object>} [gaps]     popular replies the repertoire does not answer, keyed by position
 * @property {string[]} [appliedSaves]           ids of the last 200 progress saves, so a retried save counts once
 */

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);
// Keys that would reach Object.prototype when assigned with obj[key] = ...
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Bring a stored repertoire up to SCHEMA_VERSION. Files written before format versions
 * existed are version 1. A file from a newer trainer is refused rather than half-read.
 * @param {any} rep  as parsed from disk
 * @param {string} [fileName] for the error message
 * @returns {RepertoireFile}
 */
export function migrate(rep, fileName = 'This repertoire') {
  const version = rep.schemaVersion === undefined ? 1 : rep.schemaVersion;
  if (!Number.isInteger(version) || version < 1) throw fail(`${fileName} has an unknown format version (${version}).`, 500);
  if (version > SCHEMA_VERSION) {
    throw fail(`${fileName} was saved by a newer version of the trainer (format ${version}). Update the trainer to open it.`, 409);
  }
  // Version 1: fill in what files from before versions may lack.
  return {
    ...rep,
    schemaVersion: SCHEMA_VERSION,
    notes: typeof rep.notes === 'string' ? rep.notes : '',
    cards: isObject(rep.cards) ? rep.cards : {},
    history: Array.isArray(rep.history) ? rep.history : [],
    audit: isObject(rep.audit) ? rep.audit : null,
  };
}

/** @param {any} audit */
function checkAudit(audit) {
  if (audit === null) return;
  if (!isObject(audit)) throw fail('The audit must be an object or null.');
  if (typeof audit.at !== 'string' || !isCount(audit.depth) || !isCount(audit.threshold) || !isCount(audit.checked) || typeof audit.complete !== 'boolean') {
    throw fail('The audit needs at, depth, threshold, checked and complete.');
  }
  if (!isObject(audit.flags)) throw fail('The audit\'s flags must be an object keyed by card.');
  for (const [key, f] of Object.entries(audit.flags)) {
    if (UNSAFE_KEYS.has(key) || !isObject(f) || typeof f.loss !== 'number' || typeof f.label !== 'string' || typeof f.bestLabel !== 'string' || typeof f.best !== 'string') {
      throw fail(`The audit flag for ${key} needs loss, label, bestLabel and best.`);
    }
  }
}

/**
 * Check a new repertoire (partial = false) or a change to one (PUT). Only name, color,
 * pgn, notes and audit can be set this way.
 * @param {any} input
 * @param {boolean} [partial]
 */
export function checkRepertoireInput(input, partial = false) {
  if (!isObject(input)) throw fail('Send the repertoire as a JSON object.');
  const { name, color, pgn, notes, audit } = input;
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
  if (notes !== undefined && typeof notes !== 'string') errors.push('Notes must be text.');
  if (errors.length) throw fail(errors.join(' '));
  if (audit !== undefined) checkAudit(audit);
}

const MAX_CHAPTER = 20000; // characters: one added line, not a whole book

/**
 * Check one chapter to add to a repertoire (POST …/lines): PGN text for a single game
 * whose moves all read cleanly.
 * @param {unknown} pgn
 * @returns {string} the chapter, trimmed
 */
export function checkChapter(pgn) {
  if (typeof pgn !== 'string' || !pgn.trim()) throw fail('The line to add is missing.');
  if (pgn.length > MAX_CHAPTER) throw fail('That line is too long to add in one go. Edit the repertoire instead.');
  const games = parsePgn(pgn); // games without moves are left out
  if (!games.length) throw fail('The line to add has no moves.');
  if (games.length > 1) throw fail('Send one line (a single PGN game) at a time.');
  if (games[0].errors.length) throw fail(`The line could not be read: ${games[0].errors[0]}`);
  return pgn.trim();
}

/**
 * Check a progress save (PATCH …/progress): { cards: { key: CardState | null }, tally?, saveId? }.
 * @param {any} patch
 */
export function checkProgress(patch) {
  if (!isObject(patch)) throw fail('Send the progress as a JSON object.');
  const { cards, tally, saveId } = patch;
  if (cards !== undefined) {
    if (!isObject(cards)) throw fail('Progress cards must be an object keyed by card.');
    for (const [key, s] of Object.entries(cards)) {
      if (UNSAFE_KEYS.has(key)) throw fail(`"${key}" is not a card.`);
      if (s === null) continue; // removes the card
      if (!isObject(s)) throw fail(`The card ${key} must be a schedule state or null.`);
      if (!Number.isInteger(s.level) || s.level < 1 || s.level > MAX_LEVEL) throw fail(`The card ${key} needs a level from 1 to ${MAX_LEVEL}.`);
      if (!isTime(s.due)) throw fail(`The card ${key} needs a due time.`);
      for (const k of ['reps', 'lapses']) if (s[k] !== undefined && !isCount(s[k])) throw fail(`The card ${key} has a bad ${k}.`);
      if (s.last !== undefined && !isTime(s.last)) throw fail(`The card ${key} has a bad last.`);
    }
  }
  if (tally !== undefined && tally !== null) {
    if (!isObject(tally) || typeof tally.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(tally.date)) {
      throw fail('A tally needs a date like 2026-10-18.');
    }
    for (const k of ['correct', 'wrong', 'lines']) if (tally[k] !== undefined && !isCount(tally[k])) throw fail(`The tally's ${k} must be a whole number.`);
  }
  if (saveId !== undefined && (typeof saveId !== 'string' || !saveId || saveId.length > 64)) {
    throw fail('A save id must be text of up to 64 characters.');
  }
}
