// Small DOM and formatting helpers shared by every view.

import { toFigurine } from './pgn.js';
import { playMove } from './moves.js';

/** h('div.class#id', {attrs, on: {click}}, ...children) */
export function h(tag, attrs, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

/** Like el.append(), but skips null/false so conditional children are easy. */
export function add(el, ...children) {
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// --- page building blocks -----------------------------------------------------------

// Line icons on a 24-unit grid, drawn in the current text colour.
const ICONS = {
  review: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  learn: '<path d="M3.5 5.5c2.8-1 5.6-1 8.5.8 2.9-1.8 5.7-1.8 8.5-.8v13c-2.8-1-5.6-1-8.5.8-2.9-1.8-5.7-1.8-8.5-.8z"/><path d="M12 6.3v13"/>',
  practise: '<path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L19.5 9"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1L4.5 15"/><path d="M4.5 19.5V15H9"/>',
  puzzle: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8"/>',
  surprise: '<path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12z"/>',
  spar: '<path d="M4 4l10.5 10.5M12 17l5-5M15.5 15.5 19.5 19.5"/><path d="M20 4 9.5 14.5M7 12l5 5M8.5 15.5 4.5 19.5"/>',
  playout: '<path d="M5.5 21V4"/><path d="M5.5 4.5h12l-2.5 4 2.5 4h-12"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  explore: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
};

/** A small line icon from the set above; decorative, so hidden from screen readers. */
export function icon(name) {
  return h('span.ico', {
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}

/** A keyboard shortcut shown on a button. Give the button aria-keyshortcuts for screen readers. */
export function kbd(key) {
  return h('kbd', { 'aria-hidden': 'true' }, key);
}

/** Button content with its shortcut: the label sits in its own span so it can be relabelled. */
export function keyed(label, key) {
  return [h('span.btn-label', label), kbd(key)];
}

/** A titled block in a side panel: a small caption, an optional control on its right, then the content. */
export function panelSection(title, aside, ...children) {
  return h('section.psec', h('div.psec-head', h('h2.psec-title', title), aside || null), ...children);
}

/**
 * Actions that each say what they do: a title and one sentence, as a link (href) or a
 * button (onClick). Next to the board they list what you can do from the position, so
 * no tool hides behind a bare label.
 * @param {Array<{ title: string, desc: string, icon: string, href?: string, onClick?: (e: MouseEvent) => any } | null | false>} tools
 */
export function toolList(tools) {
  const items = [];
  for (const t of tools) {
    if (!t) continue;
    items.push(h('li', h(t.href ? 'a.tool' : 'button.tool', { href: t.href || null, type: t.href ? null : 'button', on: t.onClick ? { click: t.onClick } : null },
      icon(t.icon),
      h('span.tool-text', h('span.tool-title', t.title), h('span.tool-desc', t.desc)),
      h('span.tool-go', { 'aria-hidden': 'true' }, '›'))));
  }
  return h('ul.tool-list', items);
}

// --- notation ------------------------------------------------------------------

let figurines = true;
export function setFigurines(on) { figurines = !!on; }
export function useFigurines() { return figurines; }
export function fig(san) { return figurines ? toFigurine(san) : san; }

/** Convert a list of UCI moves to SAN from a FEN. Stops at the first illegal move. */
export function uciLineToSan(fen, ucis, max = 12) {
  const out = [];
  let at = fen;
  for (const u of ucis.slice(0, max)) {
    const mv = playMove(at, u);
    if (!mv) break;
    out.push({ san: mv.san, color: mv.color, number: +(at.split(/\s+/)[5] || 1) });
    at = mv.fen;
  }
  return out;
}

export function formatSanLine(moves) {
  return moves.map((m, i) => (m.color === 'w' ? `${m.number}.${fig(m.san)}` : i === 0 ? `${m.number}...${fig(m.san)}` : fig(m.san))).join(' ');
}

/** "4...h6 5.c3 Nxe4" — the last few moves of a line, ending at the move that matters. */
export function lineTail(startFen, ucis, plies = 3) {
  const all = uciLineToSan(startFen, ucis, 200);
  return formatSanLine(all.slice(-plies));
}

/** Like sanLabel, but always in letters (for PGN text and titles). */
export function plainLabel(fen, uci) {
  const [m] = uciLineToSan(fen, [uci], 1);
  if (!m) return uci;
  return m.color === 'w' ? `${m.number}.${m.san}` : `${m.number}...${m.san}`;
}

export function sanLabel(fen, uci) {
  const [m] = uciLineToSan(fen, [uci], 1);
  if (!m) return uci;
  return m.color === 'w' ? `${m.number}.${fig(m.san)}` : `${m.number}...${fig(m.san)}`;
}

// --- feedback --------------------------------------------------------------------

let toastTimer = null;
export function toast(message, kind = '') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div.toast', { role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

let soundsOn = true;
let audio = null;
let unlocked = false; // browsers only allow audio after the first click or key press
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { unlocked = true; }, { once: true, capture: true });
let volume = 0.6;
export function setSounds(on, vol) { soundsOn = !!on; if (vol != null) volume = Math.max(0, Math.min(1, vol / 100)); }
function tone(freqs, { dur = 0.09, type = 'sine', gain = 0.06, gap = 0.07 } = {}) {
  if (!soundsOn || !unlocked) return;
  try {
    audio = audio || new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
    const t0 = audio.currentTime;
    freqs.forEach((f, i) => {
      const osc = audio.createOscillator();
      const g = audio.createGain();
      osc.type = type;
      osc.frequency.value = f;
      const start = t0 + i * gap;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(Math.max(0.0002, gain * volume * 1.6), start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g).connect(audio.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    });
  } catch (err) { /* audio unavailable */ }
}
export const sound = {
  move: () => tone([220], { dur: 0.05, type: 'triangle', gain: 0.08 }),
  capture: () => tone([180, 140], { dur: 0.06, type: 'triangle', gain: 0.08, gap: 0.03 }),
  right: () => tone([660, 880], { dur: 0.12 }),
  wrong: () => tone([200, 150], { dur: 0.16, type: 'square', gain: 0.03, gap: 0.09 }),
  done: () => tone([523, 659, 784], { dur: 0.16, gap: 0.09 }),
};

/**
 * Wrap an event handler or callback that does async work: a clicked button is
 * disabled while it runs, and a failure is shown to the user instead of vanishing.
 * Read e.currentTarget before the first await; the browser clears it afterwards.
 */
export function action(fn) {
  return async (...args) => {
    const event = args[0];
    const button = event instanceof Event && event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    if (button) button.disabled = true;
    try {
      return await fn(...args);
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : String(err), 'bad');
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  };
}

// --- modal -------------------------------------------------------------------------

export function modal(title, body, actions = []) {
  const close = () => { dialog.close(); dialog.remove(); };
  const dialog = h('dialog.modal',
    h('form.modal-inner', { method: 'dialog' },
      h('h2.modal-title', title),
      h('div.modal-body', body),
      h('div.modal-actions', actions.map((a) => h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
        type: 'button',
        on: { click: async () => { const keep = a.onClick ? await a.onClick() : false; if (keep !== true) close(); } },
      }, a.label)))));
  dialog.addEventListener('cancel', () => setTimeout(() => dialog.remove(), 0));
  document.body.append(dialog);
  dialog.showModal();
  return { close, dialog };
}

export function confirmDialog(title, text, label = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const m = modal(title, h('p', text), [
      { label: 'Cancel', onClick: () => resolve(false) },
      { label, primary: !danger, danger, onClick: () => resolve(true) },
    ]);
    m.dialog.addEventListener('cancel', () => resolve(false));
  });
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/x-chess-pgn' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** Tiny stacked bar of card levels 0 (new) … 8. */
export function levelBar(histogram, { large = false } = {}) {
  const total = histogram.reduce((a, b) => a + b, 0) || 1;
  return h(`div.levelbar${large ? '.large' : ''}`, { role: 'img', 'aria-label': `Memory levels: ${histogram.map((n, i) => `${n} at level ${i}`).join(', ')}` },
    histogram.map((n, i) => (n ? h(`span.lv${i}`, { style: { flexGrow: n / total }, title: `${i === 0 ? 'New' : `Level ${i}`}: ${n}` }) : null)));
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Centipawns as pawns: "1.5 pawns", "1.0 pawn". */
export function pawns(cp) {
  return `${(Math.abs(cp) / 100).toFixed(1)} ${Math.abs(cp) === 100 ? 'pawn' : 'pawns'}`;
}
