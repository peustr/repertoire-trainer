// Turns a stored repertoire (PGN text + colour) into trainable lines and cards.
//
// A *line* is one path from the start to a leaf of a chapter's move tree.
// A *card* is one decision you have to remember: "in this position, I play X".
// Cards are keyed by position, so a move shared by many lines (1.e4, say) is a
// single card — you are not drilled on it twenty times a day, and transpositions
// between chapters are recognised.

import { parsePgn, chapterName, positionKey } from './pgn.js';

export function cardKey(fenBefore, uci) {
  return `${positionKey(fenBefore)}|${uci}`;
}

// Small, stable string hash (cyrb53) for line ids.
export function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function buildRepertoire(rep) {
  const games = parsePgn(rep.pgn);
  const side = rep.color === 'black' ? 'b' : 'w';
  const chapters = [];
  const lines = [];
  const seenLines = new Set();
  const cards = new Map(); // key -> { key, fenBefore, uci, san, node, lines: [] }
  const myMovesAt = new Map(); // positionKey -> Set(uci) of repertoire moves for your side
  const nodesByPosition = new Map(); // positionKey -> [node] (all chapters)
  const errors = [];

  games.forEach((game, gi) => {
    const chapter = { index: gi, name: chapterName(game, gi), root: game.root, headers: game.headers, lines: [] };
    chapters.push(chapter);
    for (const e of game.errors) errors.push(`${chapter.name}: ${e}`);

    const walk = (node, path) => {
      const key = positionKey(node.fen);
      if (!nodesByPosition.has(key)) nodesByPosition.set(key, []);
      nodesByPosition.get(key).push(node);

      for (const child of node.children) {
        if (child.color === side) {
          if (!myMovesAt.has(key)) myMovesAt.set(key, new Set());
          myMovesAt.get(key).add(child.uci);
        }
      }
      if (!node.children.length) {
        if (!path.length) return;
        const ucis = path.map((n) => n.uci).join(' ');
        const id = hash(`${game.root.fen}|${ucis}`);
        if (seenLines.has(id)) return;
        seenLines.add(id);
        const myMoves = path.filter((n) => n.color === side);
        if (!myMoves.length) return; // nothing for you to play in this line
        const line = {
          id,
          chapter,
          number: chapter.lines.length + 1,
          startFen: game.root.fen,
          startComment: game.root.comment,
          nodes: path,
          cardKeys: [],
        };
        for (const n of myMoves) {
          const k = cardKey(n.parent.fen, n.uci);
          if (!cards.has(k)) cards.set(k, { key: k, fenBefore: n.parent.fen, uci: n.uci, san: n.san, node: n, lines: [] });
          cards.get(k).lines.push(line);
          if (!line.cardKeys.includes(k)) line.cardKeys.push(k);
        }
        chapter.lines.push(line);
        lines.push(line);
        return;
      }
      for (const child of node.children) walk(child, [...path, child]);
    };
    walk(game.root, []);
  });

  return { rep, side, chapters, lines, cards, myMovesAt, nodesByPosition, errors };
}

export function lineIsMine(model, node) {
  return node.color === model.side;
}

/** Find the node for a position + move inside any chapter (used by Explore and the audit). */
export function findNode(model, fen, uci) {
  const nodes = model.nodesByPosition.get(positionKey(fen)) || [];
  for (const n of nodes) {
    const child = n.children.find((c) => c.uci === uci);
    if (child) return child;
  }
  return null;
}
