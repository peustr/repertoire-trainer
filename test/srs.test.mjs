// The scheduler's summaries: repertoire statistics, which line to review next, and wait labels.
// The rules for grading answers are in session.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepertoire } from '../public/js/repertoire.js';
import * as srs from '../public/js/srs.js';

const HOUR = 3600e3;
const now = 1_000_000_000_000;
const sched = srs.DEFAULT_SCHEDULE;

// Three White lines, 1.e4 e5 2.Nf3, 1.e4 e5 2.Bc4 and 1.d4 d5 2.c4, so five cards.
const model = buildRepertoire({ pgn: '1. e4 e5 2. Nf3 (2. Bc4) *\n\n1. d4 d5 2. c4 *', color: 'white' });
const key = (san) => [...model.cards.values()].find((c) => c.san === san).key;
const line = (lastSan) => model.lines.find((l) => l.nodes[l.nodes.length - 1].san === lastSan);

test('a card saved without a level or count is promoted from the start', () => {
  const s = srs.promote(sched, { due: 0 }, now);
  assert.equal(s.level, 1);
  assert.equal(s.reps, 1);
  assert.equal(s.due, now + 4 * HOUR);
});

test('a card saved without a level or count steps back to level 1', () => {
  const s = srs.demote(sched, { due: 0 }, now, 'stepback');
  assert.equal(s.level, 1);
  assert.equal(s.reps, 1);
  assert.equal(s.lapses, 1);
});

test('repertoire statistics count lines and cards by state', () => {
  const cards = {
    [key('e4')]: { level: 3, due: now - HOUR },
    [key('Nf3')]: { level: 1, due: now + 2 * HOUR },
    [key('d4')]: { level: 5, due: now + HOUR },
    [key('c4')]: { level: 2, due: now + 3 * HOUR },
  };
  const stats = srs.repertoireStats(model, cards, now);
  assert.equal(stats.lines, 3);
  assert.equal(stats.cards, 5);
  assert.equal(stats.newLines, 1, 'the Bc4 line has a card never seen');
  assert.equal(stats.learnedLines, 2);
  assert.equal(stats.dueLines, 1, 'the Nf3 line starts with the due 1.e4; nothing in the c4 line is due');
  assert.equal(stats.dueCards, 1);
  assert.equal(stats.nextDue, now + HOUR);
  assert.deepEqual(stats.histogram, [1, 1, 1, 1, 0, 1, 0, 0, 0]);
});

test('with nothing scheduled, nothing is due and there is no next due time', () => {
  const stats = srs.repertoireStats(model, {}, now);
  assert.equal(stats.newLines, 3);
  assert.equal(stats.learnedLines, 0);
  assert.equal(stats.dueCards, 0);
  assert.equal(stats.nextDue, Infinity);
  assert.equal(stats.histogram[0], 5);
});

test('the next review is the line that clears the most due cards', () => {
  const cards = {
    [key('e4')]: { level: 2, due: now - HOUR },
    [key('Nf3')]: { level: 2, due: now - HOUR },
    [key('Bc4')]: { level: 2, due: now + HOUR },
    [key('d4')]: { level: 2, due: now + HOUR },
    [key('c4')]: { level: 2, due: now - 5 * HOUR },
  };
  assert.equal(srs.nextReviewLine(model, cards, now), line('Nf3'), 'two due cards beat one, however overdue');
  assert.equal(srs.nextReviewLine(model, cards, now, new Set([line('Nf3').id])), line('c4'),
    'skipped lines are passed over; of the one-card lines, c4 is the most overdue');
});

test('between lines with as many due cards, the most overdue comes first', () => {
  const cards = {
    [key('e4')]: { level: 2, due: now + HOUR },
    [key('Nf3')]: { level: 2, due: now - 2 * HOUR },
    [key('Bc4')]: { level: 2, due: now - 3 * HOUR },
    [key('d4')]: { level: 2, due: now - HOUR },
    [key('c4')]: { level: 2, due: now + HOUR },
  };
  assert.equal(srs.nextReviewLine(model, cards, now), line('Bc4'));
});

test('there is no next review while nothing learned is due', () => {
  assert.equal(srs.nextReviewLine(model, {}, now), null, 'new lines are not reviews');
  const later = Object.fromEntries([...model.cards.keys()].map((k) => [k, { level: 1, due: now + HOUR }]));
  assert.equal(srs.nextReviewLine(model, later, now), null);
});

test('new lines are those with a card never seen', () => {
  assert.deepEqual(srs.newLines(model, { [key('e4')]: { level: 1, due: now } }), model.lines);
  const seen = { [key('e4')]: { level: 1, due: now }, [key('Nf3')]: { level: 1, due: now }, [key('d4')]: { level: 1, due: now } };
  assert.deepEqual(srs.newLines(model, seen), [line('Bc4'), line('c4')]);
});

test('waits read as minutes, hours, days, weeks or months', () => {
  assert.equal(srs.describeWait(Infinity), '—');
  assert.equal(srs.describeWait(NaN), '—');
  assert.equal(srs.describeWait(0), 'now');
  assert.equal(srs.describeWait(-5000), 'now');
  assert.equal(srs.describeWait(25 * 60e3), '25 min');
  assert.equal(srs.describeWait(5 * HOUR), '5 h');
  assert.equal(srs.describeWait(24 * HOUR), '1 day');
  assert.equal(srs.describeWait(3 * 24 * HOUR), '3 days');
  assert.equal(srs.describeWait(21 * 24 * HOUR), '3 weeks');
  assert.equal(srs.describeWait(90 * 24 * HOUR), '3 months');
});
