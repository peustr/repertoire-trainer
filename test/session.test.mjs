// @ts-check
// The training rules (public/js/session.js), case by case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepertoire } from '../public/js/repertoire.js';
import { passPlan, resultForCorrectMove, resultAfterHint, firstResult, judgeWrongMove, gradePass, gradeCard } from '../public/js/session.js';
import { buildSchema } from '../settings-schema.js';

const HOUR = 3600e3;
const NOW = 1_800_000_000_000;
// White plays e4, Nf3 and Bb5: three cards.
const line = buildRepertoire({ color: 'white', pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 *' }).lines[0];
const [k1, k2, k3] = line.cardKeys;
const due = (level) => ({ level, due: NOW - HOUR, reps: level });
const later = (level) => ({ level, due: NOW + 24 * HOUR, reps: level });

test('the line has three cards to work with', () => {
  assert.equal(line.cardKeys.length, 3);
});

test('which moves a pass asks for', () => {
  const cases = [
    { phase: 'guided', cards: {}, quiz: [k1, k2, k3], why: 'Learn shows every new move' },
    { phase: 'recall', cards: { [k1]: later(2) }, quiz: [k2, k3], why: 'only the new moves are recalled' },
    { phase: 'review', cards: { [k1]: due(3), [k2]: later(5), [k3]: due(1) }, quiz: [k1, k3], why: 'review asks for due moves' },
    { phase: 'review', cards: { [k1]: due(3), [k2]: later(5), [k3]: due(1) }, settings: { quizAllMoves: true }, quiz: [k1, k2, k3], why: 'quizAllMoves asks for every move' },
    { phase: 'practice', cards: { [k1]: later(2) }, quiz: [k1, k2, k3], why: 'practice asks for every move' },
  ];
  for (const c of cases) {
    const plan = passPlan(line, c.cards, c.phase, c.settings, NOW);
    assert.deepEqual([...plan.quiz], c.quiz, c.why);
  }
  const plan = passPlan(line, { [k1]: due(3), [k2]: later(5), [k3]: due(1) }, 'review', { quizAllMoves: true }, NOW);
  assert.deepEqual([...plan.dueAtStart], [k1, k3], 'only due moves can level up');
});

test('grading the right move', () => {
  /** @type {Array<[{ tries: number, hints: number }, { hintsCount?: boolean }, string]>} */
  const cases = [
    [{ tries: 0, hints: 0 }, {}, 'right'],
    [{ tries: 1, hints: 0 }, {}, 'wrong'],
    [{ tries: 0, hints: 1 }, { hintsCount: true }, 'wrong'],
    [{ tries: 0, hints: 2 }, { hintsCount: false }, 'hint'],
    [{ tries: 1, hints: 1 }, { hintsCount: false }, 'wrong'],
  ];
  for (const [attempt, settings, expected] of cases) {
    assert.equal(resultForCorrectMove(attempt, settings), expected, JSON.stringify({ attempt, settings }));
  }
});

test('grading a hint', () => {
  /** @type {Array<[string | undefined, string, { hintsCount: boolean }, string | undefined]>} */
  const cases = [
    [undefined, 'review', { hintsCount: true }, 'wrong'],
    [undefined, 'review', { hintsCount: false }, 'hint'],
    ['auto', 'practice', { hintsCount: false }, 'hint'],
    ['wrong', 'review', { hintsCount: false }, 'wrong'],
    [undefined, 'guided', { hintsCount: true }, undefined],
  ];
  for (const [previous, phase, settings, expected] of cases) {
    assert.equal(resultAfterHint(previous, phase, settings), expected, JSON.stringify({ previous, phase, settings }));
  }
});

test("a move's first result in a pass is the one that counts", () => {
  assert.equal(firstResult(undefined, 'right'), 'right');
  assert.equal(firstResult('auto', 'right'), 'right');
  assert.equal(firstResult('wrong', 'right'), 'wrong', 'right after a mistake is still a mistake');
  assert.equal(firstResult('hint', 'right'), 'hint');
});

test('playing a different move', () => {
  /** @type {Array<[{ inRepertoire: boolean, phase: string }, { altPolicy?: string }, string]>} */
  const cases = [
    [{ inRepertoire: true, phase: 'review' }, { altPolicy: 'retry' }, 'alternative'],
    [{ inRepertoire: true, phase: 'review' }, { altPolicy: 'mistake' }, 'mistake'],
    [{ inRepertoire: true, phase: 'guided' }, { altPolicy: 'mistake' }, 'alternative'],
    [{ inRepertoire: false, phase: 'guided' }, {}, 'follow-arrow'],
    [{ inRepertoire: false, phase: 'recall' }, {}, 'mistake'],
    [{ inRepertoire: false, phase: 'practice' }, {}, 'mistake'],
  ];
  for (const [move, settings, expected] of cases) {
    assert.equal(judgeWrongMove(move, settings), expected, JSON.stringify({ move, settings }));
  }
});

test('recall: new moves start the schedule, a miss is due again at once', () => {
  const g = gradePass({
    line, phase: 'recall', quiz: new Set([k2, k3]), dueAtStart: new Set(), cards: { [k1]: later(2) }, now: NOW,
    results: new Map([[k1, 'auto'], [k2, 'right'], [k3, 'wrong']]),
  });
  assert.deepEqual(Object.keys(g.updates), [k2, k3], 'the known move is untouched');
  assert.deepEqual([g.updates[k2].level, g.updates[k2].due], [1, NOW + 4 * HOUR]);
  assert.deepEqual([g.updates[k3].level, g.updates[k3].due], [1, NOW]);
  assert.deepEqual([g.right, g.wrong], [1, 1]);
  assert.deepEqual(g.outcomes.map((o) => o.change), ['learned', 'learned']);
});

test('guided without the replay: everything not missed is learned', () => {
  const g = gradePass({
    line, phase: 'guided', quiz: new Set([k1, k2, k3]), dueAtStart: new Set(), cards: {}, now: NOW,
    results: new Map([[k1, 'right'], [k2, 'hint'], [k3, 'wrong']]),
  });
  assert.deepEqual([...g.results.values()], ['right', 'right', 'wrong']);
  assert.deepEqual(Object.values(g.updates).map((s) => s.due), [NOW + 4 * HOUR, NOW + 4 * HOUR, NOW]);
});

test('review: due moves level up, misses drop, the rest stay put', () => {
  const cards = { [k1]: due(3), [k2]: later(5), [k3]: due(4) };
  const pass = { line, phase: 'review', quiz: new Set([k1, k2, k3]), dueAtStart: new Set([k1, k3]), cards, now: NOW };

  const reset = gradePass({ ...pass, results: new Map([[k1, 'right'], [k2, 'right'], [k3, 'wrong']]) }, { mistakePolicy: 'reset' });
  assert.deepEqual(reset.outcomes.map((o) => [o.change, o.next && o.next.level]), [['promoted', 4], ['not-due', null], ['demoted', 1]]);
  assert.deepEqual(Object.keys(reset.updates), [k1, k3], 'a right answer to a move that was not due changes nothing');

  const stepback = gradePass({ ...pass, results: new Map([[k3, 'wrong']]) }, { mistakePolicy: 'stepback' });
  assert.equal(stepback.updates[k3].level, 2, 'two levels down');

  const hinted = gradePass({ ...pass, results: new Map([[k1, 'hint']]) });
  assert.deepEqual(hinted.updates, {});
  assert.equal(hinted.outcomes[0].change, 'hint');
});

test('review: a miss demotes even a move that was not due (quizAllMoves)', () => {
  // Deliberate: forgetting a move is worth knowing about, due or not. The setting's
  // help text says so too; keep the two in step.
  const help = buildSchema().flatMap((s) => s.fields).find((f) => f.key === 'quizAllMoves').help;
  assert.match(help, /a mistake sends any move back down, due or not/);
  const g = gradePass({
    line, phase: 'review', quiz: new Set([k1, k2, k3]), dueAtStart: new Set([k1]), now: NOW,
    cards: { [k1]: due(3), [k2]: later(5), [k3]: later(4) }, results: new Map([[k2, 'wrong']]),
  });
  assert.equal(g.updates[k2].level, 1);
});

test('practice: results are reported, the schedule is untouched', () => {
  const g = gradePass({
    line, phase: 'practice', quiz: new Set([k1, k2, k3]), dueAtStart: new Set([k1]), now: NOW,
    cards: { [k1]: due(3), [k2]: later(5), [k3]: later(4) }, results: new Map([[k1, 'right'], [k2, 'wrong'], [k3, 'hint']]),
  });
  assert.deepEqual(g.updates, {});
  assert.deepEqual(g.outcomes.map((o) => [o.result, o.change]), [['right', 'practice'], ['wrong', 'practice'], ['hint', 'practice']]);
  assert.deepEqual([g.right, g.wrong], [1, 1]);
});

test('a single card (puzzles, warm-up)', () => {
  const notDue = later(3);
  /** @type {Array<[object | undefined, boolean, (s: any) => boolean, string]>} */
  const cases = [
    [undefined, true, (s) => s.level === 1 && s.due === NOW + 4 * HOUR, 'a new card solved starts at level 1'],
    [undefined, false, (s) => s.level === 1 && s.due === NOW, 'a new card missed is due again at once'],
    [due(3), true, (s) => s.level === 4, 'a due card solved levels up'],
    [notDue, true, (s) => s === notDue, 'a card that is not due stays as it is'],
    [later(5), false, (s) => s.level === 1, 'a miss demotes, due or not'],
  ];
  for (const [prev, success, check, why] of cases) assert.ok(check(gradeCard(prev, success, {}, NOW)), why);
  assert.equal(gradeCard(later(5), false, { mistakePolicy: 'stepback' }, NOW).level, 3);
});
