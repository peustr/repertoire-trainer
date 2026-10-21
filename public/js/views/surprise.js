// Surprise drills: your opponent leaves your book with a reply you have not prepared,
// and you find a good answer over the board. Stockfish grades it (gradeSurprise in
// session.js). The schedule is untouched, but a good answer can join the repertoire as
// a new chapter and is then learned like any other line.
//
// Surprises come from the gaps the mistake finder saved, then from what Lichess players
// at your level reply in your lines, or, without a Lichess account, from sound
// sidelines Stockfish finds.

import { h, clear, sound, toast, sanLabel, plainLabel, uciLineToSan, formatSanLine, plural, action, keyed, panelSection, toolList, pawns } from '../ui.js';
import { state, getRep, putRep, modelFor, loadLichess } from '../store.js';
import { api } from '../api.js';
import { createBoard, isPromotion, choosePromotion } from '../board.js';
import { playMove } from '../moves.js';
import { evaluate, analyseOnce, formatScore } from '../engine-client.js';
import { surpriseQueue, surpriseFromGap, surpriseReplies, engineSurprises, surpriseToPgn } from '../opponent.js';
import { gradeSurprise, surprisePassed } from '../session.js';
import { exploreTool } from './tools.js';
import { formatShare, formatGames, describeRatings, describeSpeeds, cpFor } from '../puzzle-utils.js';

const LOOKUPS_PER_SURPRISE = 8; // positions tried before giving up on finding another surprise

export async function renderSurprise(root, { id }) {
  let rep = await getRep(id, { fresh: true });
  let model = modelFor(rep);
  const settings = state.settings;
  const side = model.side;
  const opponentName = side === 'w' ? 'Black' : 'White';
  let useLichess = !!(await loadLichess()).connected;
  const queue = surpriseQueue(rep, model);
  const batch = settings.surpriseBatch;
  const tally = { done: 0, good: 0 };

  const page = h('div.page.surprise');
  const boardHost = h('div.board-host');
  const crumbs = h('div.trainer-crumbs');
  const head = h('div.line-head');
  const prompt = h('div.prompt', { 'aria-live': 'polite' });
  const feedback = h('div.feedback', { 'aria-live': 'polite' });
  const context = h('div.puzzle-context');
  const controls = h('div.controls');
  const toolsSection = panelSection('From this position', null, toolList([]));
  page.append(
    h('div.board-col', h('div.board-row', boardHost)),
    h('aside.panel',
      crumbs,
      head,
      h('div.task', prompt, feedback, controls),
      panelSection('About this reply', null, context),
      toolsSection));
  root.append(page);

  const board = createBoard(boardHost, { orientation: rep.color, onMove: action(onMove) });
  let cur = null;
  let token = 0;
  let timers = [];
  const later = (fn, ms) => { const t = setTimeout(() => { timers = timers.filter((x) => x !== t); if (page.isConnected) fn(); }, ms); timers.push(t); };
  const alive = (t) => t === token && page.isConnected;

  function setCrumbs() {
    clear(crumbs,
      h('a.backlink', { href: `#/rep/${rep.id}` }, rep.name),
      h('span.mode-tag', `Surprise drill · ${Math.min(tally.done + 1, batch)} of ${batch}`));
  }
  function setPrompt(text, sub) { clear(prompt, h('div.prompt-title', text), sub ? h('div.prompt-sub', sub) : null); }
  function setFeedback(kind, text, ...extra) { clear(feedback, h(`p.fb.fb-${kind}`, text), ...extra); }
  function setTools(items) { toolsSection.lastChild.replaceWith(toolList(items)); }

  // ---- finding the next surprise ---------------------------------------------------------
  /** The next surprise in the queue, looking positions up as needed; null when none is left. */
  async function findSurprise(t) {
    let lookups = 0;
    while (queue.length) {
      const item = queue.shift();
      if (item.kind === 'gap') {
        // The repertoire may answer it by now (an answer added earlier in this session).
        const gap = rep.gaps && rep.gaps[item.surprise.gapKey];
        const fresh = gap ? surpriseFromGap(model, item.surprise.gapKey, gap) : null;
        if (fresh) return fresh;
        continue;
      }
      if (lookups >= LOOKUPS_PER_SURPRISE) { queue.unshift(item); return null; }
      lookups++;
      const turn = item.turn;
      setPrompt('Finding an unprepared reply…', useLichess ? 'Looking up what Lichess players at your level reply here.' : 'Asking Stockfish for sidelines your repertoire skips.');
      let candidates = [];
      if (useLichess) {
        try {
          const data = await api.lichess.explorer(turn.fen);
          candidates = surpriseReplies(model, turn.fen, data, { minShare: settings.surpriseMinShare / 100 })
            .map((c) => ({ ...c, source: /** @type {const} */ ('lichess') }));
        } catch (err) {
          useLichess = false;
          toast(`${err.message} Stockfish suggests the surprises instead.`, 'bad');
        }
      }
      if (!useLichess) {
        const res = await analyseOnce(turn.fen, { multipv: 4, depth: 12 });
        candidates = engineSurprises(model, turn.fen, res.lines)
          .map((c) => ({ ...c, share: null, games: null, source: /** @type {const} */ ('engine') }));
      }
      if (!alive(t)) return null;
      if (!candidates.length) continue;
      // Popular replies come up more often, like in real games.
      let x = Math.random() * candidates.reduce((sum, c) => sum + (c.games || 1), 0);
      let pick = candidates[candidates.length - 1];
      for (const c of candidates) {
        x -= c.games || 1;
        if (x < 0) { pick = c; break; }
      }
      return { startFen: turn.startFen, moves: turn.moves, fen: turn.fen, uci: pick.uci, san: pick.san, share: pick.share, games: pick.games, source: pick.source };
    }
    return null;
  }

  async function next() {
    const t = ++token;
    timers.forEach(clearTimeout);
    timers = [];
    cur = null;
    clear(feedback);
    clear(controls);
    clear(context);
    setTools([]);
    if (tally.done >= batch) { showDone(); return; }
    setCrumbs();
    clear(head, h('h1.line-title', 'Unprepared reply'));
    board.setShapes([]);
    let s;
    try {
      s = await findSurprise(t);
    } catch (err) {
      if (!alive(t)) return;
      setPrompt('No reply found', 'Stockfish is not available right now.');
      clear(controls, h('button.btn.primary', { type: 'button', on: { click: () => void next() } }, 'Try again'), backLink());
      return;
    }
    if (!alive(t)) return;
    if (!s) { showDone(); return; }
    present(s, t);
  }

  // ---- one surprise ----------------------------------------------------------------------
  function present(s, t) {
    const res = playMove(s.fen, s.uci);
    cur = { s, after: res.fen, waiting: false, tries: 0, answer: null, best: null, added: false };
    clear(head, h('h1.line-title', 'Unprepared reply'), h('p.line-sub', sourceText(s)));
    renderContext(s);
    const prev = s.moves[s.moves.length - 1];
    board.setPosition(s.fen, { lastMove: prev });
    setPrompt(`${opponentName} to move`, s.moves.length ? `After ${lineSoFar(s, 4)}` : 'From the start of the chapter.');
    later(() => {
      if (!alive(t)) return;
      board.setPosition(cur.after, { lastMove: s.uci, playSound: true, captured: res.captured });
      board.setShapes([{ orig: s.uci.slice(2, 4), brush: 'flame' }]);
      setPrompt(`${sanLabel(s.fen, s.uci)} is not in your repertoire`, 'Find a good answer.');
      cur.waiting = true;
      board.setPosition(cur.after, { lastMove: s.uci, movable: true });
      clear(controls, h('button.btn.ghost', { type: 'button', on: { click: () => void next() } }, 'Skip'));
    }, 800);
  }

  function sourceText(s) {
    if (s.source === 'engine') return 'A sound sideline Stockfish found';
    return s.source === 'gap' ? 'A popular reply the mistake finder spotted' : 'What Lichess players at your level play';
  }

  function lineSoFar(s, plies) {
    const sans = uciLineToSan(s.startFen, s.moves, 200);
    return formatSanLine(sans.slice(-plies));
  }

  function renderContext(s) {
    const shown = uciLineToSan(s.startFen, [...s.moves, s.uci], 200);
    const tail = shown.slice(-10);
    clear(context,
      h('p.puzzle-line', tail.length < shown.length ? '… ' : '', formatSanLine(tail)),
      s.share != null ? h('dl.puzzle-facts',
        h('dt', 'How often'), h('dd', `${formatShare(s.share)} of the games here${s.games ? ` (${formatGames(s.games)} games)` : ''}`),
        h('dt', 'Players'), h('dd', `Lichess ${describeSpeeds(settings.lichessSpeeds)}, ${describeRatings(settings.lichessRatings)}`))
        : h('p.surprise-facts', 'Stockfish rates this move as sound, and your repertoire has no answer to it.'));
  }

  async function onMove(from, to) {
    if (!cur || !cur.waiting) { if (cur) board.setPosition(cur.after, { lastMove: cur.s.uci }); return; }
    const t = token;
    const fen = cur.after;
    let uci = from + to;
    if (isPromotion(fen, from, to)) uci += await choosePromotion(rep.color);
    const played = playMove(fen, uci);
    if (!played) { board.setPosition(fen, { lastMove: cur.s.uci, movable: true }); return; }
    cur.waiting = false;
    board.setShapes([]);
    board.setPosition(played.fen, { lastMove: uci, playSound: true, captured: played.captured });
    setPrompt(`${sanLabel(cur.s.fen, cur.s.uci)}, answered with ${sanLabel(fen, uci)}`, 'Stockfish is checking your answer…');
    setFeedback('neutral', `Checking ${sanLabel(fen, uci)} with Stockfish…`);
    clear(controls);
    const res = await evaluate(fen, [uci], settings.verdictDepth).catch(() => null);
    if (!alive(t)) return;
    const mine = res && res.moves.find((m) => m.move === uci);
    if (!res || !res.best || !res.best.score || !mine || !mine.score) {
      setFeedback('bad', 'Stockfish is not available right now, so your answer cannot be checked.');
      clear(controls, tryAgainButton(), nextButton());
      return;
    }
    const loss = Math.max(0, cpFor(res.best.score, side) - cpFor(mine.score, side));
    const grade = gradeSurprise({ loss, isBest: res.best.move === uci }, settings);
    const pass = surprisePassed(grade);
    if (cur.tries === 0) { tally.done++; if (pass) tally.good++; }
    cur.tries++;
    cur.answer = uci;
    cur.best = res.best;
    const label = sanLabel(fen, uci);
    const bestLabel = sanLabel(fen, res.best.move);
    setPrompt(pass ? 'Good answer' : 'Not good enough', pass ? 'Add it to your repertoire to learn it like any other line.' : 'Try again, or see what Stockfish plays.');
    if (pass) {
      sound.right();
      setFeedback('good', grade === 'best'
        ? `${label}: Stockfish’s choice too (${formatScore(mine.score)}).`
        : `${label} is a good answer (${formatScore(mine.score)}). Stockfish’s best was ${bestLabel} (${formatScore(res.best.score)}).`);
      clear(controls,
        nextButton(),
        addButton(uci, 'Add my answer to the repertoire'),
        grade === 'best' ? null : addButton(res.best.move, 'Add Stockfish’s answer'));
      setTools([exploreTool(exploreHref(), 'Explore the position')]);
    } else {
      sound.wrong();
      setFeedback('bad', grade === 'inaccuracy'
        ? `${label} is playable but gives away ${pawns(loss)} (${formatScore(mine.score)}).`
        : `${label} is a mistake here: it gives away ${pawns(loss)} (${formatScore(mine.score)}).`);
      clear(controls, tryAgainButton(), showAnswerButton(), nextButton());
    }
    controls.firstChild.focus();
  }

  // ---- buttons ---------------------------------------------------------------------------
  function nextButton() {
    return h('button.btn.primary', { type: 'button', 'data-key': 'Enter', 'aria-keyshortcuts': 'Enter', on: { click: () => void next() } }, keyed(tally.done >= batch ? 'Finish' : 'Next reply', '↵'));
  }

  function tryAgainButton() {
    return h('button.btn', {
      type: 'button',
      on: {
        click: () => {
          if (!cur) return;
          clear(feedback);
          board.setShapes([{ orig: cur.s.uci.slice(2, 4), brush: 'flame' }]);
          board.setPosition(cur.after, { lastMove: cur.s.uci, movable: true });
          setPrompt(`${sanLabel(cur.s.fen, cur.s.uci)}: try again`, 'Find a better answer.');
          cur.waiting = true;
          clear(controls, showAnswerButton(), nextButton());
        },
      },
    }, 'Try again');
  }

  function showAnswerButton() {
    return h('button.btn.ghost', {
      type: 'button',
      on: {
        click: action(async () => {
          if (!cur) return;
          const t = token;
          let best = cur.best;
          if (!best) best = (await evaluate(cur.after, [], settings.verdictDepth)).best;
          if (!alive(t) || !best || !best.move) return;
          cur.waiting = false;
          cur.best = best;
          board.setPosition(cur.after, { lastMove: cur.s.uci });
          board.setShapes([{ orig: best.move.slice(0, 2), dest: best.move.slice(2, 4), brush: 'flame' }]);
          setFeedback('neutral', `Stockfish answers ${sanLabel(cur.after, best.move)}${best.score ? ` (${formatScore(best.score)})` : ''}.`);
          clear(controls, nextButton(), addButton(best.move, 'Add Stockfish’s answer'));
          setTools([exploreTool(exploreHref(), 'Explore the position')]);
        }),
      },
    }, 'Show the answer');
  }

  function addButton(uci, text) {
    return h('button.btn', {
      type: 'button',
      'data-add': uci,
      on: {
        click: action(async (e) => {
          const btn = e.currentTarget;
          if (!cur || cur.added) return;
          const s = cur.s;
          const note = s.share != null
            ? `Played in ${formatShare(s.share)} of Lichess games here (${describeRatings(settings.lichessRatings)}).`
            : 'A sideline Stockfish rates as sound.';
          const pgn = surpriseToPgn(s, uci, { note });
          const updated = await api.addLine(rep.id, pgn, s.gapKey);
          rep = putRep(updated);
          model = modelFor(rep);
          cur.added = true;
          for (const b of controls.querySelectorAll('button[data-add]')) if (b !== btn) b.remove();
          // A new button: action() re-enables the one that was clicked once this returns.
          btn.replaceWith(h('button.btn', { type: 'button', disabled: true }, 'In your repertoire'));
          toast(`Added ${plainLabel(cur.after, uci)} as a new chapter. It will show up in Learn.`);
        }),
      },
    }, text);
  }

  function exploreHref() {
    const moves = [...cur.s.moves, cur.s.uci];
    return `#/explore/${rep.id}?moves=${encodeURIComponent(moves.join(','))}`;
  }

  function backLink() {
    return h('a.btn', { href: `#/rep/${rep.id}` }, 'Back to repertoire');
  }

  function showDone() {
    cur = null;
    board.setShapes([]);
    clear(head, h('h1.line-title', 'Session complete'));
    clear(crumbs, h('a.backlink', { href: `#/rep/${rep.id}` }, rep.name), h('span.mode-tag', 'Surprise drill'));
    clear(feedback);
    clear(context);
    setTools([]);
    if (!tally.done) {
      setPrompt('No unprepared replies found', model.lines.length
        ? 'Your repertoire already answers the replies we looked up. Search for opponent mistakes to find more gaps.'
        : 'Add some lines to your repertoire first.');
    } else {
      setPrompt(`${tally.good} of ${plural(tally.done, 'surprise')} answered well`, tally.good === tally.done ? 'Every reply answered well.' : 'Add the answers you want to keep, then learn them like any other line.');
    }
    clear(controls,
      tally.done ? h('button.btn.primary', { type: 'button', 'data-key': 'Enter', on: { click: () => { tally.done = 0; tally.good = 0; if (!queue.length) queue.push(...surpriseQueue(rep, model)); void next(); } } }, 'Another round') : null,
      backLink());
  }

  function onKey(e) {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'Enter') {
      const btn = controls.querySelector('[data-key="Enter"]');
      if (btn && document.activeElement !== btn) { e.preventDefault(); btn.click(); }
    } else if (e.key === 'Escape') location.hash = `#/rep/${rep.id}`;
  }
  document.addEventListener('keydown', onKey);

  void next();

  return () => {
    token++;
    timers.forEach(clearTimeout);
    document.removeEventListener('keydown', onKey);
    board.destroy();
  };
}
