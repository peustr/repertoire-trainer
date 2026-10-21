// The engine WebSocket (/ws) between the browser (engine-client.js) and the server
// (server.js): every message, in one place. Messages are JSON objects with a `type`.
// Each request carries an `id` (a number the page picks), and every answer to it
// repeats that id. Both sides import the names from here rather than spelling them.

/** What the browser sends. */
export const REQUEST = Object.freeze({
  ANALYSE: 'analyse',
  STOP: 'stop',
  EVALUATE: 'evaluate',
  BESTMOVE: 'bestmove',
  STATUS: 'status',
  PUZZLE_SEARCH: 'puzzle-search',
});

/** What the server sends. */
export const REPLY = Object.freeze({
  HELLO: 'hello',
  INFO: 'info',
  DONE: 'done',
  RESULT: 'result',
  SEARCH_EVENT: 'search-event',
  ERROR: 'error',
  LICHESS: 'lichess',
});

// --- browser → server ---------------------------------------------------------------

/**
 * Live analysis for the eval bar and Explore. A newer one from the same page replaces it.
 * Answered by INFO messages as the search deepens (at most every 120 ms), then DONE.
 * @typedef {{ type: 'analyse', id: number, fen: string, multipv?: number, depth?: number, movetime?: number, infinite?: boolean }} AnalyseRequest
 */
/**
 * Cancel the request with this id. Not answered; the cancelled request ends as usual.
 * @typedef {{ type: 'stop', id: number }} StopRequest
 */
/**
 * Score these moves (UCI) in a position. Answered by RESULT { best, moves }.
 * @typedef {{ type: 'evaluate', id: number, fen: string, moves: string[], depth?: number }} EvaluateRequest
 */
/**
 * A move to play, at limited strength with `elo`. Answered by RESULT { move, ... }.
 * @typedef {{ type: 'bestmove', id: number, fen: string, elo?: number, movetime?: number, newGame?: boolean }} BestmoveRequest
 */
/**
 * The engines' details. Answered by RESULT { engine }.
 * @typedef {{ type: 'status', id: number }} StatusRequest
 */
/**
 * The opponent-mistake search from a position, with the options in the user's settings.
 * Answered by SEARCH_EVENT messages as it goes, then RESULT { puzzles: [id], gaps, stats, ... }.
 * @typedef {{ type: 'puzzle-search', id: number, repId: string, fen: string,
 *   prefix?: { startFen?: string, moves?: string[] } }} PuzzleSearchRequest
 */
/** @typedef {AnalyseRequest | StopRequest | EvaluateRequest | BestmoveRequest | StatusRequest | PuzzleSearchRequest} Request */

// --- server → browser ---------------------------------------------------------------

/**
 * Sent once on connecting: the engines the server runs.
 * @typedef {{ type: 'hello', engine: object }} HelloReply
 */
/**
 * Progress of an analysis. Lines are scored from White's side.
 * @typedef {{ type: 'info', id: number, depth: number, lines: { multipv: number, depth: number, score: import('./constants.js').Score, pv: string[] }[] }} InfoReply
 */
/**
 * The end of an analysis.
 * @typedef {{ type: 'done', id: number, depth: number, lines: object[], bestmove: string | null }} DoneReply
 */
/**
 * The answer to evaluate, bestmove, status or puzzle-search; its fields depend on the request.
 * @typedef {{ type: 'result', id: number } & Record<string, any>} ResultReply
 */
/**
 * Progress of the mistake search: kind 'progress', 'found' (with the puzzle) or 'gap'.
 * @typedef {{ type: 'search-event', id: number, kind: 'progress' | 'found' | 'gap' } & Record<string, any>} SearchEventReply
 */
/**
 * Why a request failed, including a request the server does not know.
 * @typedef {{ type: 'error', id: number, message: string }} ErrorReply
 */
/**
 * Sent to every page when Lichess asks the trainer to slow down: requests wait until `until`.
 * @typedef {{ type: 'lichess', status: object, until: number }} LichessNotice
 */
/** @typedef {HelloReply | InfoReply | DoneReply | ResultReply | SearchEventReply | ErrorReply | LichessNotice} Reply */
