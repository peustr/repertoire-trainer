// Explore: walk the repertoire tree with Stockfish alongside, and wander off-book.

import { h, clear, fig, uciLineToSan, formatSanLine, plural, action, kbd, panelSection, toolList } from '../ui.js';
import { state, getRep, modelFor, loadLichess } from '../store.js';
import { cardKey, movesTo } from '../repertoire.js';
import { nagGlyphs, moveNumber } from '../pgn.js';
import { positionKey } from '../constants.js';
import { createBoard, createEvalBar, isPromotion, choosePromotion, applyUci, sanToUci } from '../board.js';
import { analyse, formatScore, evalBarShare } from '../engine-client.js';
import { api } from '../api.js';
import { formatGames, formatShare, describeRatings, describeSpeeds } from '../puzzle-utils.js';
import { openMistakeFinder } from './finder.js';
import { finderTool, sparTool, practiseTool } from './tools.js';

/** The panel tab last open (Moves or Opening explorer), kept while the app is open. */
let openTab = 'moves';

export async function renderExplore(root, { id, line: lineParam, moves: movesParam }) {
  const rep = await getRep(id, { fresh: true });
  const model = modelFor(rep);
  await loadLichess();
  const side = model.side;
  const flags = (rep.audit && rep.audit.flags) || {};

  let chapter = model.chapters[0];
  let pos = { node: chapter ? chapter.root : null, off: [] };
  let engineOn = true;
  let engineRun = null;
  let engineTimer = null;

  if (lineParam) {
    const line = model.lines.find((l) => l.id === lineParam);
    if (line) { chapter = line.chapter; pos = { node: line.nodes[line.nodes.length - 1], off: [] }; }
  } else if (movesParam && chapter) {
    // Follow a move list through whichever chapter matches it furthest, then continue off-book.
    const ucis = movesParam.split(',').filter(Boolean);
    let best = null;
    for (const ch of model.chapters) {
      let n = ch.root;
      let i = 0;
      while (i < ucis.length) {
        const c = n.children.find((x) => x.uci === ucis[i]);
        if (!c) break;
        n = c;
        i++;
      }
      if (!best || i > best.i) best = { ch, n, i };
    }
    const off = [];
    let f = best.n.fen;
    for (const u of ucis.slice(best.i)) {
      const r = applyUci(f, u);
      if (!r) break;
      off.push(r);
      f = r.fen;
    }
    chapter = best.ch;
    pos = { node: best.n, off };
  }

  if (!chapter) {
    root.append(h('div.page', h('div.empty', h('h1.page-title', 'Nothing to explore yet'), h('a.btn', { href: `#/edit/${id}` }, 'Add some moves'))));
    return null;
  }

  // ---- layout ----------------------------------------------------------------------
  const page = h('div.page.explore');
  const evalHost = h('div.eval-host');
  const boardHost = h('div.board-host');
  const chapterSelect = h('select.chapter-select', { 'aria-label': 'Chapter', on: { change: () => { chapter = model.chapters[+chapterSelect.value]; goTo(chapter.root); } } },
    model.chapters.map((c) => h('option', { value: String(c.index) }, c.name)));
  const where = h('div.where');
  const tree = h('div.tree', { role: 'tree', 'aria-label': 'Repertoire moves' });
  const notes = h('div.notes');
  const engineBox = h('div.engine-box');
  const engineDepth = h('span.engine-depth');
  const engineSwitch = h('input', { type: 'checkbox', role: 'switch', checked: true, 'aria-label': 'Stockfish analysis' });
  engineSwitch.addEventListener('change', () => { engineOn = engineSwitch.checked; evalBar.hide(!engineOn); refreshEngine(); });
  const toolsSection = panelSection('From this position', null, toolList([]));
  const lichessBox = h('div.lichess-box');
  let explorerSource = state.settings.explorerSource || 'lichess';
  let explorerTimer = null;
  const explorerCache = new Map();
  const sourceButtons = ['lichess', 'masters'].map((src) => h('button.seg', {
    type: 'button',
    'aria-pressed': String(src === explorerSource),
    on: { click: () => { explorerSource = src; sourceButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(['lichess', 'masters'][i] === src))); refreshExplorer(); } },
  }, src === 'lichess' ? 'Lichess' : 'Masters'));

  // Moves and the opening explorer share the space under Stockfish's lines.
  const tabs = /** @type {Array<[string, string]>} */ ([['moves', 'Moves'], ['explorer', 'Opening explorer']]);
  const tabButtons = tabs.map(([key, label]) => h('button.tab', {
    type: 'button',
    role: 'tab',
    id: `tab-${key}`,
    'aria-controls': `pane-${key}`,
    'aria-selected': String(key === openTab),
    on: { click: () => selectTab(key) },
  }, label));
  const panes = {
    moves: h('div.tab-panel#pane-moves', { role: 'tabpanel', 'aria-labelledby': 'tab-moves', hidden: openTab !== 'moves' },
      h('div.tree-wrap', tree), notes),
    explorer: h('div.tab-panel#pane-explorer', { role: 'tabpanel', 'aria-labelledby': 'tab-explorer', hidden: openTab !== 'explorer' },
      h('div.tab-tools', h('span.muted', 'Games played from this position'), h('div.segs', sourceButtons)),
      lichessBox),
  };

  page.append(
    h('div.board-col',
      h('div.board-row', evalHost, boardHost),
      h('div.nav-buttons',
        navBtn('⏮', 'Start of the chapter (Home)', () => goTo(chapter.root)),
        navBtn('◀', 'Back (←)', back),
        navBtn('▶', 'Forward (→)', forward),
        navBtn('⏭', 'End of the line (End)', toEnd),
        navBtn('⇅', 'Flip board (F)', () => board.flip())),
      h('p.kbd-hint',
        h('span', kbd('←'), kbd('→'), 'move'),
        h('span', kbd('↑'), kbd('↓'), 'other variations'),
        h('span', kbd('F'), 'flip'))),
    h('aside.panel.explore-panel',
      h('div.trainer-crumbs', h('a.backlink', { href: `#/rep/${rep.id}` }, rep.name), h('span.mode-tag', 'Explore')),
      chapterSelect,
      where,
      panelSection('Stockfish', h('span.psec-aside', engineDepth, h('span.switch', engineSwitch, h('span.switch-track', { 'aria-hidden': 'true' }))), engineBox),
      h('div.psec',
        h('div.tabs', { role: 'tablist', 'aria-label': 'Moves and games' }, tabButtons),
        panes.moves,
        panes.explorer),
      toolsSection));
  root.append(page);

  function selectTab(key) {
    openTab = key;
    tabs.forEach(([k], i) => {
      tabButtons[i].setAttribute('aria-selected', String(k === key));
      panes[k].hidden = k !== key;
    });
    if (key === 'explorer') refreshExplorer();
    else tree.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  const board = createBoard(boardHost, { orientation: rep.color, onMove });
  const evalBar = createEvalBar(evalHost);

  function navBtn(glyph, label, fn) {
    return h('button.btn.icon', { type: 'button', title: label, 'aria-label': label, on: { click: fn } }, glyph);
  }

  // ---- navigation --------------------------------------------------------------------
  function currentFen() {
    return pos.off.length ? pos.off[pos.off.length - 1].fen : pos.node.fen;
  }
  function currentLastMove() {
    if (pos.off.length) return pos.off[pos.off.length - 1].uci;
    return pos.node.uci || undefined;
  }

  function goTo(node) {
    pos = { node, off: [] };
    update();
  }
  function back() {
    if (pos.off.length) pos.off.pop();
    else if (pos.node.parent) pos.node = pos.node.parent;
    update();
  }
  function forward() {
    if (!pos.off.length && pos.node.children.length) { pos.node = pos.node.children[0]; update(); }
  }
  function toEnd() {
    if (pos.off.length) return;
    let n = pos.node;
    while (n.children.length) n = n.children[0];
    goTo(n);
  }
  function sibling(dir) {
    if (pos.off.length || !pos.node.parent) return;
    const sibs = pos.node.parent.children;
    const i = sibs.indexOf(pos.node);
    const next = sibs[i + dir];
    if (next) goTo(next);
  }

  async function onMove(from, to) {
    const fen = currentFen();
    let uci = from + to;
    if (isPromotion(fen, from, to)) uci += await choosePromotion(fen.split(' ')[1] === 'w' ? 'white' : 'black');
    playUci(uci);
  }

  function playUci(uci) {
    if (!pos.off.length) {
      const child = pos.node.children.find((c) => c.uci === uci);
      if (child) { goTo(child); return; }
    }
    const res = applyUci(currentFen(), uci);
    if (!res) { update(); return; }
    pos.off.push(res);
    update(true, res.captured);
  }

  // ---- rendering ------------------------------------------------------------------------
  function update(playSound = false, captured = false) {
    const fen = currentFen();
    board.setPosition(fen, { lastMove: currentLastMove(), movable: true, playSound, captured });
    board.setShapes(pos.off.length || !state.settings.pgnArrows ? [] : pos.node.shapes);
    if (+chapterSelect.value !== chapter.index) chapterSelect.value = String(chapter.index);
    renderTree();
    renderWhere();
    renderNotes();
    renderActions();
    refreshEngine();
    refreshExplorer();
  }

  function renderWhere() {
    const n = pos.node;
    if (pos.off.length) {
      clear(where,
        h('p.where-main.off', 'Off-book analysis'),
        h('p.where-sub', `${formatSanLine(pos.off.map((m, i) => ({ san: m.san, color: m.color, number: +(i === 0 ? n.fen : pos.off[i - 1].fen).split(' ')[5] })))}`),
        h('button.btn.small.ghost', { type: 'button', on: { click: () => goTo(n) } }, 'Back to the repertoire'));
      return;
    }
    const mineHere = n.children.filter((c) => c.color === side);
    const theirsHere = n.children.filter((c) => c.color !== side);
    let sub;
    if (!n.children.length) sub = 'End of the line.';
    else if (mineHere.length) sub = `Your move: ${mineHere.map((c) => fig(c.san)).join(' or ')}`;
    else sub = `Prepared for ${plural(theirsHere.length, 'reply', 'replies')}: ${theirsHere.map((c) => fig(c.san)).join(', ')}`;
    clear(where,
      h('p.where-main', n.san ? `After ${label(n)}` : 'Starting position'),
      h('p.where-sub', sub));
  }

  function renderNotes() {
    if (pos.off.length) { clear(notes); return; }
    const n = pos.node;
    const parts = n === chapter.root ? [] : [n.preComment, n.comment].filter(Boolean); // the tree already opens with the chapter's intro
    const flag = n.parent && n.color === side ? flags[cardKey(n.parent.fen, n.uci)] : null;
    clear(notes,
      parts.length ? h('div.note', n.san ? h('span.note-move', label(n)) : null, parts.map((t) => h('p', t))) : null,
      flag ? h('div.note.flagged', h('p', `Stockfish audit: ${label(n)} loses ${(flag.loss / 100).toFixed(2)}. It prefers ${flag.bestLabel}.`)) : null);
  }

  function renderActions() {
    const fen = currentFen();
    const line = pos.off.length ? null : lineThrough(pos.node);
    const backHash = encodeURIComponent(location.hash);
    toolsSection.lastChild.replaceWith(toolList([
      finderTool(action(findMistakes)),
      sparTool(`#/spar?fen=${encodeURIComponent(fen)}&color=${rep.color}&rep=${rep.id}&back=${backHash}`, state.settings),
      line ? practiseTool(`#/train/${rep.id}/practice/${line.id}`) : null,
    ]));
  }

  function findMistakes() {
    const moves = [...movesTo(pos.node), ...pos.off.map((m) => m.uci)];
    const sans = uciLineToSan(chapter.root.fen, moves, 80);
    return openMistakeFinder({
      rep,
      fen: currentFen(),
      prefix: { startFen: chapter.root.fen, moves },
      where: sans.length ? `From ${formatSanLine(sans.slice(-6))}` : `From the start of ${chapter.name}`,
    });
  }

  // ---- Lichess opening explorer -----------------------------------------------------------
  function refreshExplorer() {
    clearTimeout(explorerTimer);
    if (openTab !== 'explorer') return; // asked for when the tab opens: no Lichess requests for a hidden table
    if (!state.lichess.connected) {
      clear(lichessBox, h('p.muted', 'See what players at your level play here. ', h('a', { href: '#/lichess' }, 'Connect Lichess')));
      return;
    }
    const fen = currentFen();
    const key = `${explorerSource}|${fen}`;
    if (explorerCache.has(key)) { renderExplorer(fen, explorerCache.get(key)); return; }
    clear(lichessBox, h('p.muted', 'Loading games…'));
    explorerTimer = setTimeout(async () => {
      try {
        const data = await api.lichess.explorer(fen, explorerSource);
        explorerCache.set(key, data);
        if (currentFen() === fen) renderExplorer(fen, data);
      } catch (err) {
        if (currentFen() === fen) clear(lichessBox, h('p.bad', err.message));
      }
    }, 250);
  }

  function renderExplorer(fen, data) {
    const s = state.settings;
    const filter = explorerSource === 'masters' ? 'Over-the-board master games' : `Lichess rated ${describeSpeeds(s.lichessSpeeds)}, ${describeRatings(s.lichessRatings)}`;
    if (!data.total) {
      clear(lichessBox, h('p.muted', `No games reach this position (${filter}).`));
      return;
    }
    const mine = model.myMovesAt.get(positionKey(fen)) || new Set();
    const prepared = new Set(pos.off.length ? [] : pos.node.children.map((c) => c.uci));
    const whiteToMove = fen.split(' ')[1] === 'w';
    const rows = data.moves.slice(0, 8).map((m) => {
      const mv = sanToUci(fen, m.san);
      const uci = mv ? mv.uci : m.uci;
      const inRep = mine.has(uci) || prepared.has(uci);
      const t = m.total || 1;
      const share = m.total / data.total;
      return h(`button.ex-row${inRep ? '.in-rep' : ''}`, { type: 'button', title: inRep ? 'In your repertoire' : 'Play this move', on: { click: () => playUci(uci) } },
        h('span.ex-move', fig(m.san)),
        h('span.ex-share', formatShare(share)),
        h('span.ex-games', formatGames(m.total)),
        h('span.ex-wdl', { title: `White ${Math.round((m.white / t) * 100)}%, draws ${Math.round((m.draws / t) * 100)}%, Black ${Math.round((m.black / t) * 100)}%` },
          h('i.w', { style: { flexGrow: m.white } }), h('i.d', { style: { flexGrow: m.draws } }), h('i.b', { style: { flexGrow: m.black } })));
    });
    clear(lichessBox,
      h('p.ex-head', data.opening ? h('span.ex-opening', `${data.opening.eco} ${data.opening.name}`) : null, h('span.muted', `${formatGames(data.total)} games · ${filter}`)),
      h('div.ex-table', { role: 'list', 'aria-label': `${whiteToMove ? 'White' : 'Black'} moves played here` },
        h('div.ex-cols', { 'aria-hidden': 'true' }, h('span', 'Move'), h('span', 'Played'), h('span', 'Games'), h('span', 'White · draw · Black')),
        rows));
  }

  function lineThrough(node) {
    let leaf = node;
    while (leaf.children.length) leaf = leaf.children[0];
    return model.lines.find((l) => l.nodes[l.nodes.length - 1] === leaf) || model.lines.find((l) => l.nodes.includes(node)) || null;
  }

  function label(n) {
    const num = moveNumber(n);
    return n.color === 'w' ? `${num}.${fig(n.san)}` : `${num}...${fig(n.san)}`;
  }

  function moveEl(node, withNumber) {
    const num = moveNumber(node);
    const text = node.color === 'w' ? `${num}.${fig(node.san)}` : withNumber ? `${num}...${fig(node.san)}` : fig(node.san);
    const flagged = node.parent && node.color === side && flags[cardKey(node.parent.fen, node.uci)];
    const el = h(`button.mv${node.color === side ? '.mine' : ''}${node === pos.node && !pos.off.length ? '.current' : ''}${flagged ? '.flagged' : ''}`,
      { type: 'button', role: 'treeitem', on: { click: () => goTo(node) } },
      text + nagGlyphs(node.nags));
    return el;
  }

  function renderLine(start, el, forceNumber, depth) {
    let node = start;
    let showNum = forceNumber;
    for (;;) {
      el.append(moveEl(node, showNum), ' ');
      showNum = false;
      if (node.comment) { el.append(h('span.tree-comment', node.comment), ' '); showNum = true; }
      const parent = node.parent;
      if (parent && parent.children[0] === node && parent.children.length > 1) {
        for (const alt of parent.children.slice(1)) {
          const v = h(depth === 0 ? 'div.var.block' : 'span.var.inline');
          if (alt.preComment) v.append(h('span.tree-comment', alt.preComment), ' ');
          renderLine(alt, v, true, depth + 1);
          el.append(v, ' ');
        }
        showNum = true;
      }
      if (!node.children.length) break;
      node = node.children[0];
    }
  }

  function renderTree() {
    const scroll = tree.parentElement.scrollTop;
    clear(tree);
    if (chapter.root.comment) tree.append(h('p.tree-intro', chapter.root.comment));
    const main = h('div.var.main');
    if (chapter.root.children.length) renderLine(chapter.root.children[0], main, true, 0);
    tree.append(main);
    tree.parentElement.scrollTop = scroll;
    const cur = tree.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // ---- engine ---------------------------------------------------------------------------
  function refreshEngine() {
    clearTimeout(engineTimer);
    if (engineRun) { engineRun.stop(); engineRun = null; }
    engineDepth.textContent = '';
    if (!engineOn) { clear(engineBox, h('p.muted', 'Stockfish is off. Switch it on to see its lines.')); return; }
    const fen = currentFen();
    clear(engineBox, h('p.muted', 'Thinking…'));
    engineTimer = setTimeout(() => {
      engineRun = analyse(fen, { multipv: state.settings.analysisLines, depth: state.settings.analysisDepth }, (msg) => {
        if (currentFen() !== fen) return;
        renderEngine(fen, msg);
      }, (err) => {
        if (currentFen() === fen) clear(engineBox, h('p.bad', err.message));
      });
    }, 150);
  }

  function renderEngine(fen, msg) {
    const lines = msg.lines || [];
    if (!lines.length) {
      clear(engineBox, h('p.muted', 'No legal moves here.'));
      evalBar.update(0.5, '', rep.color === 'black');
      return;
    }
    const top = lines[0];
    evalBar.update(evalBarShare(top.score), formatScore(top.score), rep.color === 'black');
    engineDepth.textContent = `Depth ${msg.depth}`;
    clear(engineBox,
      h('ol.pv-list', lines.map((l) => h('li',
        h('button.pv-move', { type: 'button', title: 'Play this move', on: { click: () => playUci(l.pv[0]) } }, h('span.pv-score', formatScore(l.score))),
        h('span.pv-line', formatSanLine(uciLineToSan(fen, l.pv, 10)))))));
  }

  // ---- keyboard ------------------------------------------------------------------------------
  function onKey(e) {
    if (e.target.closest('input, textarea, select, dialog')) return;
    const keys = { ArrowLeft: back, ArrowRight: forward, ArrowUp: () => sibling(-1), ArrowDown: () => sibling(1), Home: () => goTo(chapter.root), End: toEnd, f: () => board.flip() };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  }
  document.addEventListener('keydown', onKey);

  update();

  return () => {
    clearTimeout(engineTimer);
    clearTimeout(explorerTimer);
    if (engineRun) engineRun.stop();
    document.removeEventListener('keydown', onKey);
    board.destroy();
  };
}
