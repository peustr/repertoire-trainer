# CLAUDE.md

Repertoire Trainer is a local chess opening trainer (MoveTrainer-style spaced repetition, Stockfish analysis, Lichess explorer and study import). A small Node/Express server serves a no-build vanilla-JS single-page app and stores everything as JSON files. It is meant to run on the user's own laptop, mainly on Windows, and is started by double-clicking `start.bat`.

See `README.md` for the user-facing feature tour and a file-by-file project layout.

## Commands

```bash
npm install            # or `npm ci` for a clean install from the lockfile
npm start              # server on http://localhost:3210, opens the browser
npm run serve          # same, without opening the browser
npm test               # test/run-tests.mjs (parser, scheduler, puzzles, schema) + every test/*.test.mjs (node:test)
npm run test:smoke     # boots the real server on a free port with a temp data dir, hits the API and Stockfish
npm run mock-lichess   # fake Lichess on :9099 (set LICHESS_URL and LICHESS_EXPLORER_URL to use it)
node --test test/store.test.mjs   # one node:test file
```

Run both `npm test` and `npm run test:smoke` before finishing a change. New tests go in `test/<area>.test.mjs` using `node:test`, which `npm test` picks up automatically. Shared helpers live in `test/helpers/`: `startServer()` boots the real server on a free port with a temp data dir. Fixtures live in `test/fixtures/`, including `fake-uci-engine.js`, a Stockfish stand-in for `UciEngine`'s `specFor` option. Bug fixes land with a test that fails without the fix. CI (`.github/workflows/ci.yml`) runs them on Node 20/22/24 (Ubuntu) and Node 24 (Windows), plus a secrets scan and a check that nothing under `data/` is tracked.

There is no build step, bundler, TypeScript, or linter. What is in `public/` is exactly what the browser loads.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3210` / `127.0.0.1` | Server bind. Keep it on localhost: the API has no auth. |
| `ALLOWED_HOSTS` | none | Extra comma-separated host names the server answers to, besides `localhost`, `127.0.0.1`, `[::1]` and `HOST` |
| `TRAINER_DATA_DIR` | `./data` | Where repertoires, settings, the Lichess token and the cache live |
| `STOCKFISH_PATH` | none | Native Stockfish binary (otherwise `engine/stockfish*`, then the bundled WASM) |
| `LICHESS_URL`, `LICHESS_EXPLORER_URL` | the real Lichess hosts | Point at `test/mock-lichess.js` for offline work |

## Architecture

- **Server (CommonJS, `'use strict'`)**: `server.js` (Express REST API and the `/ws` WebSocket engine bridge), `store.js` (JSON file storage with atomic writes), `engine.js` (UCI process manager with two pools: `analysis` for Explore and the eval bar, `tasks` for verdicts, audits, sparring and puzzle search), `lichess.js` (OAuth PKCE, a single-file request queue, explorer disk cache), `puzzles.js` (best-first opponent-mistake search), `settings-schema.js`.
- **Browser (ES modules)**: `public/js/app.js` is a hash router; each `views/*.js` exports `renderX(main, params)` and may return a cleanup function. The DOM is built with the hyperscript helper `h('div.class#id', attrs, ...children)` from `ui.js`. Third-party modules come from the import map in `public/index.html`, served out of `node_modules` under `/vendor/...`.
- **Shared modules**: `public/js/pgn.js`, `repertoire.js`, `srs.js` and `puzzle-utils.js` run in **both** the browser and Node. The tests import them directly, and the server loads `repertoire.js` through dynamic `import()`. `public/package.json` sets `"type": "module"` for this. Keep them free of DOM APIs, and only import bare specifiers that resolve in both places (currently just `chess.js`, which is in the import map *and* `node_modules`).

## Conventions and gotchas

- **Settings come from `settings-schema.js` alone.** To add a setting, add one field there (type, range, default, label, help). Server validation, defaults and the Settings page all derive from it. Fields that need Stockfish restarted get `restart: true`, which puts them in `ENGINE_KEYS`. A schema test checks that every field has a label and a default.
- **Card keys are stored user data.** A card is keyed by `positionKey(fen)|uci` (`repertoire.js` `cardKey`), and progress in `data/repertoires/*.json` is keyed the same way. Changing `positionKey`, `cardKey` or line hashing silently resets everyone's progress. Don't, unless a migration comes with it.
- **Lichess etiquette is deliberate.** All Lichess calls go through the one-at-a-time queue in `lichess.js`, with a 61 s pause after a 429. Never fire parallel requests or bypass the cache.
- **The Lichess token never reaches the browser.** It lives in `data/lichess.json`, and `lichess.status()` (what `/api/lichess/status` returns) deliberately leaves it out. Keep it out of any new response or log line.
- **Other websites must not reach the server.** `refusal()` in `server.js` rejects requests whose `Host` is not a local name (DNS rebinding) and requests or WebSockets whose `Origin` is another site. Every route and the `/ws` socket pass through it. Don't add routes ahead of it or loosen it.
- **Data files go through `store.js`.** `writeJsonAtomic` writes a temp file, keeps the previous version as `<file>.bak`, and retries the rename while a sync client or scanner holds the file. `readJson` never overwrites a damaged file: it keeps it as `<file>.corrupt-<time>` and restores the `.bak`. Don't read or write data files with `fs` directly.
- **IDs are validated** (`/^[a-z0-9-]+$/` in `store.repFile`) before they touch the filesystem. Keep that check on any new route that builds a path.
- API handlers use the `wrap`/`wrapAsync` helpers: return a value for JSON, `null` for 404, or throw an error with `.status`.
- User-facing text is plain, friendly British English ("Practise", "analyse", "colour"). Write errors the user can act on ("Connect your Lichess account first."), not internal jargon.
- Match the existing style: 2-space indent, single quotes, semicolons, short top-of-file comments that say what a module is for.
- The project is GPL-3.0-or-later because it ships Stockfish and chessground.

## Never commit

`data/` holds personal repertoires, progress, settings and **`data/lichess.json`, a live Lichess OAuth token**. It is gitignored, and CI fails if anything under it is tracked. Native engine binaries in `engine/` are also ignored; only `engine/README.txt` is tracked. When writing tests, point `TRAINER_DATA_DIR` at a temp dir (`startServer()` and `test/store.test.mjs` do) rather than using `./data`.
