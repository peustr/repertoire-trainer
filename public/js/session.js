// The training rules, without the board or the page: which of your moves a pass
// over a line quizzes, how each answer is graded, and what the results do to the
// memory schedule. The trainer, the puzzle page, the library's warm-up card, the
// Surprise drills and Spar's play-outs use these; test/session.test.mjs pins them
// down. No DOM code here.
//
// A pass has a phase:
//   guided    Learn, first time through: arrows show the new moves
//   recall    Learn, from memory straight after
//   review    due moves are asked; known ones play themselves
//   practice  every move is asked; the schedule is untouched
//
// Results per card key: 'right', 'wrong', 'hint' (used a hint, not counted against
// you), or 'auto' (played for you because it was not asked).

import { lineStatus, learned, promote, demote, isDue } from './srs.js';

/**
 * The memory schedule in the user's settings.
 * @param {{ srsIntervals?: number[], stepbackLevels?: number }} settings
 * @returns {import('./srs.js').Schedule}
 */
function scheduleOf({ srsIntervals, stepbackLevels }) {
  return { intervals: srsIntervals, stepbackLevels };
}

/** Which card keys a pass asks you to play, and which were due when it began. */
export function passPlan(line, cards, phase, { quizAllMoves = false } = {}, now = Date.now()) {
  const st = lineStatus(line, cards, now);
  let quiz;
  if (phase === 'guided' || phase === 'recall') quiz = st.newKeys;
  else if (phase === 'review') quiz = quizAllMoves ? line.cardKeys : st.dueKeys;
  else quiz = line.cardKeys;
  return { quiz: new Set(quiz), dueAtStart: new Set(st.dueKeys) };
}

/** The result for the right move, played after `tries` wrong attempts and `hints` hints. */
export function resultForCorrectMove({ tries, hints }, { hintsCount = true } = {}) {
  if (tries === 0 && hints === 0) return 'right';
  // With "a hint counts as a mistake" off, a hinted move neither levels up nor drops.
  if (tries === 0 && !hintsCount) return 'hint';
  return 'wrong';
}

/** The result once a hint is used. The guided pass shows the move anyway, so nothing changes there. */
export function resultAfterHint(previous, phase, { hintsCount = true } = {}) {
  if (phase === 'guided') return previous;
  if (hintsCount) return 'wrong';
  return previous === 'wrong' ? 'wrong' : 'hint';
}

/** A move's first real result in a pass is the one that counts. */
export function firstResult(previous, result) {
  return previous && previous !== 'auto' ? previous : result;
}

/**
 * What playing a move other than the line's means:
 *   'alternative'   another repertoire move here: try again, no penalty
 *                   (a mistake with altPolicy 'mistake', except while guided)
 *   'follow-arrow'  guided pass: just follow the arrow
 *   'mistake'       counts against you
 */
export function judgeWrongMove({ inRepertoire, phase }, { altPolicy = 'retry' } = {}) {
  if (inRepertoire && (altPolicy !== 'mistake' || phase === 'guided')) return 'alternative';
  if (phase === 'guided') return 'follow-arrow';
  return 'mistake';
}

/**
 * The end of a pass: new card states for the schedule, and what happened to each move.
 * A guided pass graded here (Learn with "replay from memory" off) puts the new moves
 * straight into the schedule: everything not missed counts as right.
 *
 * Returns { results, updates, outcomes, right, wrong }
 *   results:  the pass's results after that conversion (a new Map)
 *   updates:  { cardKey: state } to save
 *   outcomes: [{ key, result, change, next }] in line order, where change is
 *             'learned' | 'promoted' | 'demoted' | 'not-due' | 'hint' | 'practice'
 */
export function gradePass({ line, phase, quiz, dueAtStart, results, cards, now = Date.now() }, settings = {}) {
  const { mistakePolicy = 'reset' } = settings;
  const schedule = scheduleOf(settings);
  const graded = new Map(results);
  if (phase === 'guided') {
    for (const key of quiz) if (graded.get(key) !== 'wrong') graded.set(key, 'right');
    phase = 'recall';
  }
  const updates = {};
  const outcomes = [];
  let right = 0;
  let wrong = 0;
  for (const key of line.cardKeys) {
    const result = graded.get(key);
    const prev = cards[key];
    if (result === 'right') right++;
    if (result === 'wrong') wrong++;
    let change = null;
    let next = null;
    if (phase === 'practice') {
      if (result === 'right' || result === 'wrong' || result === 'hint') change = 'practice';
    } else if (phase === 'recall') {
      if (quiz.has(key)) { next = learned(schedule, now, result === 'right'); change = 'learned'; }
    } else if (phase === 'review') {
      if (result === 'wrong' && prev) { next = demote(schedule, prev, now, mistakePolicy); change = 'demoted'; }
      else if (result === 'right' && prev && dueAtStart.has(key)) { next = promote(schedule, prev, now); change = 'promoted'; }
      else if (result === 'right') change = 'not-due';
      else if (result === 'hint') change = 'hint';
    }
    if (next) updates[key] = next;
    if (change) outcomes.push({ key, result, change, next });
  }
  return { results: graded, updates, outcomes, right, wrong };
}

/**
 * One card answered on its own (a puzzle, the library's warm-up). Returns the new
 * state, or `prev` itself when nothing changes:
 *   new card: learned (due again at once if missed)
 *   missed:   demoted, due or not
 *   solved:   promoted if due, otherwise unchanged
 */
export function gradeCard(prev, success, settings = {}, now = Date.now()) {
  const { mistakePolicy = 'reset' } = settings;
  const schedule = scheduleOf(settings);
  if (!prev) return learned(schedule, now, success);
  if (!success) return demote(schedule, prev, now, mistakePolicy);
  if (isDue(prev, now)) return promote(schedule, prev, now);
  return prev;
}

// --- off the book --------------------------------------------------------------------
// Surprise drills and play-outs are graded by Stockfish, not by a book move, and leave
// the schedule alone. `loss` is how many centipawns a move gives away against
// Stockfish's best, from your side (never below 0).

/**
 * Your answer to a surprise: 'best' and 'good' pass, 'inaccuracy' and 'mistake' do not.
 * @param {{ loss: number, isBest?: boolean }} answer
 * @param {{ surpriseTolerance?: number }} [settings]
 * @returns {'best' | 'good' | 'inaccuracy' | 'mistake'}
 */
export function gradeSurprise({ loss, isBest = false }, { surpriseTolerance = 50 } = {}) {
  if (isBest || loss <= 10) return 'best';
  if (loss <= surpriseTolerance) return 'good';
  if (loss <= Math.max(150, surpriseTolerance * 2)) return 'inaccuracy';
  return 'mistake';
}

/** @param {string} grade */
export const surprisePassed = (grade) => grade === 'best' || grade === 'good';

/** Clearly winning: dropping some of a big advantage still counts as keeping it. */
const STILL_WINNING = 300;

/**
 * The end of a play-out, where you try to keep the position the line left you with.
 * startCp and endCp are Stockfish's evaluations from your side; `result` is set when the
 * game itself ended. You pass if the evaluation fell by at most playOutTolerance, or
 * you are still clearly winning.
 * @param {{ startCp: number, endCp: number, result?: 'win' | 'loss' | 'draw' | null }} playout
 * @param {{ playOutTolerance?: number }} [settings]
 * @returns {{ pass: boolean, drop: number, verdict: 'won' | 'lost' | 'drawn' | 'improved' | 'held' | 'slipped' }}
 */
export function gradePlayout({ startCp, endCp, result = null }, { playOutTolerance = 70 } = {}) {
  if (result === 'win') return { pass: true, drop: 0, verdict: 'won' };
  if (result === 'loss') return { pass: false, drop: Math.max(0, startCp - endCp), verdict: 'lost' };
  if (result === 'draw') return { pass: startCp <= playOutTolerance, drop: Math.max(0, startCp), verdict: 'drawn' };
  const drop = startCp - endCp;
  if (drop <= playOutTolerance) return { pass: true, drop, verdict: drop < -playOutTolerance ? 'improved' : 'held' };
  if (endCp >= STILL_WINNING) return { pass: true, drop, verdict: 'held' };
  return { pass: false, drop, verdict: 'slipped' };
}

/**
 * The move that gave away the most, if it gave away at least `min` centipawns. Moves
 * without a loss (not checked by Stockfish) are left out.
 * @template {{ loss?: number | null }} T
 * @param {T[]} moves
 * @param {number} [min]
 * @returns {T | null}
 */
export function biggestSlip(moves, min = 50) {
  let worst = null;
  for (const m of moves) if (m.loss != null && m.loss >= min && (!worst || m.loss > /** @type {number} */ (worst.loss))) worst = m;
  return worst;
}
