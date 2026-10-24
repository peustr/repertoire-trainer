// One repertoire: memory state, chapters and lines, PGN tools and the Stockfish audit.

import { h, add, clear, levelBar, plural, toast, confirmDialog, downloadText, useFigurines, action, icon, uciLineToSan, formatSanLine, lineTail } from '../ui.js';
import { state, getRep, modelFor, putRep, dropRep } from '../store.js';
import { refresh } from '../nav.js';
import { repertoireStats, lineStatus, describeWait, isDue, MAX_LEVEL } from '../srs.js';
import { formatSequence } from '../pgn.js';
import { movesTo } from '../repertoire.js';
import { api } from '../api.js';
import { runAudit } from './audit.js';
import { openMistakeFinder } from './finder.js';
import { puzzleStats, puzzleList, puzzleState, formatShare, formatGames, describeReach } from '../puzzle-utils.js';
import { openGaps } from '../opponent.js';

export async function renderRepertoire(root, { id }) {
  const rep = await getRep(id, { fresh: true });
  const model = modelFor(rep);
  const now = Date.now();
  const stats = repertoireStats(model, rep.cards || {}, now);
  const page = h('div.page.repview');
  root.append(page);

  const side = rep.color === 'black' ? 'Black' : 'White';
  const auditBox = h('div.audit', { 'aria-live': 'polite' });
  const pz = puzzleStats(rep, now);
  const gaps = openGaps(rep, model).map(({ key, gap }) => ({ key, ...gap }));

  add(page,
    h('a.backlink', { href: '#/' }, 'Library'),
    h('header.rep-head',
      h('div',
        h('h1.page-title', rep.name),
        h('p.rep-sub', h('span.side-chip', { class: rep.color }), `You play ${side} · ${plural(model.chapters.length, 'chapter')} · ${plural(stats.lines, 'line')} · ${plural(stats.cards, 'move')} to remember`))),
    model.errors.length ? h('section.notice.warn',
      h('h2.section-title', 'Some moves could not be read'),
      h('ul', model.errors.slice(0, 8).map((e) => h('li', e))),
      model.errors.length > 8 ? h('p', `…and ${model.errors.length - 8} more.`) : null) : null,
    h('section.rep-section', h('h2.caption', 'Train'), modeCards(rep, stats, pz, gaps.length)),
    h('section.rep-section', h('h2.caption', 'Memory'), memoryPanel(rep, stats)),
    h('section.rep-section', h('h2.caption', 'Opponent mistakes and gaps'), opponentsPanel(rep, model, pz, gaps)),
    h('section.rep-section', h('h2.caption', 'Stockfish audit'), auditBox),
    h('section.rep-section', h('h2.caption', 'Chapters and lines'), h('div.chapters', model.chapters.map((ch) => chapterBlock(rep, model, ch, now)))),
    toolsPanel(rep));

  renderAuditSummary(auditBox, rep, model);
  return null;
}

/** Every way to train this repertoire, each saying what it does and what is waiting. */
function modeCards(rep, stats, pz, gaps) {
  const id = rep.id;
  const wait = isFinite(stats.nextDue) ? describeWait(stats.nextDue - Date.now()) : null;
  const batch = Math.min(stats.newLines, state.settings.learnBatch);
  const modes = [
    {
      icon: 'review', name: 'Review', href: stats.dueLines ? `#/train/${id}/review` : null,
      stat: stats.dueLines ? `${plural(stats.dueLines, 'line')} due` : wait ? `Next in ${wait}` : 'Nothing learned yet',
      desc: 'Lines with moves you are about to forget. The moves you still know play themselves.',
    },
    {
      icon: 'learn', name: 'Learn', href: stats.newLines ? `#/train/${id}/learn` : null,
      stat: stats.newLines ? plural(stats.newLines, 'new line') : 'All learned',
      desc: stats.newLines
        ? `New lines play out with arrows and comments, then you repeat them from memory. ${plural(batch, 'line')} per session.`
        : 'New lines play out with arrows and comments, then you repeat them from memory.',
    },
    {
      icon: 'practise', name: 'Practise', href: stats.learnedLines ? `#/train/${id}/practice` : null,
      stat: stats.learnedLines ? plural(stats.learnedLines, 'line') : 'Learn lines first',
      desc: 'Every learned line, every move quizzed, in shuffled or chapter order. Your schedule is not touched.',
    },
    {
      icon: 'puzzle', name: 'Puzzles', href: pz.ready ? `#/puzzles/${id}` : null,
      stat: pz.ready ? `${pz.ready} ready` : pz.total ? 'None due' : 'None yet',
      desc: pz.total ? 'Punish the mistakes Lichess players make in your lines, on their own review schedule.' : 'Find opponent mistakes below, and the common ones become puzzles here.',
    },
    {
      icon: 'surprise', name: 'Surprise drills', href: stats.lines ? `#/surprise/${id}` : null,
      stat: gaps ? plural(gaps, 'saved gap') : '',
      desc: 'Your opponent leaves your book with a reply you have not prepared. Find a good answer; Stockfish grades it.',
    },
    {
      icon: 'spar', name: 'Spar', href: `#/spar?color=${rep.color}&rep=${id}&back=${encodeURIComponent(`#/rep/${id}`)}`,
      stat: '',
      desc: 'A game from the first move against Lichess players at your rating, your prepared lines or Stockfish.',
    },
    {
      icon: 'explore', name: 'Explore', href: `#/explore/${id}`,
      stat: '',
      desc: 'Browse your repertoire tree with Stockfish and the Lichess opening explorer, and try your own ideas.',
    },
  ];
  // The one to do next stands out: reviews first, then new lines.
  const next = modes.find((m) => (m.icon === 'review' || m.icon === 'learn') && m.href);
  return h('div.modes', modes.map((m) => h(`${m.href ? 'a' : 'div'}.mode${m === next ? '.primary' : ''}${m.href ? '' : '.idle'}`, { href: m.href },
    icon(m.icon),
    h('span.mode-name', m.name, m.stat ? h('span.mode-stat', m.stat) : null),
    h('span.mode-desc', m.desc))));
}

function memoryPanel(rep, stats) {
  const labels = ['New', ...Array.from({ length: MAX_LEVEL }, (_, i) => `L${i + 1}`)];
  const history = (rep.history || []).slice(-28);
  const max = Math.max(1, ...history.map((d) => d.correct + d.wrong));
  return h('div.memory',
    h('div.memory-bar',
      h('h3.section-title', 'Moves by level'),
      levelBar(stats.histogram, { large: true }),
      h('ol.memory-legend', stats.histogram.map((n, i) => h('li', h(`span.swatch.lv${i}`), `${labels[i]} `, h('b', n))))),
    h('div.memory-stats',
      stat(stats.dueCards, 'moves due now'),
      stat(stats.newLines, 'lines not yet learned'),
      stat(isFinite(stats.nextDue) ? describeWait(stats.nextDue - Date.now()) : '—', 'until the next review opens')),
    history.length ? h('div.activity',
      h('h3.section-title', 'Last four weeks'),
      h('div.activity-bars', { role: 'img', 'aria-label': 'Moves answered per day' }, history.map((d) => h('span.activity-day', {
        title: `${d.date}: ${d.correct} right, ${d.wrong} wrong`,
        style: { height: `${Math.max(8, ((d.correct + d.wrong) / max) * 100)}%`, '--wrong': `${(d.wrong / Math.max(1, d.correct + d.wrong)) * 100}%` },
      })))) : null);
}

function stat(value, label) {
  return h('div.stat', h('span.stat-value', String(value)), h('span.stat-label', label));
}

function chapterBlock(rep, model, chapter, now) {
  const cards = rep.cards || {};
  const flagged = new Set(Object.keys((rep.audit && rep.audit.flags) || {}));
  return h('details.chapter', { open: model.chapters.length <= 4 },
    h('summary',
      h('span.chapter-name', chapter.name),
      h('span.chapter-meta', plural(chapter.lines.length, 'line')),
      h('button.btn.small.ghost', { type: 'button', title: 'Search Lichess games for common opponent mistakes in this chapter', on: { click: action((e) => { e.preventDefault(); e.stopPropagation(); return findInChapter(rep, chapter); }) } }, 'Find mistakes'),
      h('a.btn.small.ghost', { href: `#/train/${rep.id}/practice?chapter=${chapter.index}`, on: { click: (e) => e.stopPropagation() } }, 'Practise chapter')),
    h('table.lines',
      h('colgroup', h('col.c-num'), h('col.c-moves'), h('col.c-strength'), h('col.c-when'), h('col.c-actions')),
      h('thead', h('tr', h('th', '#'), h('th', 'Ends with'), h('th', 'Strength'), h('th', 'Review'), h('th', h('span.visually-hidden', 'Actions')))),
      h('tbody', chapter.lines.map((line) => {
        const st = lineStatus(line, cards, now);
        const doubts = line.cardKeys.filter((k) => flagged.has(k)).length;
        return h('tr', { class: st.isNew ? 'is-new' : st.isDue ? 'is-due' : '' },
          h('td.num', line.number),
          h('td.moves', formatSequence(line.nodes.slice(-4), useFigurines()), doubts ? h('span.flag', { title: 'Stockfish doubts a move in this line' }, ' ⚑') : null),
          h('td', strengthPips(st.minLevel, st.isNew)),
          h('td.when', st.isNew ? 'New' : st.isDue ? 'Due' : describeWait(st.nextDue - now)),
          h('td.row-actions',
            h('a.btn.small', { href: `#/train/${rep.id}/${st.isNew ? 'learn' : 'practice'}/${line.id}` }, st.isNew ? 'Learn' : 'Practise'),
            h('a.btn.small.ghost', { href: `#/explore/${rep.id}?line=${line.id}` }, 'Explore')));
      }))));
}

/** Start the search where the chapter's lines start to branch. */
function findInChapter(rep, chapter) {
  let n = chapter.root;
  const moves = [];
  while (n.children.length === 1) { n = n.children[0]; moves.push(n.uci); }
  const sans = uciLineToSan(chapter.root.fen, moves, 80);
  return openMistakeFinder({
    rep,
    fen: n.fen,
    prefix: { startFen: chapter.root.fen, moves },
    where: sans.length ? `${chapter.name}, from ${formatSanLine(sans.slice(-6))}` : chapter.name,
    onSaved: refresh,
  });
}

/** @param {{ key: string, [field: string]: any }[]} gaps  the saved gaps still unanswered, likeliest first */
function opponentsPanel(rep, model, pz, gaps) {
  const list = puzzleList(rep).sort((a, b) => (b.reach || 0) - (a.reach || 0));
  const start = model.chapters[0];
  const searchAll = action(() => openMistakeFinder({ rep, fen: start.root.fen, prefix: { startFen: start.root.fen, moves: [] }, where: 'Whole repertoire', onSaved: refresh }));
  if (!list.length && !gaps.length) {
    return h('div.opponents',
      h('div.audit-head',
        h('div',
          h('h3.section-title', 'Punish what your opponents actually play'),
          h('p.muted', 'Search Lichess games from your lines. Popular replies that Stockfish rates as mistakes become puzzles, and popular replies you have no answer for are listed as gaps.')),
        start ? h('button.btn.primary', { type: 'button', on: { click: searchAll } }, 'Find opponent mistakes') : null));
  }
  const now = Date.now();
  return h('div.opponents',
    h('div.audit-head',
      h('div',
        h('h3.section-title', `${plural(pz.total, 'opponent mistake')} to punish`),
        h('p.muted', `${pz.due} due for review, ${pz.fresh} not tried yet.`)),
      h('div.tools-row',
        pz.ready ? h('a.btn.primary', { href: `#/puzzles/${rep.id}` }, `Solve ${Math.min(pz.ready, state.settings.puzzleBatch)}`) : null,
        start ? h('button.btn', { type: 'button', on: { click: searchAll } }, 'Search again') : null)),
    list.length ? h('ul.puzzle-list', list.slice(0, 10).map((p) => {
      const st = puzzleState(rep, p);
      const status = !st ? 'New' : isDue(st, now) ? 'Due' : `Level ${st.level}`;
      return h('li',
        h('span.audit-move', `${lineTail(p.startFen, p.lineMoves, 3)}?`),
        h('span.pz-theme', p.theme ? p.theme.label : ''),
        h('span.muted', `${formatShare(p.mistake.share)} of ${formatGames(p.mistake.positionGames)} games`),
        h('span.pz-status', status),
        h('a.btn.small.ghost', { href: `#/puzzles/${rep.id}?ids=${p.id}` }, 'Solve'));
    })) : null,
    list.length > 10 ? h('p.muted', `…and ${list.length - 10} more.`) : null,
    gaps.length ? h('div.gaps',
      h('div.gaps-head',
        h('h3.field-label', 'Popular replies you have no line for'),
        h('a.btn.small', { href: `#/surprise/${rep.id}` }, 'Drill them as surprises')),
      h('ul.puzzle-list', gaps.slice(0, 8).map((g) => h('li',
        h('span.audit-move', lineTail(g.startFen, g.lineMoves, 3)),
        h('span.muted', `played in ${formatShare(g.share)} of games`),
        h('span.muted', g.bestReplySan ? `Stockfish answers ${g.bestReplySan}` : ''),
        h('span.pz-status', g.reach ? /** @type {string} */ (describeReach(g.reach)).replace(/ from here$/, '') : ''),
        h('span.gap-actions',
          h('a.btn.small.ghost', { href: `#/explore/${rep.id}?moves=${encodeURIComponent(g.lineMoves.join(','))}` }, 'Explore'),
          h('button.btn.small.ghost', {
            type: 'button',
            title: 'Dismiss: new searches leave it out',
            'aria-label': 'Dismiss',
            on: {
              click: action(async (e) => {
                const row = e.currentTarget.closest('li');
                await api.deleteGap(rep.id, g.key);
                row.remove();
              }),
            },
          }, '×')))))) : null);
}

function strengthPips(level, isNew) {
  return h('span.pips', { 'aria-label': isNew ? 'Not learned yet' : `Weakest move at level ${level} of ${MAX_LEVEL}` },
    Array.from({ length: MAX_LEVEL }, (_, i) => h(`i${i < level ? '.on' : ''}`)));
}

function toolsPanel(rep) {
  return h('section.tools',
    h('h2.caption', 'Manage'),
    h('div.tools-row',
      h('a.btn', { href: `#/edit/${rep.id}` }, 'Edit PGN and name'),
      h('button.btn', { type: 'button', on: { click: () => downloadText(`${rep.id}.pgn`, rep.pgn) } }, 'Export PGN'),
      h('button.btn', {
        type: 'button',
        on: {
          click: action(async () => {
            if (!(await confirmDialog('Reset progress?', 'Every move goes back to new. The PGN stays as it is.', 'Reset progress', true))) return;
            putRep(await api.resetProgress(rep.id));
            toast('Progress reset');
            refresh();
          }),
        },
      }, 'Reset progress'),
      h('button.btn.danger', {
        type: 'button',
        on: {
          click: action(async () => {
            if (!(await confirmDialog('Delete this repertoire?', `${rep.name} and its review history leave the library. The file is moved to the trash folder inside the data folder, so it can be restored by hand.`, 'Delete', true))) return;
            await api.remove(rep.id);
            dropRep(rep.id);
            toast('Repertoire deleted');
            location.hash = '#/';
          }),
        },
      }, 'Delete')));
}

// --- audit summary ------------------------------------------------------------------------

function renderAuditSummary(box, rep, model) {
  const audit = rep.audit;
  const start = action(() => runAudit(box, rep, model, refresh));
  if (!audit) {
    clear(box,
      h('div.audit-head',
        h('div',
          h('h3.section-title', 'Check your moves with Stockfish'),
          h('p.muted', `Stockfish looks at every move you play in this repertoire and flags any that give away ${(state.settings.auditThreshold / 100).toFixed(2)} pawns or more compared with its own choice.`)),
        h('button.btn.primary', { type: 'button', on: { click: start } }, 'Run audit')));
    return;
  }
  const flags = Object.entries(audit.flags || {})
    .map(([key, f]) => ({ key, ...f }))
    .sort((a, b) => b.loss - a.loss);
  clear(box,
    h('div.audit-head',
      h('div',
        h('h3.section-title', flags.length ? `Stockfish doubts ${plural(flags.length, 'move')}` : 'Stockfish found no weak moves'),
        h('p.muted', `Checked ${plural(audit.checked, 'move')} at depth ${audit.depth} on ${new Date(audit.at).toLocaleDateString()}. Flag threshold ${(audit.threshold / 100).toFixed(2)} pawns.`)),
      h('button.btn', { type: 'button', on: { click: start } }, 'Run again')),
    flags.length ? h('ul.audit-list', flags.map((f) => {
      const card = model.cards.get(f.key);
      return h('li',
        h('span.audit-move', f.label),
        h('span.audit-loss', `−${(f.loss / 100).toFixed(2)}`),
        h('span.audit-alt', `Stockfish prefers ${f.bestLabel}`),
        card ? h('a.btn.small.ghost', { href: `#/explore/${rep.id}?moves=${encodeURIComponent(movesTo(card.node).join(','))}` }, 'Show') : h('span.muted', 'no longer in the PGN'));
    })) : null);
}
