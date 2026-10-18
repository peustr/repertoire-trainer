// Chess and Lichess constants shared by the browser and the server. It imports
// nothing, so it loads anywhere.

/** The standard starting position. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Normalise a FEN to the parts that define a position (drop the move counters).
 * Card keys and stored progress are built on this: changing it resets everyone's progress.
 * @param {string} fen
 */
export function positionKey(fen) {
  return fen.split(/\s+/).slice(0, 4).join(' ');
}

/**
 * Centipawns from White's view, with mates mapped to large numbers (mate in 1 is 9990).
 * A missing score counts as 0.
 * @param {{ cp?: number, mate?: number } | null | undefined} score
 */
export function scoreToCp(score) {
  if (!score) return 0;
  if ('mate' in score) return score.mate === 0 ? 0 : Math.sign(score.mate) * (10000 - Math.abs(score.mate) * 10);
  return score.cp;
}

/** The Lichess explorer's time controls, fastest first. */
export const SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

/** @type {Record<string, string>} */
export const SPEED_NAMES = {
  ultraBullet: 'UltraBullet', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', correspondence: 'Correspondence',
};

/** The Lichess explorer's rating groups: each runs up to the next one (0 is everything under 1000). */
export const RATING_GROUPS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

/**
 * A rating group's range, e.g. "1600–1799", "Under 1000" or "2500+".
 * @param {number} group
 */
export function ratingGroupLabel(group) {
  const next = RATING_GROUPS[RATING_GROUPS.indexOf(group) + 1];
  if (group === 0) return `Under ${next}`;
  return next ? `${group}–${next - 1}` : `${group}+`;
}
