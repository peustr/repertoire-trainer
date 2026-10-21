// The move trainer: Learn, Review and Practise.
//
// Learn:    the line plays out with arrows and the author's notes for each new
//           move, then you play it again from memory.
// Review:   only moves that are due are quizzed (unless you ask for every move);
//           moves you already know play themselves.
// Practise: every move, no effect on the schedule.

import { h, clear, sound, fig, sanLabel, uciLineToSan, formatSanLine, plural, action, keyed, panelSection, toolList } from '../ui.js';
import { refresh } from '../nav.js';
import { state, getRep, modelFor, saveCards } from '../store.js';
import { cardKey } from '../repertoire.js';
import { nagGlyphs, moveNumber } from '../pgn.js';
import { START_FEN, positionKey, scoreToCp } from '../constants.js';
import { lineStatus, nextReviewLine, newLines, describeWait } from '../srs.js';
import { passPlan, resultForCorrectMove, resultAfterHint, firstResult, judgeWrongMove, gradePass } from '../session.js';
import { createBoard, createEvalBar, isPromotion, choosePromotion, applyUci } from '../board.js';
import { evaluate, analyse, formatScore, evalBarShare } from '../engine-client.js';
import { openMistakeFinder } from './finder.js';
import { playOutTool, sparTool, finderTool as findTool, exploreTool } from './tools.js';

const MODE_NAMES = { learn: 'Learn', review: 'Review', practice: 'Practise' };

export async function renderTrainer(root, { id, mode, target, chapter }) {
  const rep = await getRep(id, { fresh: true });
  const model = modelFor(rep);
  const settings = state.settings;
  const side = model.side;
  const cards = () => rep.cards || (rep.cards = {});

  // ---- session queue ----------------------------------------------------------
  const done = new Set();
  let queue = [];
  if (target) {
    const line = model.lines.find((l) => l.id === target);
    if (line) queue = [line];
  } else if (mode === 'learn') {
    queue = newLines(model, cards()).filter((l) => chapter == null || l.chapter.index === +chapter).slice(0, settings.learnBatch);
  } else if (mode === 'practice') {
    queue = model.lines.filter((l) => (chapter == null ? !lineStatus(l, cards()).isNew : l.chapter.index === +chapter));
    if (settings.practiceOrder !== 'ordered') queue = shuffle(queue);
  }
  const sessionSize = mode === 'review' && !target ? settings.reviewBatch : queue.length;
  const tally = { lines: 0, right: 0, wrong: 0 };
  // The line that follows the one just finished, chosen once: retrying a line must not pass
  // it over (nextLine() takes Learn and Practise lines off the queue).
  let upcoming;

  function nextLine() {
    if (mode === 'review' && !target) {
      if (done.size >= settings.reviewBatch) return null;
      return nextReviewLine(model, cards(), Date.now(), done);
    }
    while (queue.length) {
      const l = queue.shift();
      if (mode === 'learn' && !target && !lineStatus(l, cards()).isNew) continue;
      return l;
    }
    return null;
  }

  /** The line to go on with: the one already chosen after the last line, or else the next. */
  function takeNext() {
    const next = upcoming === undefined ? nextLine() : upcoming;
    upcoming = undefined;
    return next;
  }

  // ---- layout -------------------------------------------------------------------
  const page = h('div.page.trainer', { 'data-mode': mode });
  const boardCol = h('div.board-col');
  const evalHost = h('div.eval-host');
  const boardHost = h('div.board-host');
  boardCol.append(h('div.board-row', evalHost, boardHost));

  const crumbs = h('div.trainer-crumbs');
  const lineHead = h('div.line-head');
  const dots = h('ol.move-dots', { 'aria-label': 'Your moves in this line' });
  const prompt = h('div.prompt', { 'aria-live': 'polite' });
  const notes = h('div.notes');
  const feedback = h('div.feedback', { 'aria-live': 'polite' });
  const controls = h('div.controls');
  const sheet = h('ol.scoresheet', { 'aria-label': 'Moves played' });
  const toolsSection = panelSection('From this position', null, toolList([]));
  const panel = h('aside.panel',
    crumbs,
    lineHead,
    dots,
    h('div.task', prompt, feedback, controls),
    notes,
    panelSection('Moves', null, h('div.sheet-wrap', sheet)),
    toolsSection);
  page.append(boardCol, panel);
  root.append(page);

  const board = createBoard(boardHost, { orientation: rep.color, onMove: onUserMove });
  const evalBar = createEvalBar(evalHost);
  evalBar.hide(true);

  // ---- run state ------------------------------------------------------------------
  let run = null;
  let timers = [];
  let engineRun = null;
  let alive = true;
  const later = (fn, ms) => { const t = setTimeout(() => { timers = timers.filter((x) => x !== t); if (alive) fn(); }, ms); timers.push(t); };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  /** retry: "Retry line", extra practice that counts neither in the session nor in the day's tally. */
  function startLine(line, phase, { retry = false } = {}) {
    clearTimers();
    if (engineRun) { engineRun.stop(); engineRun = null; }
    evalBar.hide(true);
    const { quiz, dueAtStart } = passPlan(line, cards(), phase, settings);
    run = {
      line,
      phase,
      retry,
      ply: 0,
      fen: line.startFen,
      lastUci: null,
      quiz,
      dueAtStart,
      results: new Map(),
      hint: 0,
      waiting: false,
      played: [],
    };
    board.setShapes([]);
    board.setPosition(line.startFen, { movable: false });
    renderHead();
    renderDots();
    renderSheet();
    clear(feedback);
    clear(controls, hintButton(), skipButton());
    setTools([finderTool()]);
    showNotes(line.startComment ? [line.startComment] : []);
    if (phase === 'guided') setPrompt('Learn the line', 'Play each new move the arrow shows.');
    else if (phase === 'recall') setPrompt('Play it from memory', 'The same line, without arrows.');
    later(step, 350);
  }

  function step() {
    const { line } = run;
    if (run.ply >= line.nodes.length) { finishPhase(); return; }
    const node = line.nodes[run.ply];
    const mine = node.color === side;
    const key = mine ? cardKey(node.parent.fen, node.uci) : null;
    if (!mine || !run.quiz.has(key)) {
      const delay = mine ? settings.knownDelay : run.ply === 0 ? Math.min(250, settings.moveDelay) : settings.moveDelay;
      if (mine) run.results.set(key, run.results.get(key) || 'auto');
      setPrompt(mine ? 'Known move' : `${side === 'w' ? 'Black' : 'White'} to move`, '');
      later(() => { playNode(node); run.ply++; renderDots(); step(); }, delay);
      return;
    }
    // Your turn.
    run.waiting = true;
    run.hint = 0;
    run.tries = 0;
    board.setPosition(run.fen, { lastMove: run.lastUci, movable: true });
    const shapes = [];
    if (run.phase === 'guided') shapes.push({ orig: node.uci.slice(0, 2), dest: node.uci.slice(2, 4), brush: 'flame' });
    board.setShapes([...shapes, ...(run.ply > 0 && settings.pgnArrows ? line.nodes[run.ply - 1].shapes : [])]);
    renderDots();
    if (run.phase === 'guided') {
      setPrompt(`Play ${moveText(node)}`, '');
      const intro = run.played.length <= 1 ? line.startComment : null;
      showNotes([intro, node.preComment, node.comment].filter(Boolean), node);
    } else {
      setPrompt('Your move', run.ply === 0 ? 'Find your first move.' : `After ${moveText(line.nodes[run.ply - 1])}`);
    }
  }

  function playNode(node) {
    const res = applyUci(run.fen, node.uci);
    run.fen = node.fen;
    run.lastUci = node.uci;
    run.played.push(node);
    board.setPosition(node.fen, { lastMove: node.uci, playSound: true, captured: res ? res.captured : false });
    board.setShapes(settings.pgnArrows ? node.shapes : []);
    if (node.comment && run.phase !== 'guided' && settings.showComments) showNotes([node.comment], node);
    else if (node.color !== side && node.comment) showNotes([node.comment], node);
    renderSheet();
  }

  async function onUserMove(from, to) {
    if (!run || !run.waiting) { board.setPosition(run ? run.fen : board.fen(), { lastMove: run && run.lastUci }); return; }
    const node = run.line.nodes[run.ply];
    const key = cardKey(node.parent.fen, node.uci);
    let uci = from + to;
    if (isPromotion(run.fen, from, to)) uci += node.uci.startsWith(uci) && node.uci.length === 5 ? node.uci[4] : await choosePromotion(rep.color);

    if (uci === node.uci) {
      run.waiting = false;
      const outcome = resultForCorrectMove({ tries: run.tries, hints: run.hint }, settings);
      const clean = outcome === 'right';
      run.results.set(key, firstResult(run.results.get(key), outcome));
      if (clean && run.phase !== 'guided') sound.right();
      playNode(node);
      const nags = nagGlyphs(node.nags);
      if (run.phase !== 'guided') {
        setFeedback(clean ? 'good' : 'neutral', clean ? `${moveText(node)}${nags} is correct.` : `${moveText(node)} is correct, after a retry or a hint.`);
      }
      run.ply++;
      renderDots();
      later(step, run.phase === 'guided' ? 500 : 250);
      return;
    }

    const inRepertoire = (model.myMovesAt.get(positionKey(run.fen)) || new Set()).has(uci);
    const played = applyUci(run.fen, uci);
    const meaning = judgeWrongMove({ inRepertoire, phase: run.phase }, settings);
    if (meaning === 'alternative') {
      board.setPosition(run.fen, { lastMove: run.lastUci, movable: true });
      setFeedback('neutral', `${sanLabel(run.fen, uci)} is in your repertoire, but this line continues differently. Try again.`);
      return;
    }
    if (meaning === 'follow-arrow') {
      board.setPosition(run.fen, { lastMove: run.lastUci, movable: true });
      board.shake();
      setFeedback('neutral', `Follow the arrow: ${moveText(node)}.`);
      return;
    }

    // A real mistake.
    run.tries++;
    run.results.set(key, 'wrong');
    sound.wrong();
    run.waiting = false;
    board.setPosition(played ? played.fen : run.fen, { lastMove: uci });
    board.flash(to, 'wrong');
    const fenBefore = run.fen;
    later(() => {
      board.setPosition(fenBefore, { lastMove: run.lastUci, movable: true });
      board.setShapes([{ orig: node.uci.slice(0, 2), dest: node.uci.slice(2, 4), brush: 'flame' }]);
      run.waiting = true;
      renderDots(); // mark the move as the current one again
    }, 700);
    renderDots();
    const verdict = h('p.verdict.muted', 'Asking Stockfish about your move…');
    setFeedback('bad', `Not ${sanLabel(fenBefore, uci)}. The book move is ${moveText(node)} — play it to continue.`, verdict);
    void explainMistake(verdict, fenBefore, node.uci, uci); // shows its own errors
  }

  async function explainMistake(el, fen, book, played) {
    try {
      const res = await evaluate(fen, [book, played], settings.verdictDepth);
      if (!el.isConnected) return;
      const pov = side === 'w' ? 1 : -1;
      const bookM = res.moves.find((m) => m.move === book);
      const playM = res.moves.find((m) => m.move === played);
      if (!bookM || !playM || !bookM.score || !playM.score) { el.textContent = ''; return; }
      const loss = (scoreToCp(bookM.score) - scoreToCp(playM.score)) * pov;
      const bestGain = res.best && res.best.score ? (scoreToCp(res.best.score) - scoreToCp(bookM.score)) * pov : 0;
      let judgement;
      if (loss <= 30) judgement = 'Stockfish rates your move about as highly as the book move — it is playable, just not your repertoire.';
      else if (loss <= 100) judgement = 'Stockfish thinks your move is slightly worse than the book move.';
      else if (loss <= 250) judgement = 'Stockfish calls your move a clear inaccuracy.';
      else judgement = 'Stockfish says your move is a serious mistake here.';
      const parts = [
        h('span.verdict-scores', `Book ${sanLabel(fen, book)} ${formatScore(bookM.score)} · yours ${sanLabel(fen, played)} ${formatScore(playM.score)} (depth ${res.depth})`),
        h('span', judgement),
      ];
      if (bestGain > 70 && res.best.move !== book) parts.push(h('span', `Stockfish itself prefers ${sanLabel(fen, res.best.move)} (${formatScore(res.best.score)}). Worth checking in Explore.`));
      clear(el, ...parts);
      el.classList.remove('muted');
    } catch (err) {
      if (el.isConnected) el.textContent = 'Stockfish is not available right now.';
    }
  }

  function finishPhase() {
    const { line } = run;
    if (run.phase === 'guided' && settings.learnRecall) {
      later(() => startLine(line, 'recall'), 700);
      setPrompt('Line shown', 'Now play it from memory.');
      return;
    }
    run.waiting = false;
    board.setPosition(run.fen, { lastMove: run.lastUci, movable: false });
    const now = Date.now();
    const graded = gradePass({ line, phase: run.phase, quiz: run.quiz, dueAtStart: run.dueAtStart, results: run.results, cards: cards(), now }, settings);
    run.results = graded.results;
    const { updates, right, wrong } = graded;
    const outcomes = graded.outcomes.map((o) => ({ node: model.cards.get(o.key).node, r: o.result, text: outcomeText(o, now) }));
    if (!run.retry) {
      tally.lines++;
      tally.right += right;
      tally.wrong += wrong;
    }
    done.add(line.id);
    // A practice pass (Practise, or a retry in any mode) leaves the schedule and the day's tally alone.
    if (run.phase !== 'practice') {
      void saveCards(rep.id, updates, { correct: right, wrong, lines: 1 }); // never rejects: see the outbox
    }
    if (!wrong) sound.done();
    renderDots();
    showLineDone(line, right, wrong, outcomes);
  }

  function showLineDone(line, right, wrong, outcomes) {
    if (upcoming === undefined) upcoming = nextLine();
    const next = upcoming;
    const perfect = wrong === 0;
    setPrompt(perfect ? 'Line complete' : 'Line complete, with mistakes', perfect ? `${plural(right, 'move')} right.` : `${right} right, ${wrong} to revisit.`);
    clear(notes);
    clear(feedback, outcomes.length ? h('ul.outcomes', outcomes.map((o) => h(`li.${o.r}`, h('span.o-move', moveText(o.node)), o.text ? h('span.o-text', o.text) : null))) : null);
    const finalEval = h('p.final-eval.muted', 'Stockfish is looking at the final position…');
    feedback.append(finalEval);
    clear(controls,
      next
        ? h('button.btn.primary', { type: 'button', on: { click: () => startLine(takeNext(), phaseFor()) }, 'data-key': 'Enter', 'aria-keyshortcuts': 'Enter' }, keyed('Next line', '↵'))
        : h('button.btn.primary', { type: 'button', on: { click: showSessionDone }, 'data-key': 'Enter', 'aria-keyshortcuts': 'Enter' }, keyed('Finish session', '↵')),
      h('button.btn', { type: 'button', on: { click: () => startLine(line, 'practice', { retry: true }) } }, 'Retry line'));
    setTools([
      playOutTool(sparLink(run.fen, { goal: 'hold' }), settings),
      sparTool(sparLink(run.fen), settings),
      finderTool(),
      exploreTool(`#/explore/${rep.id}?line=${line.id}`),
    ]);
    controls.firstChild.focus();
    if (next && settings.autoNext > 0) {
      // Count down to the next line; any click on the board or panel stops it.
      let left = settings.autoNext;
      const btn = controls.firstChild;
      const labelEl = btn.querySelector('.btn-label');
      const label = labelEl.textContent;
      const tick = () => {
        if (!btn.isConnected || btn.dataset.stopped) return;
        if (left <= 0) { btn.click(); return; }
        labelEl.textContent = `${label} (${left})`;
        left--;
        later(tick, 1000);
      };
      const stop = () => { btn.dataset.stopped = '1'; labelEl.textContent = label; };
      page.addEventListener('pointerdown', (e) => { if (e.target !== btn) stop(); }, { once: true });
      tick();
    }

    // Where does the line leave you?
    evalBar.hide(false);
    engineRun = analyse(run.fen, { multipv: 1, depth: settings.finalEvalDepth }, (msg, final) => {
      const top = msg.lines && msg.lines[0];
      if (!top) return;
      evalBar.update(evalBarShare(top.score), formatScore(top.score), rep.color === 'black');
      const pov = side === 'w' ? 1 : -1;
      const cp = scoreToCp(top.score) * pov;
      const verdict = cp > 150 ? 'clearly better for you' : cp > 50 ? 'slightly better for you' : cp > -50 ? 'roughly equal' : cp > -150 ? 'slightly worse for you' : 'worse for you';
      clear(finalEval, `Final position: ${formatScore(top.score)} at depth ${top.depth} — ${verdict}. Best: ${formatSanLine(uciLineToSan(run.fen, top.pv, 6))}`);
      if (final) finalEval.classList.remove('muted');
    }, () => {
      finalEval.textContent = 'Stockfish is not available right now.';
    });
  }

  function showSessionDone() {
    clearTimers();
    if (engineRun) { engineRun.stop(); engineRun = null; }
    const st = model.lines.filter((l) => lineStatus(l, cards()).isDue).length;
    clear(lineHead);
    clear(dots);
    clear(notes);
    clear(sheet);
    setPrompt('Session complete', tally.lines
      ? `${plural(tally.lines, 'line')}, ${tally.right} moves right, ${tally.wrong} to revisit.`
      : mode === 'review' ? 'Nothing is due right now.' : mode === 'learn' ? 'No new lines left to learn.' : 'No lines to practise yet — learn some first.');
    clear(feedback);
    setTools([]);
    clear(controls,
      mode === 'review' && st ? h('a.btn.primary', { href: `#/train/${rep.id}/review`, on: { click: (e) => { if (location.hash === e.currentTarget.getAttribute('href')) { e.preventDefault(); refresh(); } } } }, `Review ${st} more`) : null,
      h('a.btn', { href: `#/rep/${rep.id}` }, 'Back to repertoire'),
      h('a.btn.ghost', { href: '#/' }, 'Library'));
  }

  // ---- rendering helpers ------------------------------------------------------------
  function outcomeText({ change, result, next }, now) {
    switch (change) {
      case 'practice': return result === 'hint' ? 'with a hint' : '';
      case 'learned': return result === 'right' ? `level 1, next in ${describeWait(next.due - now)}` : 'level 1, due again now';
      case 'promoted': return `level ${next.level}, next in ${describeWait(next.due - now)}`;
      case 'demoted': return `back to level ${next.level}, next in ${describeWait(next.due - now)}`;
      case 'not-due': return 'not due yet, unchanged';
      default: return 'hint used, unchanged';
    }
  }

  function phaseFor() {
    if (mode === 'learn') return 'guided';
    if (mode === 'practice') return 'practice';
    return 'review';
  }

  function moveText(node) {
    const n = moveNumber(node);
    return node.color === 'w' ? `${n}.${fig(node.san)}` : `${n}...${fig(node.san)}`;
  }

  function setPrompt(title, sub) {
    clear(prompt, h('div.prompt-title', title), sub ? h('div.prompt-sub', sub) : null);
  }

  function setFeedback(kind, text, ...extra) {
    clear(feedback, h(`p.fb.fb-${kind}`, text), ...extra);
  }

  function setTools(items) {
    toolsSection.lastChild.replaceWith(toolList(items));
  }

  function showNotes(texts, node) {
    const items = texts.filter(Boolean);
    clear(notes, items.length ? h('div.note', node ? h('span.note-move', moveText(node)) : null, items.map((t) => h('p', t))) : null);
  }

  function renderHead() {
    const pos = done.size + (done.has(run.line.id) ? 0 : 1); // a retried line keeps its place
    const total = mode === 'review' && !target ? Math.min(sessionSize, done.size + countDue()) : sessionSize;
    clear(crumbs,
      h('a.backlink', { href: `#/rep/${rep.id}` }, rep.name),
      h('span.mode-tag', `${MODE_NAMES[mode]}${run.phase === 'recall' ? ' · from memory' : ''}${total > 1 ? ` · ${pos} of ${total}` : ''}`));
    clear(lineHead,
      h('h1.line-title', run.line.chapter.name),
      h('p.line-sub', `Line ${run.line.number} of ${run.line.chapter.lines.length} · ${plural(run.line.nodes.length, 'half-move')}`));
  }

  function countDue() {
    return model.lines.filter((l) => !done.has(l.id) && lineStatus(l, cards()).isDue).length;
  }

  function renderDots() {
    if (!run) return;
    const items = [];
    run.line.nodes.forEach((node, i) => {
      if (node.color !== side) return;
      const key = cardKey(node.parent.fen, node.uci);
      const r = run.results.get(key);
      const quizzed = run.quiz.has(key);
      let cls = quizzed ? 'quiz' : 'known';
      if (r === 'right') cls = 'right';
      if (r === 'wrong') cls = 'wrong';
      if (r === 'hint') cls = 'hint';
      if (r === 'auto') cls = 'known';
      if (i === run.ply && run.waiting) cls += ' current';
      items.push(h(`li.${cls.split(' ').join('.')}`, { title: `${moveText(node)}${quizzed ? '' : ' (known)'}` }));
    });
    clear(dots, items);
  }

  function renderSheet() {
    const rows = [];
    const nodes = run.played;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const num = moveNumber(n);
      if (n.color === 'w' || i === 0) {
        const row = h('li', h('span.sheet-num', `${num}.`));
        if (n.color === 'b') row.append(h('span.sheet-move.sheet-gap', '…'));
        rows.push(row);
      }
      rows[rows.length - 1].append(h(`span.sheet-move${n.color === side ? '.mine' : ''}`, fig(n.san) + nagGlyphs(n.nags)));
    }
    clear(sheet, rows);
    sheet.parentElement.scrollTop = sheet.parentElement.scrollHeight;
  }

  function hintButton() {
    return h('button.btn', {
      type: 'button',
      'data-key': 'h',
      'aria-keyshortcuts': 'H',
      on: {
        click: () => {
          if (!run || !run.waiting) return;
          const node = run.line.nodes[run.ply];
          const key = cardKey(node.parent.fen, node.uci);
          run.hint++;
          const result = resultAfterHint(run.results.get(key), run.phase, settings);
          if (result) run.results.set(key, result);
          renderDots();
          if (run.hint === 1) {
            board.setShapes([{ orig: node.uci.slice(0, 2), brush: 'bark' }]);
            setFeedback('neutral', settings.hintsCount ? 'Hint: move the highlighted piece. This move will come back sooner.' : 'Hint: move the highlighted piece.');
          } else {
            board.setShapes([{ orig: node.uci.slice(0, 2), dest: node.uci.slice(2, 4), brush: 'bark' }]);
            setFeedback('neutral', `The move is ${moveText(node)}.`);
          }
        },
      },
    }, keyed('Hint', 'H'));
  }

  function skipButton() {
    return h('button.btn.ghost', {
      type: 'button',
      on: {
        click: () => {
          if (!run) return;
          clearTimers();
          done.add(run.line.id);
          const next = takeNext();
          if (next) startLine(next, phaseFor());
          else showSessionDone();
        },
      },
    }, 'Skip line');
  }

  function finderTool() {
    return findTool(action(() => {
      if (!run) return undefined;
      const moves = run.played.map((n) => n.uci);
      const sans = uciLineToSan(run.line.startFen, moves, 80);
      return openMistakeFinder({
        rep,
        fen: run.fen,
        prefix: { startFen: run.line.startFen, moves },
        where: sans.length ? `From ${formatSanLine(sans.slice(-6))}` : `From the start of ${run.line.chapter.name}`,
      });
    }));
  }

  function sparLink(fen, { goal = null } = {}) {
    const back = encodeURIComponent(`#/rep/${rep.id}`);
    return `#/spar?fen=${encodeURIComponent(fen)}&color=${rep.color}&rep=${rep.id}&back=${back}${goal ? `&goal=${goal}` : ''}`;
  }

  // ---- keyboard ------------------------------------------------------------------------
  function onKey(e) {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'h' || e.key === 'H') controls.querySelector('[data-key="h"]')?.click();
    else if (e.key === 'Enter') {
      const btn = controls.querySelector('[data-key="Enter"]');
      if (btn && document.activeElement !== btn) { e.preventDefault(); btn.click(); }
    } else if (e.key === 'Escape') location.hash = `#/rep/${rep.id}`;
  }
  document.addEventListener('keydown', onKey);

  // ---- go ------------------------------------------------------------------------------
  const first = nextLine();
  if (first) startLine(first, phaseFor());
  else {
    run = null;
    board.setPosition(START_FEN);
    clear(crumbs, h('a.backlink', { href: `#/rep/${rep.id}` }, rep.name), h('span.mode-tag', MODE_NAMES[mode]));
    showSessionDone();
  }

  return () => {
    alive = false;
    clearTimers();
    if (engineRun) engineRun.stop();
    document.removeEventListener('keydown', onKey);
    board.destroy();
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
