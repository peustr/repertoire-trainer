// Spaced repetition, MoveTrainer-style: eight levels with growing waits.
// A correct answer on a due card moves it up one level; a mistake sends it
// back down (to level 1 by default).

const HOUR = 3600 * 1000;
export const MAX_LEVEL = 8;

/**
 * The memory schedule: the wait in hours after reaching each level (1–8), and how many
 * levels a mistake costs under the 'stepback' policy. It comes from the user's settings
 * (srsIntervals, stepbackLevels) and is passed to every call that schedules a card.
 * A missing or unusable part falls back to the default.
 * @typedef {{ intervals?: readonly number[], stepbackLevels?: number }} Schedule
 */

/** The defaults, which settings-schema.js offers too. */
export const DEFAULT_SCHEDULE = Object.freeze({ intervals: Object.freeze([4, 24, 72, 168, 336, 720, 2160, 4320]), stepbackLevels: 2 });

/**
 * Milliseconds a card waits after reaching `level`.
 * @param {Schedule} schedule
 * @param {number} level
 */
export function intervalFor(schedule, level) {
  const hours = schedule.intervals;
  const usable = Array.isArray(hours) && hours.length === MAX_LEVEL && hours.every((h) => h > 0);
  return (usable ? hours : DEFAULT_SCHEDULE.intervals)[Math.max(1, Math.min(MAX_LEVEL, level)) - 1] * HOUR;
}

/** @param {Schedule} schedule */
function stepbackLevels(schedule) {
  return Math.max(1, Math.min(MAX_LEVEL - 1, Math.round(schedule.stepbackLevels) || DEFAULT_SCHEDULE.stepbackLevels));
}

export function isDue(state, now = Date.now()) {
  return !!state && state.due <= now;
}

/**
 * First recall of a new card: level 1, or due again at once if it was missed.
 * @param {Schedule} schedule
 */
export function learned(schedule, now = Date.now(), correct = true) {
  return { level: 1, due: correct ? now + intervalFor(schedule, 1) : now, reps: 1, lapses: correct ? 0 : 1, last: now };
}

/** @param {Schedule} schedule */
export function promote(schedule, state, now = Date.now()) {
  const level = Math.min(MAX_LEVEL, (state.level || 0) + 1);
  return { ...state, level, due: now + intervalFor(schedule, level), reps: (state.reps || 0) + 1, last: now };
}

/**
 * @param {Schedule} schedule
 * @param {'reset' | 'stepback'} [policy] back to level 1, or down by the schedule's step-back
 */
export function demote(schedule, state, now = Date.now(), policy = 'reset') {
  const level = policy === 'stepback' ? Math.max(1, (state.level || 1) - stepbackLevels(schedule)) : 1;
  return { ...state, level, due: now + intervalFor(schedule, level), reps: (state.reps || 0) + 1, lapses: (state.lapses || 0) + 1, last: now };
}

export function lineStatus(line, cards, now = Date.now()) {
  const newKeys = [];
  const dueKeys = [];
  let minLevel = MAX_LEVEL;
  let nextDue = Infinity;
  for (const k of line.cardKeys) {
    const s = cards[k];
    if (!s) { newKeys.push(k); minLevel = 0; continue; }
    if (s.due <= now) dueKeys.push(k);
    minLevel = Math.min(minLevel, s.level);
    nextDue = Math.min(nextDue, s.due);
  }
  return { isNew: newKeys.length > 0, newKeys, dueKeys, minLevel, nextDue, isDue: !newKeys.length && dueKeys.length > 0 };
}

export function repertoireStats(model, cards, now = Date.now()) {
  const histogram = new Array(MAX_LEVEL + 1).fill(0);
  let dueCards = 0;
  let nextDue = Infinity;
  for (const key of model.cards.keys()) {
    const s = cards[key];
    histogram[s ? s.level : 0]++;
    if (s && s.due <= now) dueCards++;
    if (s && s.due > now) nextDue = Math.min(nextDue, s.due);
  }
  let newLines = 0;
  let dueLines = 0;
  for (const line of model.lines) {
    const st = lineStatus(line, cards, now);
    if (st.isNew) newLines++;
    else if (st.isDue) dueLines++;
  }
  return {
    lines: model.lines.length,
    cards: model.cards.size,
    newLines,
    dueLines,
    learnedLines: model.lines.length - newLines,
    dueCards,
    histogram,
    nextDue,
  };
}

/** The learned line that clears the most due cards (ties: the most overdue). */
export function nextReviewLine(model, cards, now = Date.now(), skip = new Set()) {
  let best = null;
  let bestScore = null;
  for (const line of model.lines) {
    if (skip.has(line.id)) continue;
    const st = lineStatus(line, cards, now);
    if (!st.isDue) continue;
    const oldest = Math.min(...st.dueKeys.map((k) => cards[k].due));
    const score = [st.dueKeys.length, -oldest];
    if (!best || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = line;
      bestScore = score;
    }
  }
  return best;
}

export function newLines(model, cards) {
  return model.lines.filter((l) => lineStatus(l, cards).isNew);
}

export function describeWait(ms) {
  if (!isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(ms / HOUR);
  if (h < 20) return `${h} h`;
  const d = Math.round(ms / (24 * HOUR));
  if (d < 14) return d === 1 ? '1 day' : `${d} days`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  return `${Math.round(d / 30)} months`;
}
