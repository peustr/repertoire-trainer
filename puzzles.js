// Personalised puzzles: find the mistakes real opponents make against your
// repertoire, and turn each one into a "punish it" puzzle.
//
// Best-first tree search from a position you are learning:
//   - On your turn, follow your repertoire move (or Stockfish's best once you
//     are past your preparation). Free: no API call.
//   - On the opponent's turn, ask the Lichess explorer what players at your
//     rating actually play there, then let Stockfish score every popular reply.
//     A reply that throws away a lot of evaluation is a mistake → puzzle.
//     Other popular replies are expanded further.
//   - Positions are visited in order of how likely you are to reach them
//     (product of the opponents' move frequencies), within a fixed budget of
//     explorer lookups, so the most practical mistakes surface first.

import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import * as lichess from './lichess.js';
import { defaults, finderOptions } from './settings-schema.js';
import { positionKey, scoreToCp } from './public/js/constants.js';

/**
 * The search's options. Each one is a setting tagged `search` in settings-schema.js,
 * which holds its default and help text; finderOptions() turns settings into these.
 * @typedef {object} SearchOptions
 * @property {number} maxPositions  opponent positions to look up (explorer calls, cached ones included)
 * @property {number} maxOppDepth   how many opponent decisions deep to follow
 * @property {number} candidates    most popular replies scored per opponent position
 * @property {number} minShare      ignore replies played in a smaller share of games (0.05 is 5%)
 * @property {number} minGames      ignore positions with fewer games than this
 * @property {number} threshold     centipawns an opponent move must give away to count as a mistake
 * @property {number} minAdvantage  and you must stand at least this well afterwards
 * @property {number} depth         Stockfish depth while searching
 * @property {number} solveDepth    Stockfish depth for working out the punishment
 * @property {number} uniqueGap     best move must beat the second best by this much to be a single-answer puzzle
 * @property {number} maxLength     most moves of yours in a solution
 * @property {number} maxPuzzles    stop once this many puzzles are found
 * @property {number} beyondBook    opponent moves to keep following after your repertoire line ends
 * @property {number} gapShare      unprepared replies at least this popular are reported as gaps
 * @property {string} speeds        explorer time controls, e.g. "blitz,rapid"
 * @property {string} ratings       explorer rating groups, e.g. "1600,1800"
 * @property {string} since         only games since this month (YYYY-MM); '' for all
 * @property {number} cacheDays     how long explorer answers are reused
 */

/** @type {SearchOptions} */
const DEFAULTS = /** @type {any} */ (finderOptions(defaults()));

function play(fen, move) {
  const c = new Chess();
  c.load(fen, { skipValidation: true });
  try {
    const mv = typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)
      ? c.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
      : c.move(move, { strict: false });
    return { fen: c.fen(), uci: mv.from + mv.to + (mv.promotion || ''), san: mv.san, color: mv.color };
  } catch (err) {
    return null;
  }
}

function sanLine(fen, ucis) {
  const out = [];
  let f = fen;
  for (const u of ucis) {
    const r = play(f, u);
    if (!r) break;
    out.push(r.san);
    f = r.fen;
  }
  return out;
}

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function material(fen, color) {
  let sum = 0;
  for (const ch of fen.split(' ')[0]) {
    const lower = ch.toLowerCase();
    if (!(lower in VALUES)) continue;
    const isWhite = ch !== lower;
    sum += (isWhite === (color === 'w') ? 1 : -1) * VALUES[lower];
  }
  return sum;
}

function theme(score, side, fenStart, fenEnd) {
  const pov = side === 'w' ? 1 : -1;
  if (score && 'mate' in score && score.mate * pov > 0) {
    return { key: 'mate', label: `Mate in ${Math.abs(score.mate)}` };
  }
  const gain = material(fenEnd, side) - material(fenStart, side);
  if (gain >= 8) return { key: 'queen', label: 'Wins the queen' };
  if (gain >= 5) return { key: 'rook', label: 'Wins a rook' };
  if (gain >= 3) return { key: 'piece', label: 'Wins a piece' };
  if (gain >= 2) return { key: 'material', label: 'Wins material' };
  if (gain >= 1) return { key: 'pawn', label: 'Wins a pawn' };
  return { key: 'advantage', label: 'Decisive advantage' };
}

function isMateFor(score, pov) {
  return !!score && 'mate' in score && score.mate * pov > 0;
}

/**
 * Build a puzzle from the position right after the opponent's mistake.
 * Returns null if Stockfish, looking deeper, no longer sees a clear win.
 */
async function buildPuzzle(engines, fen, side, opts) {
  const pov = side === 'w' ? 1 : -1;
  const first = await engines.lines({ fen, depth: opts.solveDepth || opts.depth + 2, multipv: 2 });
  const [a, b] = first.lines;
  if (!a || !a.pv.length) return null;
  const s1 = scoreToCp(a.score) * pov;
  if (s1 < opts.minAdvantage && !isMateFor(a.score, pov)) return null;
  const s2 = b ? scoreToCp(b.score) * pov : -Infinity;
  const unique = !b || s1 - s2 >= opts.uniqueGap || (isMateFor(a.score, pov) && !isMateFor(b.score, pov));

  // Extend the solution while each next move of ours is also clearly the only good one.
  const solution = [a.pv[0]];
  let cur = play(fen, a.pv[0]);
  let pv = a.pv;
  let finalScore = a.score;
  for (let step = 0; step < (opts.maxLength || 3) - 1 && cur; step++) {
    const reply = pv[1];
    if (!reply) break;
    const afterReply = play(cur.fen, reply);
    if (!afterReply) break;
    if (new Chess(afterReply.fen).moves().length === 0) break;
    const r = await engines.lines({ fen: afterReply.fen, depth: opts.solveDepth || opts.depth, multipv: 2 });
    const [x, y] = r.lines;
    if (!x || !x.pv.length) break;
    const sx = scoreToCp(x.score) * pov;
    const sy = y ? scoreToCp(y.score) * pov : -Infinity;
    const only = !y || sx - sy >= Math.max(opts.uniqueGap, 100) || (isMateFor(x.score, pov) && !isMateFor(y.score, pov));
    if (!only) break;
    const next = play(afterReply.fen, x.pv[0]);
    if (!next) break;
    solution.push(reply, x.pv[0]);
    cur = next;
    pv = x.pv;
    finalScore = x.score;
  }

  // Let the opponent's forced reply to our last move show, if Stockfish expects one.
  const tail = pv[1] && cur ? play(cur.fen, pv[1]) : null;
  const endFen = tail ? tail.fen : cur ? cur.fen : fen;

  return {
    fen,
    unique,
    solution,
    solutionSan: sanLine(fen, solution),
    score: finalScore,
    firstScore: a.score,
    secondScore: b ? b.score : null,
    theme: theme(a.score, side, fen, endFen),
  };
}

function puzzleId(fen, uci) {
  return crypto.createHash('sha1').update(`${positionKey(fen)}|${uci}`).digest('hex').slice(0, 12);
}

/**
 * Run the search.
 *   rep:     stored repertoire (for colour)
 *   model:   parsed repertoire (myMovesAt: positionKey -> Set(uci))
 *   fen:     position to search from
 *   prefix:  { startFen, moves[] } — how that position is reached from the chapter start
 *   options: overrides for DEFAULTS (SearchOptions)
 *   onEvent: progress callback
 *   cancelled(): returns true to stop early
 *
 * @param {{ rep: any, model: any, fen: string, prefix?: { startFen?: string, moves?: string[] },
 *   options?: Partial<SearchOptions>, engines: any, onEvent?: (event: any) => void, cancelled?: () => boolean }} args
 */
async function searchMistakes({ rep, model, fen, prefix, options = {}, engines, onEvent = () => {}, cancelled = () => false }) {
  const opts = { ...DEFAULTS, ...options };
  const side = rep.color === 'black' ? 'b' : 'w';
  const pov = side === 'w' ? 1 : -1;
  const found = [];
  const seenPuzzle = new Set();
  const visited = new Set();
  const stats = { positions: 0, lookups: 0, cached: 0, evaluations: 0, rootGames: null, skipped: 0 };
  const gaps = [];
  const inTree = (f) => model.nodesByPosition.has(positionKey(f));
  const frontier = [{ fen, path: [], reach: 1, oppDepth: 0, hint: null, offBook: 0 }];

  const pop = () => {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].reach > frontier[best].reach) best = i;
    return frontier.splice(best, 1)[0];
  };

  while (frontier.length && stats.positions < opts.maxPositions && found.length < opts.maxPuzzles && !cancelled()) {
    const node = pop();
    const turn = node.fen.split(' ')[1];

    if (turn === side) {
      // Our move: follow the repertoire, or Stockfish once we're out of book.
      const key = positionKey(node.fen);
      let moves = [...((model.myMovesAt.get(key)) || [])];
      const inBook = moves.length > 0;
      if (!moves.length) {
        let best = node.hint;
        if (!best) {
          const r = await engines.lines({ fen: node.fen, depth: opts.depth, multipv: 1 });
          stats.evaluations++;
          best = r.lines[0] && r.lines[0].pv[0];
        }
        if (best) moves = [best];
      }
      for (const m of moves) {
        const next = play(node.fen, m);
        if (next) frontier.push({ fen: next.fen, path: [...node.path, next.uci], reach: node.reach, oppDepth: node.oppDepth, hint: null, offBook: inBook ? 0 : node.offBook });
      }
      continue;
    }

    if (node.oppDepth >= opts.maxOppDepth) continue;
    const key = positionKey(node.fen);
    if (visited.has(key)) continue;
    visited.add(key);

    let data;
    try {
      data = await lichess.explorer({ fen: node.fen, speeds: opts.speeds, ratings: opts.ratings, since: opts.since, cacheDays: opts.cacheDays, moves: Math.max(12, opts.candidates) });
    } catch (err) {
      if (err.status === 401 || err.status === 429 || err.status === 502) throw err;
      stats.skipped++;
      continue;
    }
    stats.positions++;
    if (data.cached) stats.cached++; else stats.lookups++;
    if (stats.rootGames === null) stats.rootGames = data.total;

    onEvent({
      kind: 'progress',
      stats: { ...stats },
      budget: opts.maxPositions,
      at: { san: sanLine(fen, node.path), reach: node.reach, games: data.total },
    });

    if (data.total < opts.minGames) continue;

    const candidates = [];
    for (const m of data.moves) {
      const share = m.total / data.total;
      if (share < opts.minShare) continue;
      const mv = play(node.fen, m.san) || play(node.fen, m.uci);
      if (!mv) continue;
      candidates.push({ ...m, uci: mv.uci, san: mv.san, share, after: mv.fen });
      if (candidates.length >= opts.candidates) break;
    }
    if (!candidates.length || cancelled()) continue;

    const ev = await engines.evaluate({ fen: node.fen, moves: candidates.map((c) => c.uci), depth: opts.depth });
    stats.evaluations++;
    // No score for the best move (the search was cut short): there is nothing to measure
    // the replies against, and treating it as level would invent mistakes.
    if (!ev.best || !ev.best.score) {
      stats.skipped++;
      continue;
    }
    const bestForUs = scoreToCp(ev.best.score) * pov; // what the opponent's best move leaves us with
    // Did you prepare replies for the opponent here? Then a popular reply outside your lines is a gap.
    const prepared = inTree(node.fen) && (model.nodesByPosition.get(positionKey(node.fen)) || []).some((n) => n.children.some((ch) => ch.color !== side));

    for (const c of candidates) {
      const scored = ev.moves.find((m) => m.move === c.uci);
      if (!scored || !scored.score) continue;
      const afterForUs = scoreToCp(scored.score) * pov;
      const gain = afterForUs - bestForUs;
      const mistake = (gain >= opts.threshold && afterForUs >= opts.minAdvantage) || (isMateFor(scored.score, pov) && !isMateFor(ev.best.score, pov));

      if (mistake) {
        const pid = puzzleId(c.after, c.uci);
        if (seenPuzzle.has(pid)) continue;
        seenPuzzle.add(pid);
        if (cancelled()) break;
        const built = await buildPuzzle(engines, c.after, side, opts);
        stats.evaluations++;
        if (!built) continue;
        const id = puzzleId(c.after, built.solution[0]);
        const userWins = side === 'w' ? c.white : c.black;
        const pathToMistake = [...node.path, c.uci];
        const puzzle = {
          id,
          createdAt: new Date().toISOString(),
          fen: c.after,
          beforeFen: node.fen,
          startFen: prefix && prefix.startFen ? prefix.startFen : fen,
          lineMoves: [...((prefix && prefix.moves) || []), ...pathToMistake],
          searchRoot: fen,
          pathSan: sanLine(fen, pathToMistake),
          mistake: {
            uci: c.uci,
            san: c.san,
            share: Math.round(c.share * 1000) / 1000,
            games: c.total,
            positionGames: data.total,
            averageRating: c.averageRating,
            yourScore: c.total ? Math.round(((userWins + c.draws / 2) / c.total) * 100) : null,
            bestBefore: ev.best.score,
            bestMoveBefore: ev.best.move,
            bestMoveBeforeSan: (play(node.fen, ev.best.move) || {}).san || null,
            after: scored.score,
            gain: Math.round(gain),
          },
          reach: Math.round(node.reach * c.share * 10000) / 10000,
          filters: { speeds: lichess.cleanSpeeds(opts.speeds), ratings: lichess.cleanRatings(opts.ratings) },
          ...built,
        };
        found.push(puzzle);
        onEvent({ kind: 'found', puzzle, stats: { ...stats } });
      } else {
        const covered = inTree(c.after);
        if (prepared && !covered) {
          // A sound reply you have no line for: worth knowing, not worth searching.
          if (c.share >= opts.gapShare && !gaps.some((g) => g.fen === c.after)) {
            const gap = {
              fen: c.after,
              beforeFen: node.fen,
              pathSan: sanLine(fen, [...node.path, c.uci]),
              lineMoves: [...((prefix && prefix.moves) || []), ...node.path, c.uci],
              startFen: prefix && prefix.startFen ? prefix.startFen : fen,
              san: c.san,
              share: Math.round(c.share * 1000) / 1000,
              games: c.total,
              reach: Math.round(node.reach * c.share * 10000) / 10000,
              score: scored.score,
              bestReply: scored.pv && scored.pv[1] ? scored.pv[1] : null,
              bestReplySan: scored.pv && scored.pv[1] ? (play(c.after, scored.pv[1]) || {}).san || null : null,
            };
            gaps.push(gap);
            onEvent({ kind: 'gap', gap, stats: { ...stats } });
          }
          continue;
        }
        const offBook = covered ? 0 : node.offBook + 1;
        if (node.oppDepth + 1 < opts.maxOppDepth && offBook <= opts.beyondBook) {
          frontier.push({
            fen: c.after,
            path: [...node.path, c.uci],
            reach: node.reach * c.share,
            oppDepth: node.oppDepth + 1,
            hint: scored.pv && scored.pv[1] ? scored.pv[1] : null,
            offBook,
          });
        }
      }
    }
  }

  return { puzzles: found, gaps, stats, exhausted: frontier.length === 0, cancelled: cancelled() };
}

export { searchMistakes, buildPuzzle, DEFAULTS, material, theme };
