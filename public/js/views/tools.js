// The tools listed next to the board under "From this position", each with the
// sentence that says what it does. Every board page builds its list from these, so a
// tool reads the same wherever it appears (toolList in ui.js draws them).

/** Who the sparring opponent is (Settings → Sparring and drills), as a phrase. */
function against(settings) {
  switch (settings.sparOpponent) {
    case 'lichess': return 'against the moves Lichess players at your rating choose';
    case 'book': return 'against the replies you prepared, then Stockfish';
    default: return 'against Stockfish';
  }
}

export function playOutTool(href, settings) {
  return { icon: 'playout', title: 'Play it out', href, desc: `Play ${settings.playOutMoves} more moves ${against(settings)}. Stockfish then judges whether you kept the position.` };
}

export function sparTool(href, settings) {
  return { icon: 'spar', title: 'Spar from here', href, desc: `A full game from this position ${against(settings)}, with take-backs.` };
}

export function finderTool(onClick) {
  return { icon: 'search', title: 'Find opponent mistakes', onClick, desc: 'Search Lichess games for errors opponents make from this position. Each one becomes a puzzle.' };
}

export function exploreTool(href, title = 'Explore this line') {
  return { icon: 'explore', title, href, desc: 'Go through it with Stockfish and the Lichess opening explorer.' };
}

export function practiseTool(href) {
  return { icon: 'practise', title: 'Practise this line', href, desc: 'Every move of the line quizzed. Your review schedule is not touched.' };
}
