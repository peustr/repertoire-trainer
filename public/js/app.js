// App shell: header and routing.

import { h, clear, toast } from './ui.js';
import { loadSettings, flushProgress } from './store.js';
import { setRenderer } from './nav.js';
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
let navigation = 0;

const routes = [
  [/^#?\/?$/, (m, q, root) => renderLibrary(root)],
  [/^#\/import$/, (m, q, root) => renderImport(root, {})],
  [/^#\/edit\/([\w-]+)$/, (m, q, root) => renderImport(root, { id: m[1] })],
  [/^#\/rep\/([\w-]+)$/, (m, q, root) => renderRepertoire(root, { id: m[1] })],
  [/^#\/train\/([\w-]+)\/(review|learn|practice)(?:\/([\w-]+))?$/, (m, q, root) => renderTrainer(root, { id: m[1], mode: m[2], target: m[3], chapter: q.get('chapter') })],
  [/^#\/explore\/([\w-]+)$/, (m, q, root) => renderExplore(root, { id: m[1], line: q.get('line'), moves: q.get('moves') })],
  [/^#\/puzzles\/([\w-]+)$/, (m, q, root) => renderPuzzles(root, { id: m[1], ids: q.get('ids') })],
  [/^#\/settings(?:\/(\w+))?$/, (m, q, root) => renderSettings(root, { section: m[1] })],
  [/^#\/lichess$/, (m, q, root) => renderLichess(root, { connected: q.get('connected'), error: q.get('error') })],
  [/^#\/spar$/, (m, q, root) => renderSpar(root, { fen: q.get('fen'), color: q.get('color'), id: q.get('rep'), back: q.get('back') })],
];

function runCleanup(fn) {
  try { fn(); } catch (err) { console.error(err); }
}

async function route() {
  const token = ++navigation;
  if (cleanup) { runCleanup(cleanup); cleanup = null; }
  // Dialogs belong to the page that opened them.
  for (const d of document.querySelectorAll('dialog')) { if (d.open) d.close(); d.remove(); }
  const [path, query = ''] = location.hash.split('?');
  const q = new URLSearchParams(query);
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    // Each navigation renders into its own container. If the user moves on while this
    // view is still loading, its container is already detached, so it is never seen,
    // and its cleanup runs as soon as it has finished rendering.
    const outlet = h('div.outlet');
    clear(main, outlet);
    let done = null;
    try {
      done = (await fn(m, q, outlet)) || null;
    } catch (err) {
      console.error(err);
      clear(outlet, h('div.page', h('div.empty', h('h1.page-title', 'Something went wrong'), h('p', err.message), h('a.btn', { href: '#/' }, 'Back to the library'))));
    }
    if (token !== navigation) {
      if (done) runCleanup(done);
      return;
    }
    cleanup = done;
    updateNav(path);
    window.scrollTo(0, 0);
    return;
  }
  location.hash = '#/';
}
setRenderer(route);

// Last line of defence: an error nobody caught is shown, not lost in the console.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  toast(`Something went wrong: ${reason && reason.message ? reason.message : reason}`, 'bad');
});
window.addEventListener('error', (event) => {
  if (event.message) toast(`Something went wrong: ${event.message}`, 'bad');
});

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
  await flushProgress(); // answers saved while the server was away, before any page loads its data
  engineReady();
  window.addEventListener('hashchange', route);
  route();
}

boot();
