// @ts-check
// Every setting the app understands: its default, allowed range and the help
// text shown in the Settings panel. The server validates against this, and the
// browser builds the Settings page from it. A field with `search` is also an option
// of the mistake finder (puzzles.js), under that name; percentages become fractions.

import os from 'node:os';
import { SPEEDS as SPEED_KEYS, SPEED_NAMES, RATING_GROUPS, ratingGroupLabel } from './public/js/constants.js';

const WASM_HASH_MAX = 512; // the built-in WebAssembly engine fails to start above this

function machine() {
  const cores = Math.max(1, (os.cpus() || []).length);
  const memGB = Math.round(os.totalmem() / 2 ** 30);
  return { cores, memGB };
}

/** Defaults sized for the computer the trainer runs on. */
function engineDefaults() {
  const { cores, memGB } = machine();
  return {
    analysisThreads: Math.max(1, Math.min(4, cores - 1)),
    analysisHash: memGB >= 8 ? 256 : 128,
    taskThreads: Math.max(1, Math.min(2, cores - 1)),
    taskHash: 64,
  };
}

const SPEEDS = SPEED_KEYS.map((s) => [s, SPEED_NAMES[s]]);
const RATINGS = RATING_GROUPS.map((g) => [String(g), ratingGroupLabel(g)]);

/** Keep each group's fields together, in the order the groups first appear. */
function groupFields(sections) {
  for (const sec of sections) {
    const order = [];
    for (const f of sec.fields) if (!order.includes(f.group || '')) order.push(f.group || '');
    sec.fields = order.flatMap((g) => sec.fields.filter((f) => (f.group || '') === g));
  }
  return sections;
}

function buildSchema() {
  const { cores, memGB } = machine();
  const e = engineDefaults();
  return groupFields([
    {
      id: 'training',
      title: 'Training',
      intro: 'How Learn, Review and Practise sessions run.',
      fields: [
        { key: 'reviewBatch', group: 'Sessions', type: 'int', min: 1, max: 200, default: 20, unit: 'lines', label: 'Lines per review session', help: 'How many due lines one Review session covers. Smaller sessions are easier to fit into a busy day.' },
        { key: 'learnBatch', group: 'Sessions', type: 'int', min: 1, max: 50, default: 5, unit: 'lines', label: 'New lines per learn session', help: 'New lines introduced at a time. Three to five is plenty for most people; learning many at once makes the first reviews pile up.' },
        { key: 'learnRecall', group: 'Sessions', type: 'bool', default: true, label: 'Replay new lines from memory straight away', help: 'After a new line is shown with arrows, play it once more without help before it joins your review schedule.' },
        { key: 'quizAllMoves', group: 'Sessions', type: 'bool', default: false, label: 'Quiz every move during reviews', help: 'Off: only moves that are due are asked, and moves you already know play themselves. On: you play all of your moves in the line. Only due moves level up when you get them right, but a mistake sends any move back down, due or not.' },
        { key: 'hintsCount', group: 'Mistakes and hints', type: 'bool', default: true, label: 'A hint counts as a mistake', help: 'On: using Hint sends that move back as if you had got it wrong. Off: hints cost nothing, but the move does not level up either.' },
        { key: 'altPolicy', group: 'Mistakes and hints', type: 'select', default: 'retry', label: 'When you play a move from a different line', help: 'Sometimes you play a move that is in your repertoire, just not in the line being drilled.', options: [['retry', 'Let me try again, no penalty'], ['mistake', 'Count it as a mistake']] },
        { key: 'showComments', group: 'What you see', type: 'bool', default: true, label: 'Show the PGN’s comments while reviewing', help: 'Learn always shows them. Turn this off for a quieter screen during reviews.' },
        { key: 'pgnArrows', group: 'What you see', type: 'bool', default: true, label: 'Show arrows and highlights from the PGN', help: 'The coloured arrows and squares drawn in Lichess studies and ChessBase files.' },
        { key: 'moveDelay', group: 'Pace', type: 'int', min: 0, max: 3000, step: 50, default: 450, unit: 'ms', label: 'Opponent reply speed', help: 'Pause before the opponent’s move appears. 0 is instant.' },
        { key: 'knownDelay', group: 'Pace', type: 'int', min: 0, max: 3000, step: 50, default: 220, unit: 'ms', label: 'Speed of moves you already know', help: 'During reviews, your moves that are not due play themselves after this pause.' },
        { key: 'autoNext', group: 'Sessions', type: 'int', min: 0, max: 20, default: 0, unit: 'seconds', label: 'Go to the next line automatically after', help: '0 keeps the line summary on screen until you press Next line.' },
        { key: 'practiceOrder', group: 'Sessions', type: 'select', default: 'shuffle', label: 'Order of lines in Practise', options: [['shuffle', 'Shuffled'], ['ordered', 'In chapter order']] },
      ],
    },
    {
      id: 'memory',
      title: 'Memory schedule',
      intro: 'Each move you learn climbs eight levels. A correct answer on a due move moves it up one level; the wait before it comes back grows with each level.',
      fields: [
        { key: 'srsIntervals', type: 'intervals', default: [4, 24, 72, 168, 336, 720, 2160, 4320], label: 'Wait after reaching each level', help: 'The defaults follow Chessable’s MoveTrainer: 4 hours, 1 day, 3 days, 1 week, 2 weeks, 1 month, 3 months, 6 months. Each wait should be longer than the one before.' },
        { key: 'mistakePolicy', type: 'select', default: 'reset', label: 'After a mistake', help: 'What happens to a move you get wrong in a review.', options: [['reset', 'Back to level 1'], ['stepback', 'Drop a few levels']] },
        { key: 'stepbackLevels', type: 'int', min: 1, max: 7, default: 2, unit: 'levels', label: 'Levels to drop', help: 'Only used when “After a mistake” is set to “Drop a few levels”.', showIf: ['mistakePolicy', 'stepback'] },
      ],
    },
    {
      id: 'engine',
      title: 'Stockfish',
      intro: `Stockfish always runs the latest version bundled with the app, or your own native .exe. This computer has ${cores} logical cores and about ${memGB} GB of memory; the defaults below are sized for it. Changes here restart Stockfish.`,
      fields: [
        { key: 'engineBuild', group: 'Engine and hardware', type: 'select', default: 'auto', restart: true, label: 'Which Stockfish to run', help: 'A native .exe is several times faster than the built-in WebAssembly engine. Download one from stockfishchess.org and put it in the app’s engine folder.', options: [['auto', 'Automatic: native .exe if found, otherwise built-in'], ['builtin', 'Built-in, full strength'], ['builtin-lite', 'Built-in, lite (loads faster, uses less memory)'], ['native', 'Native .exe (path below)']] },
        { key: 'enginePath', group: 'Engine and hardware', type: 'text', default: '', restart: true, label: 'Path to stockfish.exe', placeholder: 'C:\\Chess\\stockfish-windows-x86-64-avx2.exe', help: 'Only needed when the .exe is not in the app’s engine folder.' },
        { key: 'analysisThreads', group: 'Engine and hardware', type: 'int', min: 1, max: Math.max(1, cores), default: e.analysisThreads, unit: 'threads', restart: true, label: 'Threads for analysis', help: `CPU threads Stockfish uses in Explore and for the evaluation bar. Leave at least one free so your laptop stays responsive. Default for this computer: ${e.analysisThreads}.` },
        { key: 'analysisHash', group: 'Engine and hardware', type: 'int', min: 16, max: 16384, step: 16, default: e.analysisHash, unit: 'MB', restart: true, label: 'Memory for analysis', help: `Stockfish’s hash table. 128–512 MB is plenty for opening work. The built-in engine is capped at ${WASM_HASH_MAX} MB; a native .exe can use more.` },
        { key: 'taskThreads', group: 'Engine and hardware', type: 'int', min: 1, max: Math.max(1, cores), default: e.taskThreads, unit: 'threads', restart: true, label: 'Threads for background jobs', help: 'A second Stockfish handles mistake verdicts, the mistake finder, audits and sparring, so it never interrupts analysis.' },
        { key: 'taskHash', group: 'Engine and hardware', type: 'int', min: 16, max: 16384, step: 16, default: e.taskHash, unit: 'MB', restart: true, label: 'Memory for background jobs', help: 'Short searches need little memory; 32–128 MB is enough.' },
        { key: 'analysisDepth', group: 'Analysis', type: 'int', min: 8, max: 40, default: 22, unit: 'ply', label: 'Explore: search depth', help: 'How far Stockfish looks in Explore before it stops. Each extra ply takes noticeably longer.' },
        { key: 'analysisLines', group: 'Analysis', type: 'int', min: 1, max: 5, default: 3, unit: 'lines', label: 'Explore: candidate lines shown', help: 'More lines show more alternatives but make each one search slower.' },
        { key: 'finalEvalDepth', group: 'Analysis', type: 'int', min: 8, max: 30, default: 18, unit: 'ply', label: 'End-of-line evaluation depth', help: 'After you finish a line, Stockfish tells you where it leaves you.' },
        { key: 'verdictDepth', group: 'Checking your moves', type: 'int', min: 6, max: 30, default: 14, unit: 'ply', label: 'Mistake verdict depth', help: 'When you play a wrong move, Stockfish compares it with the book move at this depth. Higher is more reliable, but you wait longer for the verdict.' },
        { key: 'auditDepth', group: 'Checking your moves', type: 'int', min: 6, max: 30, default: 14, unit: 'ply', label: 'Repertoire audit depth', help: 'Depth used when checking every move of a repertoire.' },
        { key: 'auditThreshold', group: 'Checking your moves', type: 'int', min: 10, max: 500, step: 5, default: 70, unit: 'centipawns', label: 'Audit flags moves that lose at least', help: '100 centipawns is one pawn. 70 flags moves Stockfish thinks give away about three quarters of a pawn.' },
        { key: 'sparElo', group: 'Sparring', type: 'int', min: 1320, max: 3190, step: 10, default: 1800, unit: 'Elo', label: 'Default sparring strength', help: 'Stockfish can imitate players from 1320 to 3190 Elo. At 3190 it plays at full strength.' },
        { key: 'sparMoveTime', group: 'Sparring', type: 'int', min: 100, max: 10000, step: 100, default: 700, unit: 'ms', label: 'Sparring thinking time per move', help: 'Longer is a little stronger and a little slower.' },
        { key: 'sparFollowBook', group: 'Sparring', type: 'bool', default: true, label: 'Sparring opponent plays your prepared lines first', help: 'While the game is still in your repertoire, the opponent picks one of the replies you prepared for, then improvises once the book runs out.' },
      ],
    },
    {
      id: 'finder',
      title: 'Mistake finder',
      intro: 'The finder walks forward from a position: it follows your repertoire moves, asks Lichess what opponents at your level play, and lets Stockfish judge each popular reply. Replies that give away a lot become puzzles.',
      fields: [
        { key: 'puzzlePositions', search: 'maxPositions', group: 'How big a search', type: 'int', min: 5, max: 200, default: 30, unit: 'positions', label: 'Search budget', help: 'Opponent positions looked up per search. Each costs one Lichess request the first time (later ones come from the cache). 30 takes about a minute on a typical laptop.' },
        { key: 'puzzleDepthMoves', search: 'maxOppDepth', group: 'How big a search', type: 'int', min: 1, max: 12, default: 5, unit: 'opponent moves', label: 'How deep to search', help: 'How many opponent moves ahead the search goes from where you start it.' },
        { key: 'puzzleCandidates', search: 'candidates', group: 'How big a search', type: 'int', min: 2, max: 12, default: 8, unit: 'replies', label: 'Replies checked per position', help: 'The most popular replies Stockfish scores at each opponent turn.' },
        { key: 'puzzleMinShare', search: 'minShare', group: 'Which replies count', type: 'number', min: 0.5, max: 50, step: 0.5, default: 5, unit: '%', label: 'Ignore replies played less often than', help: 'Rare replies are not worth preparing for. 5% means one game in twenty at that position.' },
        { key: 'puzzleMinGames', search: 'minGames', group: 'Which replies count', type: 'int', min: 5, max: 100000, default: 40, unit: 'games', label: 'Ignore positions with fewer games than', help: 'Below this the statistics are too thin to trust.' },
        { key: 'puzzleThreshold', search: 'threshold', group: 'What counts as a mistake', type: 'int', min: 50, max: 1000, step: 10, default: 150, unit: 'centipawns', label: 'A mistake gives away at least', help: '100 centipawns is one pawn. 150 means the reply must throw away a pawn and a half compared with the opponent’s best move.' },
        { key: 'puzzleMinAdvantage', search: 'minAdvantage', group: 'What counts as a mistake', type: 'int', min: 0, max: 1000, step: 10, default: 120, unit: 'centipawns', label: '…and leaves you better by at least', help: 'Keeps puzzles about winning, not about turning a bad position into a slightly less bad one.' },
        { key: 'puzzleEngineDepth', search: 'depth', group: 'What counts as a mistake', type: 'int', min: 8, max: 30, default: 14, unit: 'ply', label: 'Stockfish depth while searching', help: 'Used to score every popular reply. Raising it makes the search slower but more accurate.' },
        { key: 'puzzleSolveDepth', search: 'solveDepth', group: 'Building the puzzle', type: 'int', min: 8, max: 30, default: 16, unit: 'ply', label: 'Stockfish depth for the punishment', help: 'Used to work out and double-check the winning answer once a mistake is found.' },
        { key: 'puzzleUniqueGap', search: 'uniqueGap', group: 'Building the puzzle', type: 'int', min: 30, max: 500, step: 10, default: 120, unit: 'centipawns', label: 'Only-move margin', help: 'A puzzle has a single answer when Stockfish’s best move beats its second choice by at least this much. Otherwise any clearly winning move is accepted.' },
        { key: 'puzzleMaxLength', search: 'maxLength', group: 'Building the puzzle', type: 'int', min: 1, max: 5, default: 3, unit: 'moves', label: 'Longest punishment', help: 'The most moves of yours a puzzle asks for. It stops earlier whenever the next move is not clearly the only good one.' },
        { key: 'puzzleMaxPerSearch', search: 'maxPuzzles', group: 'How big a search', type: 'int', min: 1, max: 50, default: 15, unit: 'puzzles', label: 'Stop after finding', help: 'Ends the search early once this many puzzles are found.' },
        { key: 'puzzleBeyondBook', search: 'beyondBook', group: 'How big a search', type: 'int', min: 0, max: 6, default: 2, unit: 'opponent moves', label: 'Keep going past the end of your lines for', help: 'Opponents keep making mistakes after your preparation ends. 0 stays strictly inside your repertoire.' },
        { key: 'puzzleGapShare', search: 'gapShare', group: 'Which replies count', type: 'number', min: 1, max: 100, step: 1, default: 10, unit: '%', label: 'Report unprepared replies played in at least', help: 'Popular replies your repertoire has no answer for are listed as gaps.' },
        { key: 'puzzleBatch', group: 'Solving puzzles', type: 'int', min: 1, max: 100, default: 12, unit: 'puzzles', label: 'Puzzles per session', help: 'Due puzzles come first, then new ones, most likely to appear in your games first.' },
        { key: 'puzzleAltMin', group: 'Solving puzzles', type: 'int', min: 0, max: 1000, step: 10, default: 150, unit: 'centipawns', label: 'Accept a different move if it still wins by', help: 'When you find another way to punish the mistake, Stockfish checks it. It counts as solved if your move keeps at least this advantage…' },
        { key: 'puzzleAltMargin', group: 'Solving puzzles', type: 'int', min: 0, max: 500, step: 10, default: 80, unit: 'centipawns', label: '…and is within this much of Stockfish’s move', help: 'Set to 0 to only accept Stockfish’s exact answer.' },
      ],
    },
    {
      id: 'opponents',
      title: 'Opponents on Lichess',
      intro: 'Which Lichess games count in the opening explorer and the mistake finder. Pick the time controls and ratings of the people you actually play.',
      fields: [
        { key: 'lichessSpeeds', search: 'speeds', type: 'chips', default: 'blitz,rapid,classical', options: SPEEDS, label: 'Time controls', help: 'Bullet games are full of mistakes nobody makes in slower games, so leave them out unless you play bullet.' },
        { key: 'lichessRatings', search: 'ratings', type: 'chips', default: '1600,1800,2000', options: RATINGS, label: 'Rating bands', help: 'Ratings of the games’ players. A band around your own rating gives the most realistic opponents; the Lichess page suggests one once you connect.' },
        { key: 'lichessSince', search: 'since', type: 'month', default: '', label: 'Only games since', help: 'Leave empty for all games. Opening fashions change; the last two or three years reflect today’s opponents best.' },
        { key: 'explorerSource', type: 'select', default: 'lichess', label: 'Explorer opens on', options: [['lichess', 'Lichess games'], ['masters', 'Master games']] },
        { key: 'cacheDays', search: 'cacheDays', type: 'int', min: 1, max: 365, default: 30, unit: 'days', label: 'Keep explorer answers for', help: 'Answers are saved on this computer so repeat searches are instant and Lichess is asked less often.' },
      ],
    },
    {
      id: 'display',
      title: 'Display and sound',
      intro: 'How the app looks and sounds.',
      fields: [
        { key: 'theme', type: 'select', default: 'light', label: 'Theme', options: [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match my computer']] },
        { key: 'figurines', type: 'bool', default: true, label: 'Figurine notation', help: 'Show ♘f3 instead of Nf3.' },
        { key: 'coordinates', type: 'bool', default: true, label: 'Board coordinates', help: 'Letters and numbers along the board’s edge.' },
        { key: 'showDests', type: 'bool', default: true, label: 'Legal-move dots', help: 'Dots on the squares the selected piece can move to.' },
        { key: 'animation', type: 'int', min: 0, max: 600, step: 20, default: 220, unit: 'ms', label: 'Piece animation', help: '0 turns animation off.' },
        { key: 'sounds', type: 'bool', default: true, label: 'Sounds' },
        { key: 'volume', type: 'int', min: 0, max: 100, step: 5, default: 60, unit: '%', label: 'Volume', showIf: ['sounds', true] },
      ],
    },
  ]);
}

function allFields() {
  return buildSchema().flatMap((s) => s.fields);
}

function defaults() {
  const out = {};
  for (const f of allFields()) out[f.key] = Array.isArray(f.default) ? [...f.default] : f.default;
  return out;
}

/** Coerce one value to its field's type and range. Returns undefined if it can't be used. */
function clean(field, value) {
  switch (field.type) {
    case 'int':
    case 'number': {
      let n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      if (field.type === 'int') n = Math.round(n);
      return Math.max(field.min, Math.min(field.max, n));
    }
    case 'bool':
      return value === true || value === 'true';
    case 'select':
      return field.options.some(([k]) => k === value) ? value : undefined;
    case 'text':
      return typeof value === 'string' ? value.trim().slice(0, 500) : undefined;
    case 'month':
      if (value === '' || value == null) return '';
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value)) ? String(value) : undefined;
    case 'chips': {
      const allowed = field.options.map(([k]) => k);
      const list = (Array.isArray(value) ? value : String(value || '').split(','))
        .map((s) => String(s).trim())
        .filter((s) => allowed.includes(s));
      return list.length ? [...new Set(list)].join(',') : undefined;
    }
    case 'intervals': {
      if (!Array.isArray(value) || value.length !== field.default.length) return undefined;
      const hours = value.map(Number);
      if (hours.some((h) => !Number.isFinite(h) || h <= 0)) return undefined;
      return hours.map((h) => Math.max(0.05, Math.min(24 * 3650, Math.round(h * 100) / 100)));
    }
    default:
      return undefined;
  }
}

/** Merge a patch into current settings, keeping only valid values. */
function validate(current, patch) {
  const next = { ...current };
  for (const f of allFields()) {
    if (!(f.key in (patch || {}))) continue;
    const v = clean(f, patch[f.key]);
    if (v !== undefined) next[f.key] = v;
  }
  return next;
}

const ENGINE_KEYS = allFields().filter((f) => f.restart).map((f) => f.key);

/**
 * The mistake finder's options, from the settings tagged with `search`.
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
function finderOptions(settings) {
  const out = {};
  for (const f of allFields()) {
    if (f.search) out[f.search] = f.unit === '%' ? settings[f.key] / 100 : settings[f.key];
  }
  return out;
}

export { buildSchema, defaults, validate, clean, machine, engineDefaults, finderOptions, ENGINE_KEYS, WASM_HASH_MAX };
