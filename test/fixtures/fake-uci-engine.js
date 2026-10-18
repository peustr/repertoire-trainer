// A stand-in for Stockfish in tests:
//
//   node fake-uci-engine.js [mode] [--move=e2e4] [--delay=ms] [--start-delay=ms]
//                                  [--chatty] [--until-stop] [--stop-move=uci]
//
// Modes:
//   ok     (default) handshakes and answers searches with --move (+0.30)
//   mute   never answers anything, like an engine that hangs while starting
//   hang   handshakes, then ignores "go" and "stop", like a stuck search
//   refuse handshakes, then refuses the first "position" the way Stockfish refuses
//          one with more than 32 pieces, and answers nothing after that
//
// Flags for "ok":
//   --delay=ms        answer a search after this long (default at once)
//   --start-delay=ms  wait this long before "uciok"
//   --chatty          print an info line every 50 ms while searching
//   --until-stop      only answer when told to stop, like "go infinite"
//   --stop-move=uci   answer with this move when stopped early (default --move)

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--')) || 'ok';
const flag = (name, fallback) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const move = flag('move', 'e2e4');
const stopMove = flag('stop-move', move);
const delay = Number(flag('delay', 0));
const startDelay = Number(flag('start-delay', 0));

const say = (text) => process.stdout.write(`${text}\n`);
/** @type {{ timer?: NodeJS.Timeout, chatter?: NodeJS.Timeout } | null} */
let search = null;

function finish(answer) {
  if (!search) return;
  clearTimeout(search.timer);
  clearInterval(search.chatter);
  search = null;
  say(`info depth 1 multipv 1 score cp 30 pv ${answer}`);
  say(`bestmove ${answer}`);
}

function go(line) {
  search = {};
  if (flag('chatty', false)) search.chatter = setInterval(() => say('info depth 1 currmove e2e4 currmovenumber 1'), 50);
  if (line.includes('infinite') || flag('until-stop', false)) return;
  search.timer = setTimeout(() => finish(move), delay);
}

let buffer = '';
let refused = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line === 'quit') process.exit(0);
    if (mode === 'mute' || refused) continue;
    if (line === 'uci') setTimeout(() => say('id name FakeFish\nuciok'), startDelay);
    else if (line === 'isready') say('readyok');
    else if (mode === 'hang') continue;
    else if (mode === 'refuse' && line.startsWith('position')) {
      refused = true;
      say(`info string CRITICAL ERROR: Command \`${line}\` failed. Reason: Invalid FEN. More than 32 pieces on the board.`);
    }
    else if (line.startsWith('go')) go(line);
    else if (line === 'stop') finish(stopMove);
  }
});
process.stdin.on('end', () => process.exit(0));
