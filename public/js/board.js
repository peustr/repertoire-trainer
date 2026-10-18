// Chessboard: lichess's chessground for the UI, chess.js for the rules.

import { Chessground } from '@lichess-org/chessground';
import { Chess } from 'chess.js';
import { h, sound } from './ui.js';

// Display preferences from Settings → Display and sound.
const prefs = { coordinates: true, showDests: true, animation: 220 };
const live = new Set();
export function setBoardPrefs(p) {
  Object.assign(prefs, p);
  for (const b of live) b.applyPrefs();
}

const SQUARES = 'abcdefgh'.split('').flatMap((f) => '12345678'.split('').map((r) => f + r));

export function legalDests(chess) {
  const dests = new Map();
  for (const sq of SQUARES) {
    const moves = chess.moves({ square: sq, verbose: true });
    if (moves.length) dests.set(sq, [...new Set(moves.map((m) => m.to))]);
  }
  return dests;
}

export function turnColor(fen) {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/**
 * createBoard(container, { orientation, onMove(from, to) })
 * Returns a controller. The board never changes position by itself: the
 * caller decides whether a move stands, via setPosition().
 */
export function createBoard(container, { orientation = 'white', onMove } = {}) {
  const wrap = h('div.board-frame', h('div.board-squares'));
  const el = wrap.firstChild;
  container.append(wrap);
  const chess = new Chess();
  let current = { fen: chess.fen(), movable: false };

  const cg = Chessground(el, {
    orientation,
    coordinates: prefs.coordinates,
    animation: { enabled: prefs.animation > 0, duration: prefs.animation },
    highlight: { lastMove: true, check: true },
    movable: { free: false, color: undefined, showDests: prefs.showDests, events: { after: (orig, dest) => onMove && onMove(orig, dest) } },
    premovable: { enabled: false },
    draggable: { showGhost: true },
    drawable: {
      enabled: true,
      visible: true,
      defaultSnapToValidMove: true,
      // App arrows in the palette: flame for "play this", bark for hints. PGN arrows keep their own colours.
      brushes: {
        flame: { key: 'fl', color: '#eb5e28', opacity: 0.9, lineWidth: 10 },
        bark: { key: 'bk', color: '#403d39', opacity: 0.7, lineWidth: 10 },
      },
    },
  });

  const ro = new ResizeObserver(() => cg.redrawAll());
  ro.observe(wrap);

  function setPosition(fen, { lastMove, movable = false, check, playSound = false, captured = false } = {}) {
    chess.load(fen, { skipValidation: true });
    current = { fen, movable };
    const color = turnColor(fen);
    cg.set({
      fen: fen.split(' ')[0],
      turnColor: color,
      lastMove: lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined,
      check: check !== undefined ? check : chess.inCheck() ? color : false,
      movable: movable
        ? { color, dests: legalDests(chess), free: false }
        : { color: undefined, dests: new Map() },
    });
    if (playSound) (captured ? sound.capture : sound.move)();
  }

  const controller = {
    cg,
    el: wrap,
    setPosition,
    applyPrefs() {
      cg.set({ coordinates: prefs.coordinates, animation: { enabled: prefs.animation > 0, duration: prefs.animation }, movable: { showDests: prefs.showDests } });
      cg.redrawAll();
    },
    setOrientation: (o) => cg.set({ orientation: o }),
    orientation: () => cg.state.orientation,
    flip: () => cg.toggleOrientation(),
    fen: () => current.fen,
    setShapes: (shapes) => cg.setAutoShapes(shapes || []),
    clearUserShapes: () => cg.setShapes([]),
    setMovable(on) { setPosition(current.fen, { movable: on, lastMove: cg.state.lastMove ? cg.state.lastMove.join('') : undefined }); },
    flash(square, kind = 'wrong') {
      cg.set({ highlight: { custom: new Map([[square, kind]]) } });
      setTimeout(() => cg.set({ highlight: { custom: new Map() } }), 650);
    },
    shake() {
      wrap.classList.remove('shake');
      void wrap.offsetWidth;
      wrap.classList.add('shake');
    },
    destroy() { live.delete(controller); ro.disconnect(); cg.destroy(); wrap.remove(); },
  };
  live.add(controller);
  return controller;
}

/** Is this from→to a pawn reaching the last rank? */
export function isPromotion(fen, from, to) {
  const c = new Chess();
  c.load(fen, { skipValidation: true });
  const piece = c.get(from);
  return !!piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1');
}

/** Ask which piece to promote to. Resolves to 'q' | 'r' | 'b' | 'n'. */
export function choosePromotion(color) {
  return new Promise((resolve) => {
    const glyph = color === 'white' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
    const dlg = h('dialog.modal.promo',
      h('div.modal-inner',
        h('h2.modal-title', 'Promote to'),
        h('div.promo-row', Object.entries(glyph).map(([p, g]) => h('button.promo-btn', {
          type: 'button',
          'aria-label': { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p],
          on: { click: () => { dlg.close(); dlg.remove(); resolve(p); } },
        }, g + '︎')))));
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve('q'); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Apply a UCI move to a FEN. Returns { fen, san, captured, uci } or null. */
export function applyUci(fen, uci) {
  const c = new Chess();
  try {
    c.load(fen, { skipValidation: true });
    const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { fen: c.fen(), san: mv.san, captured: !!mv.captured, uci, color: mv.color };
  } catch (err) {
    return null;
  }
}

/** SAN → { uci, fen } in a position, or null. */
export function sanToUci(fen, san) {
  const c = new Chess();
  try {
    c.load(fen, { skipValidation: true });
    const mv = c.move(san, { strict: false });
    return { uci: mv.from + mv.to + (mv.promotion || ''), fen: c.fen() };
  } catch (err) {
    return null;
  }
}

export function gameStatus(fen) {
  const c = new Chess();
  c.load(fen, { skipValidation: true });
  if (c.isCheckmate()) return { over: true, text: `Checkmate — ${c.turn() === 'w' ? 'Black' : 'White'} wins`, winner: c.turn() === 'w' ? 'b' : 'w' };
  if (c.isStalemate()) return { over: true, text: 'Stalemate — draw' };
  if (c.isInsufficientMaterial()) return { over: true, text: 'Insufficient material — draw' };
  if (c.isThreefoldRepetition && c.isThreefoldRepetition()) return { over: true, text: 'Threefold repetition — draw' };
  if (c.isDraw()) return { over: true, text: 'Draw' };
  return { over: false };
}

/** A vertical eval bar. update(score) with a White-POV score. */
export function createEvalBar(container) {
  const fill = h('div.evalbar-fill');
  const label = h('div.evalbar-label', '');
  const bar = h('div.evalbar', { role: 'meter', 'aria-label': 'Engine evaluation', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill, label);
  container.append(bar);
  return {
    el: bar,
    update(share, text, flipped) {
      const pct = Math.round(share * 1000) / 10;
      fill.style.height = `${pct}%`; // White's share, anchored at White's end of the bar
      bar.classList.toggle('flipped', !!flipped);
      bar.setAttribute('aria-valuenow', pct);
      label.textContent = text;
      label.classList.toggle('top', flipped ? share > 0.5 : share < 0.5);
      label.classList.toggle('onlight', share >= 0.5);
    },
    hide(on) { bar.classList.toggle('hidden', on); },
  };
}
