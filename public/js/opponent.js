// How the trainer's opponents choose their moves, without the board or the page.
// Lichess players pick a move as often as real players at your level do, and a
// surprise is a reasonable reply your repertoire has no answer for. Spar and the
// Surprise drills use these; test/opponent.test.mjs pins them down. No DOM code here.

import { Chess } from 'chess.js';
import { START_FEN, positionKey, scoreToCp } from './constants.js';
import { playMove } from './moves.js';

/**
 * @typedef {{ uci: string, san: string, total: number }} ExplorerMove
 * @typedef {{ total?: number, moves?: ExplorerMove[] }} ExplorerAnswer
 * @typedef {{ startFen: string, moves: string[], fen: string, uci: string, san: string,
 *   share: number | null, games: number | null, source: 'gap' | 'lichess' | 'engine', gapKey?: string }} Surprise
 *   moves lead from startFen to fen, the position before the surprise move uci
 * @typedef {{ fen: string, startFen: string, moves: string[] }} OpponentTurn
 */

/**
 * A move from an explorer answer, chosen with the odds real players give it: a move
 * played in 30% of the position's games comes up 30% of the time (among the moves the
 * explorer lists). Null when the position has no games, so Stockfish has to take over.
 * share is the move's part of all the position's games.
 * @param {ExplorerAnswer | null | undefined} data
 * @param {() => number} [rand]
 * @returns {(ExplorerMove & { share: number }) | null}
 */
export function pickByPopularity(data, rand = Math.random) {
  const moves = ((data && data.moves) || []).filter((m) => m && m.uci && m.total > 0);
  const listed = moves.reduce((sum, m) => sum + m.total, 0);
  if (!listed) return null;
  const all = Math.max(listed, (data && data.total) || 0);
  let x = rand() * listed;
  let pick = moves[moves.length - 1];
  for (const m of moves) {
    x -= m.total;
    if (x < 0) { pick = m; break; }
  }
  return { ...pick, share: pick.total / all };
}

/**
 * The moves your repertoire has in a position, in any chapter, for either side.
 * @param {{ nodesByPosition: Map<string, any[]> }} model
 * @param {string} fen
 */
export function bookMovesAt(model, fen) {
  const out = new Set();
  for (const n of model.nodesByPosition.get(positionKey(fen)) || []) for (const c of n.children) out.add(c.uci);
  return out;
}

/**
 * The positions in your lines where the opponent is to move and your repertoire expects
 * a reply: where a surprise can come. One per position, with the moves that lead there.
 * @param {{ side: string, lines: any[] }} model
 * @returns {OpponentTurn[]}
 */
export function opponentTurns(model) {
  const seen = new Set();
  const out = [];
  for (const line of model.lines) {
    line.nodes.forEach((node, i) => {
      if (node.color === model.side) return;
      const fen = node.parent.fen;
      const key = positionKey(fen);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ fen, startFen: line.startFen, moves: line.nodes.slice(0, i).map((n) => n.uci) });
    });
  }
  return out;
}

/** A move the repertoire does not answer: not one of its moves here, and not a transposition into it. */
function offBook(model, fen, uci, book) {
  if (book.has(uci)) return null;
  const after = playMove(fen, uci);
  if (!after || model.nodesByPosition.has(positionKey(after.fen))) return null;
  return after;
}

/**
 * Popular replies your repertoire has no answer for, from an explorer answer: played in
 * at least minShare (a fraction) of the position's games. Most popular first.
 * @param {{ nodesByPosition: Map<string, any[]> }} model
 * @param {string} fen
 * @param {ExplorerAnswer | null | undefined} data
 * @param {{ minShare?: number }} [options]
 * @returns {{ uci: string, san: string, games: number, share: number }[]}
 */
export function surpriseReplies(model, fen, data, { minShare = 0.05 } = {}) {
  const total = (data && data.total) || 0;
  if (!total) return [];
  const book = bookMovesAt(model, fen);
  const out = [];
  for (const m of data.moves || []) {
    if (!m || !m.total || m.total / total < minShare) continue;
    const after = offBook(model, fen, m.uci, book);
    if (after) out.push({ uci: m.uci, san: after.san, games: m.total, share: m.total / total });
  }
  return out.sort((a, b) => b.share - a.share);
}

/**
 * Replies Stockfish rates as sound that your repertoire does not answer, from a MultiPV
 * search (scores from White's side): at most maxLoss centipawns worse for the side to
 * move than Stockfish's best. Used when there are no Lichess numbers to go on.
 * @param {{ nodesByPosition: Map<string, any[]> }} model
 * @param {string} fen
 * @param {{ score?: { cp?: number, mate?: number }, pv?: string[] }[]} lines
 * @param {{ maxLoss?: number }} [options]
 * @returns {{ uci: string, san: string, loss: number }[]}
 */
export function engineSurprises(model, fen, lines, { maxLoss = 120 } = {}) {
  const scored = (lines || []).filter((l) => l && l.score && l.pv && l.pv.length);
  if (!scored.length) return [];
  const pov = fen.split(' ')[1] === 'b' ? -1 : 1;
  const best = scoreToCp(scored[0].score) * pov;
  const book = bookMovesAt(model, fen);
  const out = [];
  for (const l of scored) {
    const loss = best - scoreToCp(l.score) * pov;
    if (loss > maxLoss) continue;
    const after = offBook(model, fen, l.pv[0], book);
    if (after && !out.some((o) => o.uci === l.pv[0])) out.push({ uci: l.pv[0], san: after.san, loss: Math.round(loss) });
  }
  return out;
}

/**
 * A saved gap (from the mistake finder) as a surprise, or null if your repertoire covers
 * it by now or the gap is damaged.
 * @param {{ nodesByPosition: Map<string, any[]> }} model
 * @param {string} key
 * @param {any} gap
 * @returns {Surprise | null}
 */
export function surpriseFromGap(model, key, gap) {
  if (!gap || !Array.isArray(gap.lineMoves) || !gap.lineMoves.length) return null;
  const startFen = gap.startFen || START_FEN;
  let fen = startFen;
  const moves = gap.lineMoves.slice(0, -1);
  for (const uci of moves) {
    const next = playMove(fen, uci);
    if (!next) return null;
    fen = next.fen;
  }
  const uci = gap.lineMoves[gap.lineMoves.length - 1];
  const after = offBook(model, fen, uci, bookMovesAt(model, fen));
  if (!after) return null;
  return { startFen, moves, fen, uci, san: after.san, share: gap.share ?? null, games: gap.games ?? null, source: 'gap', gapKey: key };
}

/**
 * What a Surprise session works through: saved gaps first (most likely to meet first),
 * then every opponent turn in the repertoire in random order. Turns still need a
 * surprise looked up for them (Lichess or Stockfish).
 * @param {{ gaps?: Record<string, any> }} rep
 * @param {any} model
 * @param {{ rand?: () => number }} [options]
 * @returns {({ kind: 'gap', surprise: Surprise, reach: number } | { kind: 'turn', turn: OpponentTurn })[]}
 */
export function surpriseQueue(rep, model, { rand = Math.random } = {}) {
  /** @type {{ kind: 'gap', surprise: Surprise, reach: number }[]} */
  const gaps = [];
  for (const [key, gap] of Object.entries(rep.gaps || {})) {
    const surprise = surpriseFromGap(model, key, gap);
    if (surprise) gaps.push({ kind: 'gap', surprise, reach: gap.reach || 0 });
  }
  gaps.sort((a, b) => b.reach - a.reach);
  const turns = opponentTurns(model);
  for (let i = turns.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [turns[i], turns[j]] = [turns[j], turns[i]];
  }
  const gapPositions = new Set(gaps.map((g) => positionKey(g.surprise.fen)));
  return [...gaps, ...turns.filter((t) => !gapPositions.has(positionKey(t.fen))).map((turn) => ({ kind: /** @type {const} */ ('turn'), turn }))];
}

/**
 * A PGN chapter with the moves to a surprise, the surprise and your answer to it, for
 * "add this answer to my repertoire".
 * @param {Pick<Surprise, 'startFen' | 'moves' | 'uci'>} surprise
 * @param {string} answer  UCI
 * @param {{ note?: string }} [options]  a comment for the surprise move
 */
export function surpriseToPgn(surprise, answer, { note } = {}) {
  const c = new Chess();
  c.load(surprise.startFen);
  const moves = [...surprise.moves, surprise.uci, answer];
  const surpriseIndex = surprise.moves.length;
  const parts = [];
  let title = '';
  for (let i = 0; i < moves.length; i++) {
    const u = moves[i];
    const num = +c.fen().split(' ')[5];
    let mv;
    try { mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch (err) { throw new Error(`The move ${u} is not legal here.`, { cause: err }); }
    // A black move needs its number at the start and after a comment.
    const needNum = i === 0 || i - 1 === surpriseIndex;
    parts.push(mv.color === 'w' ? `${num}. ${mv.san}` : needNum ? `${num}... ${mv.san}` : mv.san);
    if (i === surpriseIndex) {
      title = `${num}${mv.color === 'w' ? '.' : '...'}${mv.san}`;
      const text = (note || '').replace(/[{}]/g, '').trim();
      if (text) parts.push(`{ ${text} }`);
    }
  }
  const headers = [`[Event "Surprise: ${title}"]`, `[ChapterName "Answer to ${title}"]`];
  if (surprise.startFen !== START_FEN) headers.push('[SetUp "1"]', `[FEN "${surprise.startFen}"]`);
  return `${headers.join('\n')}\n\n${parts.join(' ')} *\n`;
}
