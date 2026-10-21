// Playing a move from a position: the one copy the browser and the server share. The PGN
// reader, the opponents, the mistake search and every board page use it. Positions are
// loaded without chess.js's checks, so a position a study sets up still plays; a move that
// is not legal there gives null.

import { Chess } from 'chess.js';

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const scratch = new Chess(); // reused: loading a position is cheaper than a new game each move

/**
 * Play one move, given in UCI (e2e4, e7e8q) or in SAN (Nf3, O-O, exd5). Null when it is not
 * legal or cannot be read, and for a null move ("--"), which is no move at all.
 * @param {string} fen
 * @param {string | null | undefined} move
 * @returns {{ fen: string, uci: string, san: string, color: 'w' | 'b', captured: boolean } | null}
 */
export function playMove(fen, move) {
  try {
    scratch.load(fen, { skipValidation: true });
    const mv = typeof move === 'string' && UCI.test(move)
      ? scratch.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
      : scratch.move(move, { strict: false });
    if (mv.san === '--') return null; // chess.js reads null and "--" as a null move
    return { fen: scratch.fen(), uci: mv.from + mv.to + (mv.promotion || ''), san: mv.san, color: mv.color, captured: !!mv.captured };
  } catch (err) {
    return null;
  }
}
