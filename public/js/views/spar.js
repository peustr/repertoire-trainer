// Spar: play a position out against Stockfish at a chosen strength.
// While the game is still inside your repertoire, the opponent can pick from
// the replies you prepared for — so you also practise what happens after them.

import { h, clear, fig, toast, uciLineToSan, formatSanLine } from '../ui.js';
import { state, getRep, modelFor } from '../store.js';
import { positionKey } from '../pgn.js';
import { createBoard, createEvalBar, isPromotion, choosePromotion, applyUci, gameStatus, turnColor } from '../board.js';
import { bestmove, analyse, formatScore, evalBarShare } from '../engine-client.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export async function renderSpar(root, { fen, color, id, back }) {
  const startFen = fen || START;
  const me = color === 'black' ? 'black' : 'white';
  const rep = id ? await getRep(id).catch(() => null) : null;
  const model = rep ? modelFor(rep) : null;
  const backHref = back || (rep ? `#/rep/${rep.id}` : '#/');

  let elo = state.settings.sparElo;
  let history = []; // [{ fen, uci, san, color, captured }]
  let thinking = false;
  let showEval = false;
  let followBook = !!model && state.settings.sparFollowBook;
  let evalRun = null;
  let gameToken = 0;
  let leftBookAt = null;

  // ---- layout -------------------------------------------------------------------------
  const page = h('div.page.spar');
  const evalHost = h('div.eval-host');
  const boardHost = h('div.board-host');
  const status = h('div.prompt', { 'aria-live': 'polite' });
  const bookNote = h('p.book-note');
  const moves = h('ol.scoresheet');
  const evalText = h('p.final-eval.muted');
  const eloLabel = h('output.elo-value');
  const eloInput = h('input', { type: 'range', min: 1320, max: 3190, step: 10, value: String(elo), 'aria-label': 'Stockfish strength' });
  const bookToggle = h('input', { type: 'checkbox', checked: followBook, disabled: !model });
  const evalToggle = h('input', { type: 'checkbox', checked: showEval });

  page.append(
    h('div.board-col', h('div.board-row', evalHost, boardHost)),
    h('aside.panel',
      h('div.trainer-crumbs', h('a.backlink', { href: backHref }, 'Back'), h('span.mode-tag', 'Spar')),
      h('h1.line-title', `You play ${me === 'white' ? 'White' : 'Black'} against Stockfish`),
      status,
      bookNote,
      h('label.field', h('span.field-label', 'Strength'), h('div.elo-row', eloInput, eloLabel)),
      h('label.check', bookToggle, h('span', 'Opponent plays your prepared lines while it can')),
      h('label.check', evalToggle, h('span', 'Show evaluation')),
      evalText,
      h('div.controls',
        h('button.btn', { type: 'button', on: { click: takeback } }, 'Take back'),
        h('button.btn.ghost', { type: 'button', on: { click: restart } }, 'Restart'),
        h('button.btn.ghost', { type: 'button', on: { click: () => board.flip() } }, 'Flip')),
      h('div.sheet-wrap', moves)));
  root.append(page);

  const board = createBoard(boardHost, { orientation: me, onMove });
  const evalBar = createEvalBar(evalHost);
  evalBar.hide(true);

  const updateElo = () => {
    elo = +eloInput.value;
    eloLabel.textContent = elo >= 3190 ? 'Full strength' : `${elo} Elo`;
  };
  eloInput.addEventListener('input', updateElo);
  updateElo();
  bookToggle.addEventListener('change', () => { followBook = bookToggle.checked; });
  evalToggle.addEventListener('change', () => { showEval = evalToggle.checked; evalBar.hide(!showEval); refreshEval(); });

  // ---- game flow ------------------------------------------------------------------------
  const fenNow = () => (history.length ? history[history.length - 1].fen : startFen);
  const myTurn = () => turnColor(fenNow()) === me;

  function render() {
    const fen = fenNow();
    const last = history[history.length - 1];
    const st = gameStatus(fen);
    board.setPosition(fen, { lastMove: last ? last.uci : undefined, movable: myTurn() && !thinking && !st.over });
    renderMoves();
    renderBook();
    if (st.over) setStatus(st.text, '');
    else if (thinking) setStatus('Stockfish is thinking…', '');
    else if (myTurn()) setStatus('Your move', '');
    else setStatus('Waiting for Stockfish', '');
    refreshEval();
  }

  function setStatus(title, sub) {
    clear(status, h('div.prompt-title', title), sub ? h('div.prompt-sub', sub) : null);
  }

  function renderMoves() {
    const rows = [];
    let fen = startFen;
    history.forEach((m, i) => {
      const num = +fen.split(' ')[5];
      if (m.color === 'w' || i === 0) {
        const row = h('li', h('span.sheet-num', `${num}.`));
        if (m.color === 'b') row.append(h('span.sheet-move.sheet-gap', '…'));
        rows.push(row);
      }
      rows[rows.length - 1].append(h(`span.sheet-move${(m.color === 'w') === (me === 'white') ? '.mine' : ''}`, fig(m.san)));
      fen = m.fen;
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
    else if (leftBookAt) bookNote.textContent = `Out of your repertoire since ${leftBookAt}.`;
    else bookNote.textContent = 'Beyond your repertoire.';
  }

  async function onMove(from, to) {
    if (!myTurn() || thinking) { render(); return; }
    const fen = fenNow();
    let uci = from + to;
    if (isPromotion(fen, from, to)) uci += await choosePromotion(me);
    const res = applyUci(fen, uci);
    if (!res) { render(); return; }
    const prepared = bookReplies(fen).filter((n) => n.color === (me === 'white' ? 'w' : 'b'));
    noteBookExit(fen, res, prepared);
    history.push(res);
    board.setPosition(res.fen, { lastMove: uci, playSound: true, captured: res.captured });
    if (prepared.length && !prepared.some((n) => n.uci === uci)) {
      toast(`Your repertoire move here was ${prepared.map((n) => fig(n.san)).join(' or ')}.`);
    }
    engineTurn();
  }

  function noteBookExit(fen, res, replies) {
    if (leftBookAt || !model) return;
    if (model.nodesByPosition.has(positionKey(fen)) && !replies.some((n) => n.uci === res.uci) && !model.nodesByPosition.has(positionKey(res.fen))) {
      const num = +fen.split(' ')[5];
      leftBookAt = res.color === 'w' ? `${num}.${fig(res.san)}` : `${num}...${fig(res.san)}`;
    }
  }

  async function engineTurn() {
    const fen = fenNow();
    if (myTurn() || gameStatus(fen).over) { render(); return; }
    thinking = true;
    render();
    const token = gameToken;
    let uci = null;
    let fromBook = false;
    if (followBook) {
      const replies = bookReplies(fen).filter((n) => n.color === (me === 'white' ? 'b' : 'w'));
      if (replies.length) {
        uci = replies[Math.floor(Math.random() * replies.length)].uci;
        fromBook = true;
        await new Promise((r) => setTimeout(r, Math.max(250, state.settings.moveDelay)));
      }
    }
    if (!uci) {
      try {
        const res = await bestmove(fen, { elo, movetime: state.settings.sparMoveTime, newGame: history.length <= 1 });
        uci = res.move;
      } catch (err) {
        toast(`Stockfish: ${err.message}`, 'bad');
      }
    }
    if (token !== gameToken || !page.isConnected) return;
    thinking = false;
    if (!uci) { render(); return; }
    const res = applyUci(fen, uci);
    if (!res) { render(); return; }
    if (!fromBook) noteBookExit(fen, res, bookReplies(fen));
    history.push(res);
    board.setPosition(res.fen, { lastMove: uci, playSound: true, captured: res.captured });
    render();
  }

  function takeback() {
    if (thinking) return;
    if (!history.length) return;
    history.pop();
    while (history.length && !myTurn()) history.pop();
    if (!myTurn()) { render(); engineTurn(); return; }
    recomputeBookExit();
    render();
  }

  function recomputeBookExit() {
    leftBookAt = null;
    let fen = startFen;
    for (const m of history) {
      noteBookExit(fen, m, bookReplies(fen));
      fen = m.fen;
    }
  }

  function restart() {
    gameToken++;
    thinking = false;
    history = [];
    leftBookAt = null;
    render();
    if (!myTurn()) engineTurn();
  }

  function refreshEval() {
    if (evalRun) { evalRun.stop(); evalRun = null; }
    if (!showEval) { evalText.textContent = ''; return; }
    const fen = fenNow();
    evalText.textContent = 'Evaluating…';
    evalRun = analyse(fen, { multipv: 1, depth: 18 }, (msg) => {
      const top = msg.lines && msg.lines[0];
      if (!top || fenNow() !== fen) return;
      evalBar.update(evalBarShare(top.score), formatScore(top.score), me === 'black');
      evalText.textContent = `${formatScore(top.score)} at depth ${top.depth}: ${formatSanLine(uciLineToSan(fen, top.pv, 6))}`;
    });
  }

  restart();

  return () => {
    gameToken++;
    if (evalRun) evalRun.stop();
    board.destroy();
  };
}
