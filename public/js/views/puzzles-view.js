// Personalised puzzles: punish the mistakes real opponents make in your lines.
// Each puzzle is a spaced-repetition card like any move in your repertoire.

import { h, clear, sound, toast, sanLabel, plainLabel, uciLineToSan, formatSanLine, plural, confirmDialog, action } from '../ui.js';
import { state, getRep, putRep, saveCards } from '../store.js';
import { describeWait, isDue } from '../srs.js';
import { gradeCard } from '../session.js';
import { createBoard, createEvalBar, isPromotion, choosePromotion, applyUci } from '../board.js';
import { evaluate, analyse, formatScore, evalBarShare } from '../engine-client.js';
import { api } from '../api.js';
import { puzzleQueue, puzzleKey, puzzleState, puzzleToPgn, formatGames, formatShare, describeRatings, describeSpeeds, describeReach, cpFor } from '../puzzle-utils.js';

export async function renderPuzzles(root, { id, ids }) {
  const rep = await getRep(id, { fresh: true });
  const side = rep.color === 'black' ? 'b' : 'w';
  const only = ids ? ids.split(',').filter(Boolean) : null;
  const queue = puzzleQueue(rep, { limit: only ? 200 : state.settings.puzzleBatch, only });
  const total = queue.length;
  const tally = { solved: 0, missed: 0 };

  const page = h('div.page.trainer.puzzles', { 'data-mode': 'puzzle' });
  const evalHost = h('div.eval-host');
  const boardHost = h('div.board-host');
  const crumbs = h('div.trainer-crumbs');
  const head = h('div.line-head');
  const context = h('div.puzzle-context');
  const prompt = h('div.prompt', { 'aria-live': 'polite' });
  const feedback = h('div.feedback', { 'aria-live': 'polite' });
  const controls = h('div.controls');
  page.append(
    h('div.board-col', h('div.board-row', evalHost, boardHost)),
    h('aside.panel', crumbs, head, prompt, feedback, context, controls));
  root.append(page);

  const board = createBoard(boardHost, { orientation: rep.color, onMove });
  const evalBar = createEvalBar(evalHost);
  evalBar.hide(true);

  let cur = null;
  let index = 0;
  let timers = [];
  let engineRun = null;
  const later = (fn, ms) => { const t = setTimeout(() => { timers = timers.filter((x) => x !== t); if (page.isConnected) fn(); }, ms); timers.push(t); };
  const stopAll = () => { timers.forEach(clearTimeout); timers = []; if (engineRun) { engineRun.stop(); engineRun = null; } };

  const opponent = side === 'w' ? 'Black' : 'White';

  function start(p) {
    stopAll();
    evalBar.hide(true);
    cur = { p, step: 0, fen: p.fen, failed: false, hint: 0, waiting: false, alt: false, played: [] };
    clear(crumbs, h('a.backlink', { href: `#/rep/${rep.id}` }, rep.name), h('span.mode-tag', `Puzzle${total > 1 ? ` · ${index + 1} of ${total}` : ''}`));
    // The theme ("Wins a piece") would give the answer away, so it waits until the end.
    clear(head,
      h('h1.line-title', 'Punish the mistake'),
      h('p.line-sub', statusLine(p)));
    renderContext(p);
    clear(feedback);
    clear(controls, hintButton(), skipButton());
    const prevMove = p.lineMoves.length > 1 ? p.lineMoves[p.lineMoves.length - 2] : undefined;
    board.setShapes([]);
    board.setPosition(p.beforeFen, { lastMove: prevMove });
    setPrompt(`${opponent} to move`, 'Watch what players at your level often do here.');
    later(() => {
      board.setPosition(p.fen, { lastMove: p.mistake.uci, playSound: true });
      board.setShapes([{ orig: p.mistake.uci.slice(2, 4), brush: 'red' }]);
      setPrompt(`${sanLabel(p.beforeFen, p.mistake.uci)}? Punish it.`, `Your move as ${side === 'w' ? 'White' : 'Black'}.`);
      cur.waiting = true;
      board.setPosition(p.fen, { lastMove: p.mistake.uci, movable: true });
    }, 900);
  }

  function statusLine(p) {
    const s = puzzleState(rep, p);
    if (!s) return 'New puzzle';
    if (isDue(s)) return `Review · level ${s.level}`;
    return `Level ${s.level} · next in ${describeWait(s.due - Date.now())}`;
  }

  function renderContext(p) {
    const line = uciLineToSan(p.startFen, p.lineMoves, 60);
    const shown = line.slice(-10);
    const m = p.mistake;
    const f = p.filters || {};
    const yourSide = side === 'w' ? 'White' : 'Black';
    clear(context,
      h('p.puzzle-line', shown.length < line.length ? '… ' : '', formatSanLine(shown).replace(/(\S+)$/, '$1?')),
      h('dl.puzzle-facts',
        h('dt', 'How often'), h('dd', `${formatShare(m.share)} of ${formatGames(m.positionGames)} games${m.averageRating ? `, average rating ${m.averageRating}` : ''}`),
        m.yourScore != null ? [h('dt', 'Results'), h('dd', `${yourSide} scores ${m.yourScore}% after it`)] : null,
        p.reach ? [h('dt', 'Your odds'), h('dd', describeReach(p.reach).replace(/ from here$/, ' from where you searched'))] : null,
        h('dt', 'Players'), h('dd', `Lichess ${describeSpeeds(f.speeds)}, ${describeRatings(f.ratings)}`)));
  }

  async function onMove(from, to) {
    if (!cur || !cur.waiting) { if (cur) board.setPosition(cur.fen, { lastMove: lastUci() }); return; }
    const { p } = cur;
    const expected = p.solution[cur.step];
    let uci = from + to;
    if (isPromotion(cur.fen, from, to)) uci += expected.startsWith(uci) && expected.length === 5 ? expected[4] : await choosePromotion(rep.color);

    if (uci === expected) {
      play(uci);
      if (!cur.failed && cur.hint === 0) sound.right();
      setFeedback('good', `${sanLabel(cur.fenBefore, uci)} — ${cur.step + 1 < p.solution.length ? 'keep going.' : 'that’s it.'}`);
      cur.step++;
      if (cur.step < p.solution.length) {
        cur.waiting = false;
        later(() => { play(p.solution[cur.step], true); cur.step++; cur.waiting = true; board.setPosition(cur.fen, { lastMove: lastUci(), movable: true }); }, 550);
      } else {
        finish();
      }
      return;
    }

    // Not the main line: does it win anyway?
    cur.waiting = false;
    board.setPosition(cur.fen, { lastMove: lastUci() });
    setFeedback('neutral', `Checking ${sanLabel(cur.fen, uci)} with Stockfish…`);
    let accepted = false;
    try {
      const res = await evaluate(cur.fen, [expected, uci], state.settings.verdictDepth);
      const mine = res.moves.find((m) => m.move === uci);
      const main = res.moves.find((m) => m.move === expected);
      if (mine && mine.score && main && main.score) {
        const a = cpFor(mine.score, side);
        const b = cpFor(main.score, side);
        const { puzzleAltMin, puzzleAltMargin } = state.settings;
        accepted = puzzleAltMargin > 0 && a >= puzzleAltMin && a >= b - puzzleAltMargin;
      }
    } catch (err) { /* engine unavailable: treat as a miss */ }
    if (!cur || !page.isConnected) return;

    if (accepted) {
      cur.alt = true;
      play(uci);
      sound.right();
      setFeedback('good', `${sanLabel(cur.fenBefore, uci)} also wins. Stockfish’s main line was ${formatSanLine(uciLineToSan(cur.fenBefore, p.solution.slice(cur.step), 6))}.`);
      finish();
      return;
    }
    cur.failed = true;
    sound.wrong();
    board.flash(to, 'wrong');
    board.setPosition(cur.fen, { lastMove: lastUci(), movable: true });
    board.setShapes([{ orig: expected.slice(0, 2), dest: expected.slice(2, 4), brush: 'flame' }]);
    setFeedback('bad', `Not ${sanLabel(cur.fen, uci)}. The punishment is ${sanLabel(cur.fen, expected)} — play it to see why.`);
    cur.waiting = true;
  }

  function lastUci() {
    return cur.played.length ? cur.played[cur.played.length - 1] : cur.p.mistake.uci;
  }

  function play(uci, quiet = false) {
    const res = applyUci(cur.fen, uci);
    if (!res) return;
    cur.fenBefore = cur.fen;
    cur.fen = res.fen;
    cur.played.push(uci);
    board.setPosition(res.fen, { lastMove: uci, playSound: true, captured: res.captured });
    board.setShapes([]);
    if (quiet) setFeedback('neutral', `${opponent} replies ${sanLabel(cur.fenBefore, uci)}.`);
  }

  function finish() {
    cur.waiting = false;
    stopAll();
    const { p } = cur;
    const success = !cur.failed && cur.hint === 0;
    const now = Date.now();
    const prev = puzzleState(rep, p);
    const next = gradeCard(prev, success, state.settings, now);
    if (success) tally.solved++; else tally.missed++;
    if (next !== prev) {
      void saveCards(rep.id, { [puzzleKey(p.id)]: next }, success ? { correct: 1 } : { wrong: 1 }); // never rejects: see the outbox
    }
    if (success) sound.done();
    const title = head.querySelector('.line-title');
    if (title && p.theme) title.textContent = p.theme.label;
    let when;
    if (next === prev) when = 'Not due yet, so the schedule is unchanged.';
    else if (next.due <= now) when = 'It comes back in your next puzzle session.';
    else when = `Next time in ${describeWait(next.due - now)} (level ${next.level}).`;
    setPrompt(success ? 'Solved' : 'Solved with help', when);
    const line = formatSanLine(uciLineToSan(p.fen, p.solution, 8));
    feedback.append(h('p.final-eval', `Stockfish’s line: ${line}. Evaluation ${formatScore(p.score)}.`));

    const hasNext = index + 1 < queue.length;
    const added = !!p.addedAt;
    clear(controls,
      hasNext
        ? h('button.btn.primary', { type: 'button', 'data-key': 'Enter', on: { click: () => { index++; start(queue[index]); } } }, 'Next puzzle')
        : h('button.btn.primary', { type: 'button', 'data-key': 'Enter', on: { click: done } }, 'Finish'),
      h('button.btn', { type: 'button', disabled: added, on: { click: (e) => addToRepertoire(p, e.currentTarget) } }, added ? 'In your repertoire' : 'Add line to repertoire'),
      h('a.btn.ghost', { href: `#/explore/${rep.id}?moves=${encodeURIComponent([...p.lineMoves, ...p.solution].join(','))}` }, 'Explore'),
      h('a.btn.ghost', { href: `#/spar?fen=${encodeURIComponent(cur.fen)}&color=${rep.color}&rep=${rep.id}&back=${encodeURIComponent(location.hash)}` }, 'Spar from here'),
      h('button.btn.ghost.danger', { type: 'button', on: { click: action(() => removePuzzle(p)) } }, 'Remove'));
    controls.firstChild.focus();

    evalBar.hide(false);
    engineRun = analyse(cur.fen, { multipv: 1, depth: 16 }, (msg) => {
      const top = msg.lines && msg.lines[0];
      if (top) evalBar.update(evalBarShare(top.score), formatScore(top.score), rep.color === 'black');
    }, () => evalBar.hide(true));
  }

  async function addToRepertoire(p, btn) {
    btn.disabled = true;
    const title = `Punishing ${plainLabel(p.beforeFen, p.mistake.uci)}`;
    const game = puzzleToPgn(p, { title });
    try {
      // One request: the server appends the chapter and marks the puzzle in the same save.
      const updated = await api.addPuzzleLine(rep.id, p.id, game);
      p.addedAt = updated.puzzles[p.id].addedAt;
      putRep(updated);
      rep.pgn = updated.pgn;
      btn.textContent = 'In your repertoire';
      toast(`Added the chapter “${title}”. It will show up in Learn.`);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'bad');
    }
  }

  async function removePuzzle(p) {
    if (!(await confirmDialog('Remove this puzzle?', 'It will not come back unless a new search finds it again.', 'Remove', true))) return;
    await api.deletePuzzle(rep.id, p.id);
    toast('Puzzle removed');
    queue.splice(index, 1);
    if (index < queue.length) start(queue[index]);
    else done();
  }

  function done() {
    stopAll();
    cur = null;
    clear(head);
    clear(context);
    clear(feedback);
    board.setShapes([]);
    evalBar.hide(true);
    clear(crumbs, h('a.backlink', { href: `#/rep/${rep.id}` }, rep.name), h('span.mode-tag', 'Puzzles'));
    setPrompt(tally.solved + tally.missed ? 'Puzzles done' : 'No puzzles waiting',
      tally.solved + tally.missed
        ? `${plural(tally.solved, 'puzzle')} solved cleanly, ${tally.missed} to revisit.`
        : 'Run “Find opponent mistakes” from a position in Explore or the trainer to build your set.');
    clear(controls,
      h('a.btn.primary', { href: `#/rep/${rep.id}` }, 'Back to repertoire'),
      h('a.btn.ghost', { href: `#/explore/${rep.id}` }, 'Explore'));
  }

  function hintButton() {
    return h('button.btn', {
      type: 'button',
      'data-key': 'h',
      on: {
        click: () => {
          if (!cur || !cur.waiting) return;
          const expected = cur.p.solution[cur.step];
          cur.hint++;
          board.setShapes(cur.hint === 1
            ? [{ orig: expected.slice(0, 2), brush: 'bark' }]
            : [{ orig: expected.slice(0, 2), dest: expected.slice(2, 4), brush: 'bark' }]);
          setFeedback('neutral', cur.hint === 1 ? 'Hint: this piece. The puzzle will come back sooner.' : `The move is ${sanLabel(cur.fen, expected)}.`);
        },
      },
    }, 'Hint');
  }

  function skipButton() {
    return h('button.btn.ghost', { type: 'button', on: { click: () => { index++; if (index < queue.length) start(queue[index]); else done(); } } }, 'Skip');
  }

  function setPrompt(title, sub) {
    clear(prompt, h('div.prompt-title', title), sub ? h('div.prompt-sub', sub) : null);
  }
  function setFeedback(kind, text) {
    clear(feedback, h(`p.fb.fb-${kind}`, text));
  }

  function onKey(e) {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'h' || e.key === 'H') controls.querySelector('[data-key="h"]')?.click();
    else if (e.key === 'Enter') {
      const btn = controls.querySelector('[data-key="Enter"]');
      if (btn && document.activeElement !== btn) { e.preventDefault(); btn.click(); }
    } else if (e.key === 'Escape') location.hash = `#/rep/${rep.id}`;
  }
  document.addEventListener('keydown', onKey);

  if (queue.length) start(queue[0]);
  else done();

  return () => {
    stopAll();
    document.removeEventListener('keydown', onKey);
    board.destroy();
  };
}
