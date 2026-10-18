// @ts-check
// Spaced repetition, MoveTrainer-style: eight levels with growing waits.
// A correct answer on a due card moves it up one level; a mistake sends it
// back down (to level 1 by default).

const HOUR = 3600 * 1000;
// Waits after reaching levels 1–8, in milliseconds. Settings → Memory schedule can change them.
export let INTERVALS = [4, 24, 72, 168, 336, 720, 2160, 4320].map((h) => h * HOUR);
export const MAX_LEVEL = 8;
let stepbackLevels = 2;

export function setIntervals(hours) {
  if (Array.isArray(hours) && hours.length === MAX_LEVEL && hours.every((h) => h > 0)) INTERVALS = hours.map((h) => h * HOUR);
}

export function setStepback(levels) {
  stepbackLevels = Math.max(1, Math.min(MAX_LEVEL - 1, Math.round(levels) || 2));
}

export function intervalFor(level) {
  return INTERVALS[Math.max(1, Math.min(MAX_LEVEL, level)) - 1];
}

export function isDue(state, now = Date.now()) {
  return !!state && state.due <= now;
}

/** First successful recall of a new card. */
export function learned(now = Date.now(), correct = true) {
  return { level: 1, due: correct ? now + intervalFor(1) : now, reps: 1, lapses: correct ? 0 : 1, last: now };
}

export function promote(state, now = Date.now()) {
  const level = Math.min(MAX_LEVEL, (state.level || 0) + 1);
  return { ...state, level, due: now + intervalFor(level), reps: (state.reps || 0) + 1, last: now };
}

export function demote(state, now = Date.now(), policy = 'reset') {
  const level = policy === 'stepback' ? Math.max(1, (state.level || 1) - stepbackLevels) : 1;
  return { ...state, level, due: now + intervalFor(level), reps: (state.reps || 0) + 1, lapses: (state.lapses || 0) + 1, last: now };
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
