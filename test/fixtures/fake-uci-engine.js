// A stand-in for Stockfish in tests: node fake-uci-engine.js <mode>
//   ok    handshakes and answers every search with 1.e4 (+0.30)
//   mute  never answers, like an engine that hangs while starting

'use strict';

const mode = process.argv[2] || 'ok';
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (mode === 'mute') continue;
    if (line === 'uci') process.stdout.write('id name FakeFish\nuciok\n');
    else if (line === 'isready') process.stdout.write('readyok\n');
    else if (line.startsWith('go')) process.stdout.write('info depth 1 multipv 1 score cp 30 pv e2e4\nbestmove e2e4\n');
    else if (line === 'quit') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
