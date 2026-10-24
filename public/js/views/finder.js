// The opponent-mistake finder: a live view of the tree search, opened from any
// position you are learning.

import { h, clear, sanLabel, fig, plural, sound, lineTail } from '../ui.js';
import { state, loadLichess } from '../store.js';
import { searchMistakes, onLichessNotice } from '../engine-client.js';
import { formatGames, formatShare, describeRatings, describeSpeeds, describeReach } from '../puzzle-utils.js';

/**
 * @param {{ rep: any, fen: string, prefix: { startFen: string, moves: string[] }, where: string, onSaved?: () => void }} options
 *   onSaved runs when the dialog closes after the search saved puzzles or gaps. The repertoire
 *   page passes its redraw; a board page must not redraw, or a session in progress restarts.
 */
export async function openMistakeFinder({ rep, fen, prefix, where, onSaved = () => {} }) {
  await loadLichess();
  const close = () => {
    if (search) search.stop();
    dlg.close();
    dlg.remove();
    if (found.length || gapCount) onSaved();
  };
  let search = null;
  const found = [];
  let gapCount = 0;

  const dlg = h('dialog.modal.finder');
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('close', () => { if (search) search.stop(); });
  document.body.append(dlg);

  if (!state.lichess.connected) {
    clear(dlg, h('div.modal-inner',
      h('h2.modal-title', 'Connect Lichess first'),
      h('p.muted', 'The search reads the Lichess opening explorer to see what players at your level actually play, and Lichess only answers signed-in apps. Connecting takes a few seconds and needs no special permissions.'),
      h('div.modal-actions',
        h('button.btn', { type: 'button', on: { click: close } }, 'Not now'),
        h('a.btn.primary', { href: '#/lichess', on: { click: () => { dlg.close(); dlg.remove(); } } }, 'Connect Lichess'))));
    dlg.showModal();
    return;
  }

  const s = state.settings;
  const progress = h('progress', { max: s.puzzlePositions, value: 0 });
  const progressLabel = h('span.finder-count', 'Starting…');
  const looking = h('p.finder-looking.muted', '');
  const foundList = h('ol.finder-found');
  const gapList = h('ul.finder-gaps');
  const gapBlock = h('section.finder-section', { hidden: true }, h('h3.finder-h', 'Popular replies you have no line for'), gapList);
  const foundHead = h('h3.finder-h', 'Mistakes found');
  const empty = h('p.muted.finder-empty', 'Nothing yet. Popular replies are being checked one position at a time.');
  const solveBtn = h('a.btn.primary', { hidden: true }, 'Solve');
  const stopBtn = h('button.btn', { type: 'button', on: { click: () => { if (search) search.stop(); stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; } } }, 'Stop');
  const notice = h('p.finder-notice', { hidden: true });

  clear(dlg, h('div.modal-inner',
    h('h2.modal-title', 'Opponent mistakes from here'),
    h('p.finder-sub', where ? `${where}. ` : '', `Lichess rated ${describeSpeeds(s.lichessSpeeds)}, ${describeRatings(s.lichessRatings)}${s.lichessSince ? ` since ${s.lichessSince}` : ''}. Budget ${s.puzzlePositions} positions, mistakes of ${(s.puzzleThreshold / 100).toFixed(1)}+ pawns. `,
      h('a', { href: '#/settings/opponents', on: { click: close } }, 'Opponents'), ' · ', h('a', { href: '#/settings/finder', on: { click: close } }, 'Search settings')),
    h('div.finder-progress', progress, progressLabel),
    looking,
    notice,
    h('section.finder-section', foundHead, empty, foundList),
    gapBlock,
    h('div.modal-actions', stopBtn, h('button.btn.ghost', { type: 'button', on: { click: close } }, 'Close'), solveBtn)));
  dlg.showModal();

  const updateSolve = () => {
    solveBtn.hidden = !found.length;
    solveBtn.textContent = `Solve ${plural(found.length, 'puzzle')}`;
    solveBtn.href = `#/puzzles/${rep.id}?ids=${found.map((p) => p.id).join(',')}`;
    solveBtn.onclick = () => { if (search) search.stop(); dlg.close(); dlg.remove(); };
  };

  const offNotice = onLichessNotice((msg) => {
    if (!msg.until) return;
    notice.hidden = false;
    notice.textContent = `Lichess asked the app to slow down. The search resumes at ${new Date(msg.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.`;
  });

  search = searchMistakes({ repId: rep.id, fen, prefix }, (msg) => {
    if (!notice.hidden && msg.kind === 'progress' && /slow down/.test(notice.textContent)) notice.hidden = true;
    if (msg.kind === 'progress') {
      progress.value = msg.stats.positions;
      progressLabel.textContent = `${msg.stats.positions} of ${msg.budget} positions${msg.stats.cached ? ` (${msg.stats.cached} from cache)` : ''}`;
      const line = msg.at.san.length ? msg.at.san.slice(-6).map((x) => fig(x)).join(' ') : 'the starting position';
      looking.textContent = `Looking at …${line} — ${formatGames(msg.at.games)} games`;
    } else if (msg.kind === 'found') {
      found.push(msg.puzzle);
      empty.hidden = true;
      foundList.append(foundItem(msg.puzzle, rep));
      foundHead.textContent = `Mistakes found (${found.length})`;
      sound.right();
      updateSolve();
    } else if (msg.kind === 'gap') {
      gapCount++;
      gapBlock.hidden = false;
      gapList.append(gapItem(msg.gap, rep, close));
    }
  });

  try {
    const res = await search.promise;
    progressLabel.textContent = `${res.stats.positions} positions checked${res.stats.lookups ? `, ${res.stats.lookups} from Lichess` : ''}`;
    looking.textContent = {
      stopped: 'Stopped.',
      puzzles: `Stopped at ${plural(res.puzzles.length, 'puzzle')}, the limit set under “Stop after finding” in Search settings.`,
      searched: 'Searched every popular line within reach.',
    }[res.ended] || 'Search budget used up. Run it again from a deeper position to go further.';
    if (!found.length) empty.textContent = 'No clear mistakes among the popular replies here. Opponents mostly play this line well; a lower rating band may find more.';
  } catch (err) {
    notice.hidden = false;
    notice.textContent = err.message;
    if (/connect/i.test(err.message)) notice.append(' ', h('a', { href: '#/lichess', on: { click: close } }, 'Open Lichess settings'));
  }
  offNotice();
  stopBtn.hidden = true;
}

function foundItem(p, rep) {
  const mistake = lineTail(p.startFen, p.lineMoves, 3);
  const yourSide = rep.color === 'black' ? 'Black' : 'White';
  return h('li.finder-item',
    h('div.finder-line', h('span.finder-mistake', `${mistake}?`), h('span.finder-theme', p.theme.label)),
    h('div.finder-stats',
      `Played in ${formatShare(p.mistake.share)} of ${formatGames(p.mistake.positionGames)} games`,
      p.mistake.yourScore != null ? ` · ${yourSide} scores ${p.mistake.yourScore}% after it` : '',
      p.reach ? ` · ${describeReach(p.reach)}` : ''),
    h('div.finder-answer.muted', 'Solve it to see the punishment.'));
}

function gapItem(g, rep, close) {
  const label = sanLabel(g.beforeFen, uciOf(g));
  const moves = encodeURIComponent(g.lineMoves.join(','));
  return h('li',
    h('span.finder-mistake', label),
    h('span.muted', ` ${formatShare(g.share)} of games`),
    g.bestReplySan ? h('span.muted', ` · Stockfish answers ${fig(g.bestReplySan)}`) : null,
    h('a.btn.small.ghost', { href: `#/explore/${rep.id}?moves=${moves}`, on: { click: close } }, 'Explore'));
}

function uciOf(g) {
  return g.lineMoves[g.lineMoves.length - 1];
}
