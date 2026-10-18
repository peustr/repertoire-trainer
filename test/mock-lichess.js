// A stand-in for lichess.org and explorer.lichess.org, for offline testing.
//
//   node test/mock-lichess.js            (listens on :9099)
//   set LICHESS_URL=http://localhost:9099
//   set LICHESS_EXPLORER_URL=http://localhost:9099
//   npm run serve
//
// Explorer answers are made up but deterministic: the legal moves in a
// position get fixed pseudo-random popularity, castling comes back as
// king-takes-rook (e1h1) like the real explorer, and a token is required.
//
// Test controls (not part of the real API):
//   MOCK_DELAY=ms                     answer explorer requests after this long
//   GET  /__stats                     { explorerCalls, inFlight, maxInFlight, revoked }
//   POST /__fail-next?status=429      the next explorer request answers with that status

'use strict';

const http = require('http');
const crypto = require('crypto');
const { Chess } = require('chess.js');

const PORT = Number(process.env.MOCK_PORT) || 9099;
const DELAY = Number(process.env.MOCK_DELAY) || 0;
const stats = { explorerCalls: 0, inFlight: 0, maxInFlight: 0, revoked: 0 };
let failNext = 0;
const SHARES = [0.42, 0.21, 0.13, 0.09, 0.07, 0.05, 0.02, 0.01];

// Popular book moves get a boost so the mock follows real openings for a while.
const BOOK = new Set(['e4', 'd4', 'e5', 'c6', 'd5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Nf6', 'c3', 'd3', 'd6', 'O-O', 'a6', 'a4', 'h3',
  'Be7', 'e6', 'Bf5', 'e5', 'Nc3', 'dxe4', 'Nxe4', 'Ng3', 'Bg6', 'h4', 'h6', 'Nd7', 'exd5', 'cxd5', 'Bd3', 'c5', 'Be2', 'Be3']);

function weight(s) {
  return crypto.createHash('md5').update(s).digest().readUInt32BE(0);
}

function explorer(fen) {
  const c = new Chess();
  c.load(fen);
  const moves = c.moves({ verbose: true });
  const ply = (+fen.split(' ')[5] - 1) * 2 + (fen.split(' ')[1] === 'b' ? 1 : 0);
  const total = Math.max(0, Math.round(400000 / Math.pow(2.2, ply)));
  const ranked = moves
    .map((m) => ({ m, w: weight(`${fen}|${m.san}`) + (BOOK.has(m.san) ? 2 ** 32 : 0) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, SHARES.length);
  let white = 0; let draws = 0; let black = 0;
  const out = ranked.map(({ m, w }, i) => {
    const n = Math.round(total * SHARES[i]);
    const wr = 0.35 + (w % 30) / 100;
    const dr = 0.08;
    const mw = Math.round(n * wr); const md = Math.round(n * dr); const mb = n - mw - md;
    white += mw; draws += md; black += mb;
    let uci = m.from + m.to + (m.promotion || '');
    if (m.san.startsWith('O-O')) uci = { e1g1: 'e1h1', e1c1: 'e1a1', e8g8: 'e8h8', e8c8: 'e8a8' }[uci] || uci;
    return { uci, san: m.san, averageRating: 1500 + (w % 600), white: mw, draws: md, black: mb, game: null, opening: null };
  });
  return { opening: null, white, draws, black, moves: out, topGames: [], recentGames: [] };
}

const STUDY = `[Event "Mock study: Scotch"]
[Orientation "white"]

1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 *

[Event "Mock study: Petrov"]
[Orientation "white"]

1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4 *
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const auth = req.headers.authorization || '';
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  console.log(req.method, url.pathname, auth ? '(auth)' : '');

  if (url.pathname === '/__stats') return json(200, stats);
  if (url.pathname === '/__fail-next' && req.method === 'POST') {
    failNext = Number(url.searchParams.get('status')) || 500;
    return json(200, { failNext });
  }
  if (url.pathname === '/lichess' || url.pathname === '/masters') {
    if (!auth.startsWith('Bearer ')) return json(401, { error: 'Authorization required' });
    stats.explorerCalls++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const answer = () => {
      stats.inFlight--;
      if (failNext) {
        const status = failNext;
        failNext = 0;
        return json(status, { error: 'Mock failure' });
      }
      try { return json(200, explorer(url.searchParams.get('fen'))); } catch (err) { return json(400, { error: 'Invalid fen' }); }
    };
    if (DELAY) setTimeout(answer, DELAY);
    else answer();
    return undefined;
  }
  if (url.pathname === '/api/account') {
    if (!auth.startsWith('Bearer ')) return json(401, { error: 'No such token' });
    return json(200, { id: 'mockplayer', username: 'MockPlayer', perfs: { rapid: { rating: 1720, games: 340 }, blitz: { rating: 1655, games: 120 } } });
  }
  if (/^\/api\/study\/[A-Za-z0-9]{8}\.pgn$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/x-chess-pgn' });
    return res.end(STUDY);
  }
  if (/^\/api\/study\/by\/[^/]+$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    return res.end(`${JSON.stringify({ id: 'AbCd1234', name: 'Mock study', updatedAt: Date.now() })}\n${JSON.stringify({ id: 'EfGh5678', name: 'Sicilian prep', updatedAt: Date.now() })}\n`);
  }
  if (url.pathname === '/oauth') {
    // Approve straight away and bounce back like Lichess would.
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'mockcode');
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/api/token' && req.method === 'POST') {
    return json(200, { token_type: 'Bearer', access_token: 'lio_mockOAuthToken123', expires_in: 31536000 }); // gitleaks:allow (fake token)
  }
  if (url.pathname === '/api/token' && req.method === 'DELETE') {
    stats.revoked++;
    return json(204, {});
  }
  json(404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Mock Lichess on http://localhost:${PORT}`));
