// Library: a one-move warm-up card, then every repertoire with its memory state.

import { h, clear, levelBar, plural, toast, sound, fig, sanLabel, action } from '../ui.js';
import { state, loadReps, modelFor, saveCards } from '../store.js';
import { repertoireStats, describeWait, isDue } from '../srs.js';
import { gradeCard } from '../session.js';
import { createBoard, isPromotion, choosePromotion, applyUci } from '../board.js';
import { api } from '../api.js';
import { START_FEN, positionKey } from '../constants.js';
import { puzzleStats } from '../puzzle-utils.js';

export async function renderLibrary(root) {
  const reps = await loadReps();
  const now = Date.now();
  const page = h('div.page.library');
  root.append(page);

  if (!reps.length) {
    const { el, destroy } = await emptyLibrary();
    page.append(el);
    return destroy;
  }

  const entries = reps.map((rep) => {
    const model = modelFor(rep);
    return { rep, model, stats: repertoireStats(model, rep.cards || {}, now) };
  });

  const totalDue = entries.reduce((a, e) => a + e.stats.dueLines, 0);
  const totalNew = entries.reduce((a, e) => a + e.stats.newLines, 0);

  const quick = h('section.quick');
  const list = h('section.replist', { 'aria-label': 'Your repertoires' });
  page.append(
    h('div.library-top',
      h('div.library-intro',
        h('h1.page-title', totalDue ? `${plural(totalDue, 'line')} to review` : totalNew ? 'Nothing due. Time to learn something new.' : 'All caught up'),
        h('p.lede', totalDue
          ? 'Reviews are scheduled just before you are likely to forget. Clear them first, then learn new lines.'
          : nextDueText(entries))),
      quick),
    list);

  for (const e of entries) list.append(repRow(e));
  const destroyQuick = renderQuickCard(quick, entries);
  return destroyQuick;
}

function nextDueText(entries) {
  const next = Math.min(...entries.map((e) => e.stats.nextDue));
  if (!isFinite(next)) return 'Learn a few lines to start your review schedule.';
  return `Your next review opens in ${describeWait(next - Date.now())}.`;
}

function repRow({ rep, stats }) {
  const side = rep.color === 'black' ? 'Black' : 'White';
  return h('article.reprow',
    h('div.reprow-main',
      h('span.side-chip', { class: rep.color, title: `You play ${side}`, 'aria-label': `You play ${side}` }),
      h('div.reprow-text',
        h('a.reprow-name', { href: `#/rep/${rep.id}` }, rep.name),
        h('div.reprow-meta', `${plural(stats.lines, 'line')}, ${plural(stats.cards, 'move')} to remember`)),
      h('div.reprow-bar', levelBar(stats.histogram), h('div.reprow-legend', `${stats.cards - stats.histogram[0]} of ${stats.cards} moves learned`))),
    h('div.reprow-actions',
      stats.dueLines
        ? h('a.btn.primary', { href: `#/train/${rep.id}/review` }, `Review ${stats.dueLines}`)
        : h('span.btn.ghost.disabled', { title: 'Nothing due yet' }, isFinite(stats.nextDue) ? `Next in ${describeWait(stats.nextDue - Date.now())}` : 'Nothing due'),
      stats.newLines ? h('a.btn', { href: `#/train/${rep.id}/learn`, title: `${plural(stats.newLines, 'line')} not learned yet` }, `Learn ${Math.min(stats.newLines, state.settings.learnBatch)} new`) : null,
      (() => { const pz = puzzleStats(rep); return pz.ready ? h('a.btn', { href: `#/puzzles/${rep.id}`, title: `${pz.due} due, ${pz.fresh} new` }, `Puzzles ${pz.ready}`) : null; })(),
      h('a.btn.ghost', { href: `#/explore/${rep.id}` }, 'Explore')));
}

async function emptyLibrary() {
  let samples = [];
  try { samples = await api.samples(); } catch (err) { /* offline */ }
  const add = async (s) => {
    const rep = await api.create({ name: s.name, color: s.color, pgn: s.pgn });
    toast(`Added ${rep.name}`);
    location.hash = `#/rep/${rep.id}`;
  };
  const boardHost = h('div.welcome-board');
  const el = h('div.empty.welcome',
    h('div',
      h('h1.page-title', 'Your openings, learned for good'),
      h('p.lede', 'Paste a PGN of the lines you want to play. The trainer turns every move you need to remember into a quiz and brings it back just before you would forget it. Stockfish checks your moves along the way.'),
      h('div.welcome-actions',
        h('a.btn.primary', { href: '#/import' }, 'Add your first repertoire'),
        samples.map((s) => h('button.btn', { type: 'button', on: { click: action(() => add(s)) } }, `Try ${s.name}`)))),
    h('div', boardHost, h('p.welcome-caption', 'After 3.Bc4 the bishop already eyes f7. Lines like this become quizzes.')));
  // Board must be in the DOM before chessground measures it.
  let board = null;
  requestAnimationFrame(() => {
    board = createBoard(boardHost, { orientation: 'white' });
    board.setPosition('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3', { lastMove: 'f1c4' });
    board.setShapes([{ orig: 'c4', dest: 'f7', brush: 'flame' }, { orig: 'f7', brush: 'red' }]);
  });
  return { el, destroy: () => board && board.destroy() };
}

// --- quick card ---------------------------------------------------------------------
// One position from your repertoires, right on the front page. Due cards first.

function pickCard(entries, exclude) {
  const now = Date.now();
  let best = null;
  const learnedPool = [];
  for (const { rep, model } of entries) {
    const cards = rep.cards || {};
    for (const card of model.cards.values()) {
      if (exclude.has(card.key)) continue;
      const s = cards[card.key];
      if (!s) continue;
      if (isDue(s, now) && (!best || s.due < best.state.due)) best = { rep, model, card, state: s };
      learnedPool.push({ rep, model, card, state: s });
    }
  }
  if (best) return { ...best, due: true };
  if (!learnedPool.length) return null;
  return { ...learnedPool[Math.floor(Math.random() * learnedPool.length)], due: false };
}

function renderQuickCard(container, entries) {
  const shown = new Set();
  const boardHost = h('div.quick-board');
  const caption = h('div.quick-caption');
  const feedback = h('div.quick-feedback', { 'aria-live': 'polite' });
  const nextBtn = h('button.btn.ghost.small', { type: 'button' }, 'Another position');
  container.append(boardHost, h('div.quick-side', caption, feedback, nextBtn));

  const board = createBoard(boardHost, { orientation: 'white', onMove: action(onMove) });
  let current = null;
  let answered = false;

  function show() {
    current = pickCard(entries, shown);
    answered = false;
    clear(feedback);
    if (!current) {
      board.setPosition(START_FEN);
      clear(caption,
        h('h2.quick-title', 'Warm-up'),
        h('p', 'Once you have learned some lines, a position from your repertoire waits here for a one-move quiz.'));
      nextBtn.hidden = true;
      return;
    }
    shown.add(current.card.key);
    const { rep, card } = current;
    const node = card.node;
    board.setOrientation(rep.color);
    board.setShapes([]);
    board.setPosition(card.fenBefore, { lastMove: node.parent && node.parent.uci ? node.parent.uci : undefined, movable: true });
    const prev = node.parent && node.parent.san ? sanLabel(node.parent.parent.fen, node.parent.uci) : null;
    clear(caption,
      h('h2.quick-title', current.due ? 'Due now' : 'Warm-up'),
      h('p.quick-rep', rep.name),
      h('p.quick-prompt', prev ? `After ${prev}, what do you play?` : 'What is your first move?'));
    nextBtn.hidden = false;
  }

  async function onMove(from, to) {
    if (!current || answered) return;
    const { rep, model, card } = current;
    let uci = from + to;
    if (isPromotion(card.fenBefore, from, to)) uci += card.uci.startsWith(uci) ? card.uci[4] : await choosePromotion(rep.color);
    const played = applyUci(card.fenBefore, uci);
    const alsoMine = (model.myMovesAt.get(positionKey(card.fenBefore)) || new Set()).has(uci);
    answered = true;
    const now = Date.now();
    if (uci === card.uci || alsoMine) {
      board.setPosition(played.fen, { lastMove: uci, playSound: true, captured: played.captured });
      sound.right();
      let note = 'Right.';
      if (uci !== card.uci) note = 'Right — that is one of your repertoire moves here.';
      if (current.due && uci === card.uci) {
        const next = gradeCard(current.state, true, state.settings, now);
        await saveCards(rep.id, { [card.key]: next }, { correct: 1 });
        note += ` Next review in ${describeWait(next.due - now)}.`;
      }
      clear(feedback, h('p.good', note), card.node.comment ? h('p.comment', card.node.comment) : null);
    } else {
      board.setPosition(card.fenBefore, { lastMove: card.node.parent.uci || undefined });
      board.setShapes([{ orig: card.uci.slice(0, 2), dest: card.uci.slice(2, 4), brush: 'flame' }]);
      sound.wrong();
      let note = `Your repertoire move is ${fig(card.san)}.`;
      if (current.due) {
        const next = gradeCard(current.state, false, state.settings, now);
        await saveCards(rep.id, { [card.key]: next }, { wrong: 1 });
        note += ' It will come back in your next review.';
      }
      clear(feedback, h('p.bad', note));
    }
  }

  nextBtn.addEventListener('click', show);
  show();
  return () => board.destroy();
}
