// PGN → move tree.
//
// Handles multi-game files (each game becomes a chapter), nested variations,
// {comments}, ;comments, NAGs ($1, !?, …), [FEN] start positions, and the
// lichess/ChessBase [%cal …] / [%csl …] arrow and square markup.

import { Chess } from 'chess.js';
import { START_FEN, TEXT_STYLE } from './constants.js';
import { playMove } from './moves.js';

const FIGURINE_TO_LETTER = { '♔': 'K', '♕': 'Q', '♖': 'R', '♗': 'B', '♘': 'N', '♚': 'K', '♛': 'Q', '♜': 'R', '♝': 'B', '♞': 'N' };
const SUFFIX_NAGS = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 };

// --- tokenizer ---------------------------------------------------------------

const RE_HEADER = /\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/y;
const RE_RESULT = /(1-0|0-1|1\/2-1\/2|½-½|\*)(?=[\s)]|$)/y;
const RE_ZERO_CASTLE = /0-0(-0)?(?=[\s+#!?)]|$)/y;
const RE_MOVENUM = /\d+\s*(\.|…)+/y;
const RE_NAG = /\$(\d+)/y;
const RE_WORD = /[^\s{}()[\];$]+/y;

function stickyMatch(re, text, i) {
  re.lastIndex = i;
  return re.exec(text);
}

export function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    // Whitespace, including a byte-order mark (\uFEFF) and the no-break space (\u00A0).
    if (c === '\uFEFF' || c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00A0') { i++; continue; }
    const atLineStart = lineStart;
    lineStart = false;

    if (c === '%' && atLineStart) { // escape line
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '[') {
      const m = stickyMatch(RE_HEADER, text, i);
      if (m) {
        tokens.push({ t: 'header', key: m[1], value: m[2].replace(/\\(.)/g, '$1') });
        i += m[0].length;
      } else {
        i++;
      }
      continue;
    }
    if (c === '{') {
      const end = text.indexOf('}', i + 1);
      const body = text.slice(i + 1, end < 0 ? n : end);
      tokens.push(end < 0 ? { t: 'comment', text: body, unclosed: true } : { t: 'comment', text: body });
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === ';') {
      const end = text.indexOf('\n', i);
      tokens.push({ t: 'comment', text: text.slice(i + 1, end < 0 ? n : end) });
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '(') { tokens.push({ t: 'open' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'close' }); i++; continue; }
    if (c === '$') {
      const m = stickyMatch(RE_NAG, text, i);
      if (m) { tokens.push({ t: 'nag', n: +m[1] }); i += m[0].length; } else i++;
      continue;
    }
    let m = stickyMatch(RE_RESULT, text, i);
    if (m) { tokens.push({ t: 'result', value: m[1] === '½-½' ? '1/2-1/2' : m[1] }); i += m[0].length; continue; }
    m = stickyMatch(RE_ZERO_CASTLE, text, i);
    if (m) { tokens.push({ t: 'san', text: m[1] ? 'O-O-O' : 'O-O' }); i += m[0].length; continue; }
    m = stickyMatch(RE_MOVENUM, text, i);
    if (m) { i += m[0].length; continue; }
    m = stickyMatch(RE_WORD, text, i);
    if (m) {
      i += m[0].length;
      const word = m[0];
      if (/^[!?]+$/.test(word)) {
        if (SUFFIX_NAGS[word]) tokens.push({ t: 'nag', n: SUFFIX_NAGS[word] });
        continue;
      }
      // A number, "e.p.", or the dots of "1. ... e5" written apart from the move number.
      if (/^\d+$/.test(word) || /^e\.?p\.?$/i.test(word) || /^[.…]+$/.test(word)) continue;
      const suffix = (word.match(/[!?]+$/) || [''])[0];
      let san = word.slice(0, word.length - suffix.length);
      san = san.replace(/[♔♕♖♗♘♚♛♜♝♞]/g, (f) => FIGURINE_TO_LETTER[f]);
      san = san.replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
      tokens.push({ t: 'san', text: san });
      if (SUFFIX_NAGS[suffix]) tokens.push({ t: 'nag', n: SUFFIX_NAGS[suffix] });
      continue;
    }
    i++;
  }
  return tokens;
}

// --- comment markup ------------------------------------------------------------

const BRUSH = { G: 'green', R: 'red', Y: 'yellow', B: 'blue' };

/** Split a raw comment into display text and board shapes. */
export function parseComment(raw) {
  const shapes = [];
  const text = raw.replace(/\[%(\w+)\s+([^\]]*)\]/g, (_, cmd, args) => {
    if (cmd === 'cal' || cmd === 'csl') {
      for (const item of args.split(',').map((s) => s.trim()).filter(Boolean)) {
        const brush = BRUSH[item[0]] || 'green';
        const sq = item.slice(1);
        if (cmd === 'cal' && /^[a-h][1-8][a-h][1-8]$/.test(sq)) shapes.push({ orig: sq.slice(0, 2), dest: sq.slice(2, 4), brush });
        if (cmd === 'csl' && /^[a-h][1-8]$/.test(sq)) shapes.push({ orig: sq, brush });
      }
    }
    return ''; // drop [%clk], [%eval], etc.
  });
  return { text: text.replace(/\s+/g, ' ').trim(), shapes };
}

// --- tree building ---------------------------------------------------------------

/**
 * @param {() => number} nextId numbers the nodes of one parse (see parsePgn)
 * @param {object} fields
 */
function makeNode(nextId, fields) {
  return {
    id: nextId(),
    san: null,
    uci: null,
    fen: null,
    ply: 0,
    color: null, // side that made this move: 'w' | 'b'
    parent: null,
    children: [],
    comment: '',
    preComment: '',
    shapes: [],
    nags: [],
    ...fields,
  };
}

function appendComment(node, key, raw) {
  const { text, shapes } = parseComment(raw);
  if (text) node[key] = node[key] ? `${node[key]} ${text}` : text;
  if (shapes.length) node.shapes = [...node.shapes, ...shapes];
}

const chess = new Chess(); // checks [FEN] headers

function pathSan(node) {
  const parts = [];
  for (let n = node; n && n.san; n = n.parent) parts.unshift(moveLabel(n));
  return parts.slice(-6).join(' ') || 'the start';
}

export function moveNumber(node) {
  // ply counts from the game's start position, so derive the number from the FEN before the move.
  const before = node.parent ? node.parent.fen : node.fen;
  return +(before.split(/\s+/)[5] || 1);
}

/** "5.Nf3" or "5...Nc6", in figurines when asked. */
export function moveLabel(node, figurines = false) {
  const n = moveNumber(node);
  const san = figurines ? toFigurine(node.san) : node.san;
  return node.color === 'w' ? `${n}.${san}` : `${n}...${san}`;
}

/** "5.Nf3 Nc6 6.Bb5" — numbers only where a reader needs them. */
export function formatSequence(nodes, figurines = false) {
  return nodes.map((node, i) => {
    const san = (figurines ? toFigurine(node.san) : node.san) + nagGlyphs(node.nags.filter((x) => x <= 6));
    const n = moveNumber(node);
    if (node.color === 'w') return `${n}.${san}`;
    return i === 0 ? `${n}...${san}` : san;
  }).join(' ');
}

const FIGURINES = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
export function toFigurine(san) {
  if (!san) return '';
  return san.replace(/^[KQRBN]/, (p) => FIGURINES[p] + TEXT_STYLE).replace(/=([QRBN])/, (_, p) => `=${FIGURINES[p]}${TEXT_STYLE}`);
}

/** @param {() => number} nextId */
function buildGame(tokens, headers, chapterIndex, nextId) {
  const errors = [];
  let startFen = START_FEN;
  if (headers.FEN) {
    try {
      chess.load(headers.FEN);
      startFen = chess.fen();
    } catch (err) {
      errors.push(`Invalid [FEN] header: ${headers.FEN}`);
    }
  }
  const root = makeNode(nextId, { fen: startFen, ply: 0 });
  let cur = root;
  let dead = false;
  let pendingPre = '';
  let atVariationStart = true;
  const stack = [];
  let moves = 0;

  for (const tok of tokens) {
    switch (tok.t) {
      case 'san': {
        if (dead) break;
        const mv = playMove(cur.fen, tok.text);
        if (!mv) {
          errors.push(`Illegal or unreadable move "${tok.text}" after ${pathSan(cur)} — skipped the rest of that line.`);
          dead = true;
          break;
        }
        let next = cur.children.find((c) => c.uci === mv.uci);
        if (!next) {
          next = makeNode(nextId, { san: mv.san, uci: mv.uci, fen: mv.fen, color: mv.color, ply: cur.ply + 1, parent: cur });
          cur.children.push(next);
        }
        if (pendingPre) { appendComment(next, 'preComment', pendingPre); pendingPre = ''; }
        cur = next;
        atVariationStart = false;
        moves++;
        break;
      }
      case 'comment':
        if (tok.unclosed) {
          errors.push(`A comment ${cur.san ? `after ${pathSan(cur)}` : 'at the start'} is never closed with "}", so everything after it was read as part of the comment.`);
        }
        if (dead) break;
        if (cur === root && stack.length === 0) appendComment(root, 'comment', tok.text);
        else if (atVariationStart) pendingPre = pendingPre ? `${pendingPre} ${tok.text}` : tok.text;
        else appendComment(cur, 'comment', tok.text);
        break;
      case 'nag':
        if (!dead && cur !== root && !cur.nags.includes(tok.n)) cur.nags.push(tok.n);
        break;
      case 'open':
        stack.push({ cur, dead });
        if (!dead) {
          if (!cur.parent) {
            errors.push('A variation starts before any move was played — ignored it.');
            dead = true;
          } else {
            cur = cur.parent;
          }
        }
        atVariationStart = true;
        pendingPre = '';
        break;
      case 'close': {
        const frame = stack.pop();
        if (frame) { cur = frame.cur; dead = frame.dead; }
        atVariationStart = false;
        pendingPre = '';
        break;
      }
      default:
        break;
    }
  }
  if (stack.length) errors.push('Unbalanced parentheses — a variation was never closed.');
  return { headers, root, errors, moves, index: chapterIndex };
}

/**
 * Split tokens into games: a header after movetext, or a result at depth 0, starts a new game.
 * Node ids count up from 1 across the games of this parse, so the same text gives the same ids.
 */
export function parsePgn(text) {
  const tokens = tokenize(String(text || ''));
  let seq = 0;
  const nextId = () => ++seq;
  const games = [];
  /** @type {Record<string, string>} */
  let headers = {};
  let body = [];
  let depth = 0;
  let sawMoves = false;

  const flush = () => {
    if (sawMoves || Object.keys(headers).length) {
      games.push(buildGame(body, headers, games.length, nextId));
    }
    headers = {};
    body = [];
    depth = 0;
    sawMoves = false;
  };

  for (const tok of tokens) {
    if (tok.t === 'header') {
      if (sawMoves) flush();
      headers[tok.key] = tok.value;
      continue;
    }
    if (tok.t === 'result' && depth === 0) {
      headers.Result = headers.Result || tok.value;
      sawMoves = true;
      flush();
      continue;
    }
    if (tok.t === 'open') depth++;
    if (tok.t === 'close') depth = Math.max(0, depth - 1);
    if (tok.t === 'san' || tok.t === 'comment' || tok.t === 'open') sawMoves = true;
    body.push(tok);
  }
  flush();
  return games.filter((g) => g.moves > 0 || g.errors.length);
}

export function chapterName(game, i) {
  const h = game.headers;
  const clean = (v) => (v && v !== '?' && v !== '??' ? v.trim() : '');
  if (clean(h.ChapterName)) return clean(h.ChapterName);
  const event = clean(h.Event);
  // Lichess study exports look like "My study: Chapter name"
  if (event && /:\s/.test(event)) return event.split(/:\s/).slice(1).join(': ');
  if (clean(h.White) && clean(h.Black) && !/^(white|black)$/i.test(clean(h.White))) return `${clean(h.White)} – ${clean(h.Black)}`;
  if (event) return event;
  if (clean(h.Opening)) return clean(h.Opening) + (clean(h.Variation) ? `: ${clean(h.Variation)}` : '');
  return `Chapter ${i + 1}`;
}

const NAG_GLYPHS = {
  1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!', 7: '□', 10: '=', 13: '∞',
  14: '⩲', 15: '⩱', 16: '±', 17: '∓', 18: '+−', 19: '−+', 22: '⨀', 32: '⟳', 36: '→', 40: '↑', 132: '⇆', 140: '∆', 146: 'N',
};
export function nagGlyphs(nags) {
  return (nags || []).map((n) => NAG_GLYPHS[n] || '').join('');
}
