// App shell: header and routing.

import { h, clear } from './ui.js';
import { loadSettings } from './store.js';
import { onEngineStatus, engineReady } from './engine-client.js';
import { renderLibrary } from './views/library.js';
import { renderRepertoire } from './views/repertoire-view.js';
import { renderImport } from './views/import-view.js';
import { renderTrainer } from './views/trainer.js';
import { renderExplore } from './views/explore.js';
import { renderSpar } from './views/spar.js';
import { renderPuzzles } from './views/puzzles-view.js';
import { renderLichess } from './views/lichess-view.js';
import { renderSettings } from './views/settings-view.js';

const main = document.getElementById('main');
let cleanup = null;

const routes = [
  [/^#?\/?$/, () => renderLibrary(main)],
  [/^#\/import$/, () => renderImport(main, {})],
  [/^#\/edit\/([\w-]+)$/, (m) => renderImport(main, { id: m[1] })],
  [/^#\/rep\/([\w-]+)$/, (m) => renderRepertoire(main, { id: m[1] })],
  [/^#\/train\/([\w-]+)\/(review|learn|practice)(?:\/([\w-]+))?$/, (m, q) => renderTrainer(main, { id: m[1], mode: m[2], target: m[3], chapter: q.get('chapter') })],
  [/^#\/explore\/([\w-]+)$/, (m, q) => renderExplore(main, { id: m[1], node: q.get('node'), line: q.get('line'), moves: q.get('moves') })],
  [/^#\/puzzles\/([\w-]+)$/, (m, q) => renderPuzzles(main, { id: m[1], ids: q.get('ids') })],
  [/^#\/settings(?:\/(\w+))?$/, (m) => renderSettings(main, { section: m[1] })],
  [/^#\/lichess$/, (m, q) => renderLichess(main, { connected: q.get('connected'), error: q.get('error') })],
  [/^#\/spar$/, (m, q) => renderSpar(main, { fen: q.get('fen'), color: q.get('color'), id: q.get('rep'), back: q.get('back') })],
];

async function route() {
  if (cleanup) { try { cleanup(); } catch (err) { console.error(err); } cleanup = null; }
  // Dialogs belong to the page that opened them.
  for (const d of document.querySelectorAll('dialog')) { if (d.open) d.close(); d.remove(); }
  const [path, query = ''] = location.hash.split('?');
  const q = new URLSearchParams(query);
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      clear(main);
      main.dataset.view = '';
      try {
        cleanup = (await fn(m, q)) || null;
      } catch (err) {
        console.error(err);
        clear(main, h('div.page', h('div.empty', h('h1.page-title', 'Something went wrong'), h('p', err.message), h('a.btn', { href: '#/' }, 'Back to the library'))));
      }
      updateNav(path);
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

function updateNav(path) {
  const p = path || '#/';
  for (const a of document.querySelectorAll('.nav a')) {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === '#/' ? p === '#/' || p === '#' : p.startsWith(href));
  }
}

// --- header ---------------------------------------------------------------------

function header() {
  const status = h('span.engine-status', { title: 'Stockfish status' }, h('span.dot'), h('span.engine-label', 'Engine'));
  onEngineStatus((s) => {
    status.classList.toggle('online', s.connected);
    const a = s.engine && s.engine.analysis;
    status.lastChild.textContent = !s.connected ? 'Engine offline' : a ? (a.name || 'Stockfish') : 'Stockfish';
  });
  return h('header.topbar',
    h('a.wordmark', { href: '#/', 'aria-label': 'Repertoire Trainer home' },
      h('span.wordmark-mark', { 'aria-hidden': 'true' }, '♞︎'),
      h('span.wordmark-text', 'Repertoire')),
    h('nav.nav',
      h('a', { href: '#/' }, 'Library'),
      h('a', { href: '#/import' }, 'Add repertoire'),
      h('a', { href: '#/lichess' }, 'Lichess'),
      h('a', { href: '#/settings' }, 'Settings')),
    status);
}

// --- boot -------------------------------------------------------------------------------

async function boot() {
  document.getElementById('app').prepend(header());
  try {
    await loadSettings();
  } catch (err) {
    clear(main, h('div.page', h('div.empty', h('h1.page-title', 'The local server is not responding'), h('p', 'Start it with start.bat (or "npm start") and reload this page.'))));
    return;
  }
  engineReady();
  window.addEventListener('hashchange', route);
  route();
}

boot();
