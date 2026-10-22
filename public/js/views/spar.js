// Spar: play on from a position against the opponent of your choice.
//   Lichess players  each move is chosen as often as players in your rating bands and
//                    time controls play it (the opening explorer). In a position with
//                    no games, Stockfish takes over at the chosen strength.
//   Prepared lines   the opponent picks from the replies you prepared for, then Stockfish.
//   Stockfish        from the first move.
// With goal=hold ("Play it out" after a line) you play a set number of moves, and you
// pass if Stockfish's evaluation holds up (gradePlayout in session.js).

import { h, clear, fig, toast, sound, sanLabel, uciLineToSan, formatSanLine, panelSection, action, pawns } from '../ui.js';
import { state, getRep, modelFor } from '../store.js';
import { api } from '../api.js';
import { START_FEN, positionKey } from '../constants.js';
import { createBoard, createEvalBar, isPromotion, choosePromotion, gameStatus, turnColor } from '../board.js';
import { playMove } from '../moves.js';
import { bestmove, analyse, evaluate, formatScore, evalBarShare } from '../engine-client.js';
import { pickByPopularity } from '../opponent.js';
import { gradePlayout, biggestSlip } from '../session.js';
import { describeRatings, describeSpeeds, formatShare, formatGames, cpFor } from '../puzzle-utils.js';

const OPPONENTS = [['lichess', 'Lichess players at your rating'], ['book', 'Your prepared lines'], ['engine', 'Stockfish only']];

/** "+0.45", "−1.20", or "a forced mate for you" / "against you" for a mate. */
function formatCp(cp) {
  if (cp >= 9000) return 'a forced mate for you';
  if (cp <= -9000) return 'a forced mate against you';
  return `${cp >= 0 ? '+' : '−'}${Math.abs(cp / 100).toFixed(2)}`;
}

export async function renderSpar(root, { fen, color, id, back, goal: goalParam }) {
  const startFen = fen || START_FEN;
  const me = color === 'black' ? 'black' : 'white';
  const mine = me === 'white' ? 'w' : 'b';
  const rep = id ? await getRep(id).catch(() => null) : null;
  const model = rep ? modelFor(rep) : null;
  const backHref = back || (rep ? `#/rep/${rep.id}` : '#/');
  const settings = state.settings;

  let elo = settings.sparElo;
  let opponent = settings.sparOpponent === 'book' && !model ? 'lichess' : settings.sparOpponent;
  /** @type {{ fen: string, before: string, uci: string, san: string, color: string, captured: boolean,
   *   source?: 'lichess' | 'book' | 'engine', share?: number, games?: number, dbEnd?: string, loss?: number, best?: string }[]} */
  let history = [];
  let thinking = false;
  let showEval = false;
  let evalRun = null;
  let gameToken = 0;
  let leftBookAt = null; // { label, mine }
  // Play it out: how many moves, the start's evaluation (a promise of cp from your side), and whether it is over.
  let goal = goalParam === 'hold' ? { moves: settings.playOutMoves } : null;
  let startRating = null;
  let finished = false;

  // ---- layout -------------------------------------------------------------------------
  const page = h('div.page.spar', { 'data-goal': goal ? 'hold' : null });
  const evalHost = h('div.eval-host');
  const boardHost = h('div.board-host');
  const title = h('h1.line-title');
  const modeTag = h('span.mode-tag');
  const status = h('div.prompt', { 'aria-live': 'polite' });
  const goalBox = h('div.feedback.goal-box', { 'aria-live': 'polite' });
  const sourceNote = h('p.book-note.source-note');
  const bookNote = h('p.book-note');
  const moves = h('ol.scoresheet');
  const evalText = h('p.final-eval.muted');
  const eloLabel = h('output.elo-value');
  const eloInput = h('input', { type: 'range', min: 1320, max: 3190, step: 10, value: String(elo), 'aria-label': 'Stockfish strength' });
  const oppSelect = h('select', { 'aria-label': 'Opponent' },
    OPPONENTS.map(([k, label]) => h('option', { value: k, disabled: k === 'book' && !model, selected: k === opponent }, label)));
  const evalToggle = h('input', { type: 'checkbox', role: 'switch', checked: showEval });
  const evalRow = h('label.opt-row',
    h('span.opt-label', 'Show evaluation', h('span.opt-help', 'Stockfish’s bar and best line while you play.')),
    h('span.switch', evalToggle, h('span.switch-track', { 'aria-hidden': 'true' })));
  const takebackBtn = h('button.btn', { type: 'button', on: { click: takeback } }, 'Take back');
  const restartBtn = h('button.btn', { type: 'button', on: { click: restart } }, 'Restart');
  const goalControls = h('div.controls');

  page.append(
    h('div.board-col', h('div.board-row', evalHost, boardHost)),
    h('aside.panel',
      h('div.trainer-crumbs', h('a.backlink', { href: backHref }, 'Back'), modeTag),
      title,
      h('div.task', status, evalText, goalBox, goalControls),
      h('div.game-notes', sourceNote, bookNote),
      panelSection('Moves', null,
        h('div.sheet-wrap', moves),
        h('div.controls', takebackBtn, restartBtn, h('button.btn', { type: 'button', on: { click: () => board.flip() } }, 'Flip board'))),
      panelSection('Opponent', null,
        h('div.opt-card',
          h('label.opt-row.stack', h('span.opt-label', 'Moves chosen by'), oppSelect),
          h('div.opt-row.stack',
            h('span.opt-label', 'Stockfish’s strength', h('span.opt-help', 'Whenever Stockfish plays: once Lichess players have no games, after your prepared lines, or throughout.')),
            h('div.elo-row', eloInput, eloLabel)),
          evalRow))));
  root.append(page);

  const board = createBoard(boardHost, { orientation: me, onMove: action(onMove) });
  const evalBar = createEvalBar(evalHost);
  evalBar.hide(true);

  const updateElo = () => {
    elo = +eloInput.value;
    eloLabel.textContent = elo >= 3190 ? 'Full strength' : `${elo} Elo`;
  };
  eloInput.addEventListener('input', updateElo);
  updateElo();
  oppSelect.addEventListener('change', () => { opponent = oppSelect.value; renderSource(); });
  evalToggle.addEventListener('change', () => { showEval = evalToggle.checked; evalBar.hide(!showEval); refreshEval(); });

  // ---- game flow ------------------------------------------------------------------------
  const fenNow = () => (history.length ? history[history.length - 1].fen : startFen);
  const myTurn = () => turnColor(fenNow()) === me;
  /** Whether the game is over, judged on the whole game so that a threefold repetition counts. */
  const gameNow = () => gameStatus(startFen, history.map((m) => m.uci));
  const myMoves = () => history.filter((m) => m.color === mine);
  const strength = () => (elo >= 3190 ? 'full strength' : `${elo} Elo`);
  /** The Lichess database ran out (or could not be asked) earlier in this game. */
  const databaseEnded = () => history.some((m) => m.dbEnd);

  function render() {
    const fen = fenNow();
    const last = history[history.length - 1];
    const st = gameNow();
    board.setPosition(fen, { lastMove: last ? last.uci : undefined, movable: myTurn() && !thinking && !st.over && !finished });
    clear(title, goal ? `Play it out as ${me === 'white' ? 'White' : 'Black'}` : `Spar as ${me === 'white' ? 'White' : 'Black'}`);
    modeTag.textContent = goal ? `Play it out · ${Math.min(myMoves().length, goal.moves)} of ${goal.moves}` : 'Spar';
    takebackBtn.hidden = !!goal;
    evalRow.hidden = !!goal;
    restartBtn.textContent = goal ? 'Start again' : 'Restart';
    renderMoves();
    renderBook();
    renderSource();
    if (finished) { /* the goal box says how it went */ } else if (st.over) setStatus(st.text, '');
    else if (thinking) setStatus(opponent === 'lichess' && !databaseEnded() ? 'Looking up Lichess games…' : 'Stockfish is thinking…', '');
    else if (myTurn()) setStatus('Your move', goal ? `Keep the position for ${goal.moves - myMoves().length} more of your moves.` : '');
    else setStatus('Waiting for your opponent', '');
    refreshEval();
  }

  function setStatus(text, sub) {
    clear(status, h('div.prompt-title', text), sub ? h('div.prompt-sub', sub) : null);
  }

  function renderMoves() {
    const rows = [];
    const slip = finished ? biggestSlip(myMoves()) : null;
    history.forEach((m, i) => {
      const num = +m.before.split(' ')[5];
      if (m.color === 'w' || i === 0) {
        const row = h('li', h('span.sheet-num', `${num}.`));
        if (m.color === 'b') row.append(h('span.sheet-move.sheet-gap', '…'));
        rows.push(row);
      }
      const cls = `${m.color === mine ? '.mine' : ''}${m === slip ? '.slip' : ''}`;
      rows[rows.length - 1].append(h(`span.sheet-move${cls}`, { title: m === slip ? 'Your biggest slip' : null }, fig(m.san)));
    });
    clear(moves, rows);
    moves.parentElement.scrollTop = moves.parentElement.scrollHeight;
  }

  function bookReplies(fen) {
    if (!model) return [];
    const nodes = model.nodesByPosition.get(positionKey(fen)) || [];
    const replies = new Map();
    for (const n of nodes) for (const c of n.children) replies.set(c.uci, c);
    return [...replies.values()];
  }

  function renderBook() {
    if (!model) { bookNote.textContent = ''; return; }
    const inBook = model.nodesByPosition.has(positionKey(fenNow()));
    if (inBook) bookNote.textContent = 'Still inside your repertoire.';
    else if (leftBookAt && leftBookAt.mine) bookNote.textContent = `Out of your repertoire since your move ${leftBookAt.label}.`;
    else if (leftBookAt) bookNote.textContent = `Out of your repertoire since ${leftBookAt.label}: your opponent found a move you have not prepared for.`;
    else bookNote.textContent = 'Beyond your repertoire.';
  }

  /** Where the opponent's last move came from. */
  function renderSource() {
    const last = [...history].reverse().find((m) => m.source);
    const who = `${describeRatings(settings.lichessRatings)}; ${describeSpeeds(settings.lichessSpeeds)}`;
    if (!last) {
      clear(sourceNote, opponent === 'lichess' ? `Lichess players (${who}) choose your opponent’s moves while the database has games, then Stockfish takes over.` : '');
      return;
    }
    const label = sanLabel(last.before, last.uci);
    if (last.source === 'lichess') {
      clear(sourceNote, `Lichess players chose ${label}: played in ${formatShare(last.share)} of ${formatGames(last.games)} games (${who}).`);
    } else if (last.dbEnd === 'no-games') {
      clear(sourceNote, `New position: Lichess players have no games from here, so Stockfish took over at ${strength()}.`);
    } else if (last.dbEnd) {
      clear(sourceNote, `${last.dbEnd} Stockfish is playing instead, at ${strength()}. `, h('a', { href: '#/lichess' }, 'Lichess account'));
    } else if (last.source === 'book') {
      clear(sourceNote, `${label} is one of the replies you prepared for.`);
    } else if (opponent === 'lichess' && databaseEnded()) {
      const ended = /** @type {(typeof history)[number]} */ (history.find((m) => m.dbEnd)); // databaseEnded() found one
      clear(sourceNote, ended.dbEnd === 'no-games'
        ? `Stockfish is playing at ${strength()}: Lichess players have no games from here.`
        : `Stockfish is playing at ${strength()}: Lichess could not be asked.`);
    } else {
      clear(sourceNote);
    }
  }

  async function onMove(from, to) {
    if (!myTurn() || thinking || finished) { render(); return; }
    const fen = fenNow();
    let uci = from + to;
    if (isPromotion(fen, from, to)) uci += await choosePromotion(me);
    const res = playMove(fen, uci);
    if (!res) { render(); return; }
    const prepared = bookReplies(fen).filter((n) => n.color === mine);
    noteBookExit(fen, res, prepared);
    history.push({ ...res, before: fen });
    board.setPosition(res.fen, { lastMove: uci, playSound: true, captured: res.captured });
    if (prepared.length && !prepared.some((n) => n.uci === uci)) {
      toast(`Your repertoire move here was ${prepared.map((n) => fig(n.san)).join(' or ')}.`);
    }
    if (goal && (myMoves().length >= goal.moves || gameNow().over)) { void finishPlayout(); return; }
    void engineTurn();
  }

  function noteBookExit(fen, res, replies) {
    if (leftBookAt || !model) return;
    if (model.nodesByPosition.has(positionKey(fen)) && !replies.some((n) => n.uci === res.uci) && !model.nodesByPosition.has(positionKey(res.fen))) {
      leftBookAt = { label: sanLabel(fen, res.uci), mine: res.color === mine };
    }
  }

  async function engineMove(fen) {
    const firstSearch = !history.some((m) => m.source === 'engine');
    const res = await bestmove(fen, { elo, movetime: settings.sparMoveTime, newGame: firstSearch });
    return { uci: res.move, source: /** @type {const} */ ('engine') };
  }

  /** The opponent's move, and where it came from. */
  async function chooseMove(fen) {
    const theirs = mine === 'w' ? 'b' : 'w';
    if (opponent === 'book') {
      const replies = bookReplies(fen).filter((n) => n.color === theirs);
      if (replies.length) return { uci: replies[Math.floor(Math.random() * replies.length)].uci, source: /** @type {const} */ ('book') };
    }
    if (opponent === 'lichess' && !databaseEnded()) {
      let data = null;
      let problem = null;
      try { data = await api.lichess.explorer(fen); } catch (err) { problem = err.message; }
      const pick = data ? pickByPopularity(data) : null;
      if (pick && playMove(fen, pick.uci)) return { uci: pick.uci, source: /** @type {const} */ ('lichess'), share: pick.share, games: data.total };
      // A new position (or no Lichess): Stockfish plays the rest of this game.
      return { ...(await engineMove(fen)), dbEnd: problem || 'no-games' };
    }
    return engineMove(fen);
  }

  async function engineTurn() {
    const fen = fenNow();
    if (myTurn() || gameNow().over || finished) { render(); return; }
    thinking = true;
    render();
    const token = gameToken;
    const started = Date.now();
    let move = null;
    try {
      move = await chooseMove(fen);
    } catch (err) {
      toast(`Stockfish: ${err.message}`, 'bad');
    }
    if (token !== gameToken || !page.isConnected) return;
    if (move && move.source !== 'engine') {
      // Book and database moves come back at once: keep the usual pause before they appear.
      const wait = Math.max(250, settings.moveDelay) - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (token !== gameToken || !page.isConnected) return;
    }
    thinking = false;
    const res = move && move.uci ? playMove(fen, move.uci) : null;
    if (!move || !res) { render(); return; }
    if (move.source !== 'book') noteBookExit(fen, res, bookReplies(fen));
    history.push({ ...res, ...move, before: fen });
    board.setPosition(res.fen, { lastMove: res.uci, playSound: true, captured: res.captured });
    if (goal && gameNow().over) { void finishPlayout(); return; }
    render();
  }

  function takeback() {
    if (thinking || goal) return;
    if (!history.length) return;
    history.pop();
    while (history.length && !myTurn()) history.pop();
    recomputeBookExit();
    if (!myTurn()) { render(); void engineTurn(); return; }
    render();
  }

  function recomputeBookExit() {
    leftBookAt = null;
    for (const m of history) noteBookExit(m.before, m, bookReplies(m.before));
  }

  function restart() {
    gameToken++;
    thinking = false;
    finished = false;
    history = [];
    leftBookAt = null;
    clear(goalBox);
    clear(goalControls);
    if (goal) startPlayout();
    render();
    if (!myTurn()) void engineTurn();
  }

  // ---- play it out ---------------------------------------------------------------------
  /** Stockfish's evaluation of a position, in centipawns from your side; null if it is not available. */
  function rate(fen) {
    return evaluate(fen, [], settings.verdictDepth)
      .then((res) => (res.best && res.best.score ? cpFor(res.best.score, mine) : null))
      .catch(() => null);
  }

  /** Stockfish rates the starting position while you play. */
  function startPlayout() {
    const { moves } = /** @type {{ moves: number }} */ (goal); // a play-out has a goal
    clear(goalBox, h('p.fb', `Play ${moves} moves and keep the position. Stockfish is rating where you start…`));
    const token = gameToken;
    startRating = rate(startFen);
    void startRating.then((cp) => {
      if (token !== gameToken || finished || !page.isConnected) return;
      clear(goalBox, h('p.fb', cp == null
        ? `Play ${moves} moves. Stockfish is not available right now, so the result cannot be judged.`
        : `Play ${moves} moves and keep the position: Stockfish rates it ${formatCp(cp)} for you.`));
    });
  }

  async function finishPlayout() {
    const token = gameToken;
    finished = true;
    render();
    const fen = fenNow();
    const st = gameNow();
    const result = st.over ? (st.winner ? (st.winner === mine ? 'win' : 'loss') : 'draw') : null;
    setStatus('Play-out over', 'Stockfish is judging the position…');
    clear(goalControls,
      h('button.btn.primary', { type: 'button', on: { click: restart } }, 'Try again'),
      h('button.btn', { type: 'button', on: { click: keepPlaying } }, 'Keep playing'));
    const startCp = await startRating;
    const endCp = result === 'win' ? 10000 : result === 'loss' ? -10000 : result === 'draw' ? 0 : await rate(fen);
    if (token !== gameToken || !page.isConnected) return;
    if (startCp == null || endCp == null) {
      setStatus('Play-out over', '');
      clear(goalBox, h('p.fb', 'Stockfish is not available right now, so this play-out could not be judged.'));
      return;
    }
    const grade = gradePlayout({ startCp, endCp, result }, settings);
    if (grade.pass) sound.done(); else sound.wrong();
    setStatus(grade.pass ? 'Position kept' : 'The position slipped', '');
    const review = h('p.verdict.muted', 'Checking your moves…');
    clear(goalBox, h(`p.fb.${grade.pass ? 'fb-good' : 'fb-bad'}`, playoutText(grade, startCp, endCp)), review);
    await reviewMoves(review, token);
  }

  function playoutText({ verdict, drop }, startCp, endCp) {
    const span = `${formatCp(startCp)} → ${formatCp(endCp)}`;
    switch (verdict) {
      case 'won': return 'Checkmate: you won the game.';
      case 'lost': return 'Checkmate: you lost the game.';
      case 'drawn': return startCp <= settings.playOutTolerance ? 'The game was drawn from a roughly level position.' : `The game was drawn, but you started at ${formatCp(startCp)}.`;
      case 'improved': return `You improved the position: ${span}.`;
      case 'held': return `You kept the position: ${span}.`;
      default: return `You gave away ${pawns(drop)}: ${span}.`;
    }
  }

  /** Stockfish checks each of your moves; the biggest slip is marked on the scoresheet. */
  async function reviewMoves(el, token) {
    const list = myMoves();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      el.textContent = `Checking your moves: ${i + 1} of ${list.length}…`;
      try {
        const res = await evaluate(m.before, [m.uci], settings.verdictDepth);
        const played = res.moves.find((x) => x.move === m.uci);
        if (res.best && res.best.score && played && played.score) {
          m.loss = Math.max(0, cpFor(res.best.score, mine) - cpFor(played.score, mine));
          m.best = res.best.move;
        }
      } catch (err) {
        if (token === gameToken && el.isConnected) el.textContent = 'Stockfish is not available right now.';
        return;
      }
      if (token !== gameToken || !el.isConnected) return;
    }
    const slip = biggestSlip(list);
    renderMoves();
    el.classList.remove('muted');
    el.textContent = slip
      ? `Your biggest slip: ${sanLabel(slip.before, slip.uci)} gave away ${pawns(slip.loss)}. Stockfish preferred ${sanLabel(slip.before, slip.best)}.`
      : 'None of your moves gave away more than half a pawn.';
  }

  function keepPlaying() {
    goal = null;
    finished = false;
    page.removeAttribute('data-goal');
    clear(goalControls);
    render();
    if (!myTurn()) void engineTurn();
  }

  // ---- evaluation ----------------------------------------------------------------------
  function refreshEval() {
    if (evalRun) { evalRun.stop(); evalRun = null; }
    if (!showEval || goal) { evalText.textContent = ''; return; }
    const fen = fenNow();
    evalText.textContent = 'Evaluating…';
    evalRun = analyse(fen, { multipv: 1, depth: 18 }, (msg) => {
      const top = msg.lines && msg.lines[0];
      if (!top || fenNow() !== fen) return;
      evalBar.update(evalBarShare(top.score), formatScore(top.score), me === 'black');
      evalText.textContent = `${formatScore(top.score)} at depth ${top.depth}: ${formatSanLine(uciLineToSan(fen, top.pv, 6))}`;
    }, (err) => {
      if (fenNow() === fen) evalText.textContent = err.message;
    });
  }

  restart();

  return () => {
    gameToken++;
    if (evalRun) evalRun.stop();
    board.destroy();
  };
}
