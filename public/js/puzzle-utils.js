// Helpers for opponent-mistake puzzles and Lichess explorer data.

import { Chess } from 'chess.js';
import { isDue } from './srs.js';
import { START_FEN, RATING_GROUPS, SPEED_NAMES, scoreToCp } from './constants.js';

export const puzzleKey = (id) => `pz|${id}`;

export function puzzleList(rep) {
  return Object.values(rep.puzzles || {});
}

export function puzzleState(rep, puzzle) {
  return (rep.cards || {})[puzzleKey(puzzle.id)] || null;
}

/**
 * Due puzzles first (most overdue first), then new ones (most likely to come up first).
 * Puzzles chosen by id come even when they are not due yet, after the others, soonest
 * due first: you asked for them.
 * @param {any} rep
 * @param {{ limit?: number, now?: number, only?: string[] | null }} [options]  only: these puzzle ids
 */
export function puzzleQueue(rep, { limit = 12, now = Date.now(), only = null } = {}) {
  let list = puzzleList(rep);
  if (only) list = list.filter((p) => only.includes(p.id));
  const due = [];
  const fresh = [];
  const later = [];
  for (const p of list) {
    const s = puzzleState(rep, p);
    if (!s) fresh.push(p);
    else if (isDue(s, now)) due.push(p);
    else if (only) later.push(p);
  }
  const byDue = (a, b) => puzzleState(rep, a).due - puzzleState(rep, b).due;
  due.sort(byDue);
  fresh.sort((a, b) => (b.reach || 0) - (a.reach || 0));
  later.sort(byDue);
  return [...due, ...fresh, ...later].slice(0, limit);
}

export function puzzleStats(rep, now = Date.now()) {
  const list = puzzleList(rep);
  let due = 0;
  let fresh = 0;
  for (const p of list) {
    const s = puzzleState(rep, p);
    if (!s) fresh++;
    else if (isDue(s, now)) due++;
  }
  return { total: list.length, due, fresh, ready: due + fresh };
}

export function formatGames(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export function formatShare(x) {
  if (x == null) return '—';
  const pct = x * 100;
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

export function describeRatings(ratings) {
  const list = (Array.isArray(ratings) ? ratings : String(ratings || '').split(',').filter(Boolean).map(Number))
    .filter((n) => RATING_GROUPS.includes(n))
    .sort((a, b) => a - b);
  if (!list.length) return 'all ratings';
  const lo = list[0];
  const hiGroup = list[list.length - 1];
  const next = RATING_GROUPS[RATING_GROUPS.indexOf(hiGroup) + 1];
  return next ? `${lo}–${next - 1}` : `${lo}+`;
}

export function describeSpeeds(speeds) {
  const list = Array.isArray(speeds) ? speeds : String(speeds || '').split(',').filter(Boolean);
  return list.map((s) => (SPEED_NAMES[s] || s).toLowerCase()).join(', ') || 'all speeds';
}

/** "1 in 12 games" style frequency for how often you'd reach a position. */
export function describeReach(reach) {
  if (!reach) return null;
  if (reach >= 0.5) return 'in most of your games from here';
  const n = Math.round(1 / reach);
  return `about 1 in ${n.toLocaleString()} games from here`;
}

/** Score helper: centipawns from your point of view. */
export function cpFor(score, side) {
  const raw = scoreToCp(score);
  return side === 'w' ? raw : -raw;
}

/**
 * A PGN game for "add the punishment to my repertoire".
 * @param {any} puzzle
 * @param {{ title?: string }} [options]
 */
export function puzzleToPgn(puzzle, { title } = {}) {
  const c = new Chess();
  const start = puzzle.startFen || START_FEN;
  c.load(start);
  const moves = [...puzzle.lineMoves, ...puzzle.solution];
  const mistakeIndex = puzzle.lineMoves.length - 1;
  const parts = [];
  for (let i = 0; i < moves.length; i++) {
    const u = moves[i];
    const before = c.fen().split(' ');
    let mv;
    try { mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch (err) { break; }
    const num = +before[5];
    // Black moves need their number at the start and right after a comment.
    const needNum = i === 0 || i - 1 === mistakeIndex || i - 1 === mistakeIndex + 1;
    let token = mv.color === 'w' ? `${num}. ${mv.san}` : needNum ? `${num}... ${mv.san}` : mv.san;
    if (i === mistakeIndex) {
      const m = puzzle.mistake;
      token += ` $2 { Played in ${formatShare(m.share)} of ${formatGames(m.positionGames)} Lichess games (${describeRatings(puzzle.filters && puzzle.filters.ratings)}).${m.bestMoveBeforeSan ? ` Better was ${m.bestMoveBeforeSan}.` : ''} }`;
    }
    if (i === mistakeIndex + 1) token += ` $1 { ${puzzle.theme ? puzzle.theme.label : 'Punish it'}. }`;
    parts.push(token);
  }
  const headers = [
    `[Event "${(title || `Punish ${puzzle.pathSan[puzzle.pathSan.length - 1]}`).replace(/"/g, "'")}"]`,
    `[ChapterName "${(title || `Opponent mistake: ${puzzle.mistake.san}`).replace(/"/g, "'")}"]`,
  ];
  if (start !== START_FEN) headers.push('[SetUp "1"]', `[FEN "${start}"]`);
  return `${headers.join('\n')}\n\n${parts.join(' ')} *\n`;
}
