# Repertoire Trainer

A local opening trainer in the spirit of Chessable's MoveTrainer. Paste your
openings as PGN, and the trainer turns every move you have to remember into a
quiz, brings it back on a spaced-repetition schedule, and uses Stockfish to
judge your mistakes, audit your repertoire and spar with you.

Everything runs on your laptop. Your repertoires are plain JSON files in `data/`.

## Start it on Windows

1. Install **Node.js LTS** (version 22.12 or newer) from https://nodejs.org.
2. Unzip this folder somewhere, for example `Documents\repertoire-trainer`.
3. Double-click **`start.bat`**. The first run installs dependencies (about a
   minute, needs the internet), and so does the first run after an update that
   changed them. Your browser opens at http://localhost:3210.

Close the console window (or press Ctrl+C in it) to stop the trainer.

From a terminal instead: `npm install`, then `npm start`.

### Faster engine (optional)

Stockfish 19 is bundled as WebAssembly, so analysis works out of the box. For
roughly native speed, drop a Windows Stockfish `.exe` into the `engine` folder
(see `engine/README.txt`), or point **Settings → Stockfish → Path to
stockfish.exe** at one you already have. Threads and memory are set there too;
the defaults are sized for your computer.

## Using it

Each repertoire's page lists every way to train it as a card that says what the
mode does and what is waiting (lines due, new lines, puzzles ready). Next to the
board, **From this position** lists the tools you can use there (Play it out,
Spar, Find opponent mistakes, Explore), each with a sentence about what it does.

| Where | What it does |
| --- | --- |
| **Library** | Every repertoire with its memory bar, plus a one-move warm-up card from whatever is due. |
| **Add repertoire** | Paste PGN or drop `.pgn` files. Choose the side you play. The preview shows chapters, lines and any unreadable moves. |
| **Learn** | New lines play out with arrows and the PGN's comments; you repeat each new move, then play the whole line again from memory. |
| **Review** | Lines with due moves. Moves that are not due play themselves, so you only spend time on what you are about to forget. |
| **Practise** | Any line or chapter, every move quizzed, schedule untouched. |
| **Explore** | Browse the tree with Stockfish (3 lines, eval bar), and switch to the Lichess opening explorer in the tab next to the moves. Play off-book moves to analyse your own ideas. |
| **Spar** | Play from the first move, or on from any position. The opponent plays like **Lichess players at your rating** (each move as often as they play it) until a position has no games, then Stockfish takes over at 1320–3190 Elo. It can also follow your prepared lines, or be Stockfish from the first move. |
| **Play it out** | At the end of a line: play 8 more moves against that opponent and keep the position. Stockfish judges where you started and where you finished, then points out your biggest slip. |
| **Surprise drills** | The opponent leaves your book with a reply you have not prepared: the gaps the mistake finder saved, popular Lichess replies in your lines, or Stockfish's sound sidelines when Lichess is not connected. Stockfish grades your answer, and a good one can be added to the repertoire as a new chapter. |
| **Audit** | Stockfish checks every move you play and flags ones that lose more than a threshold (default 0.70 pawns). |

Keyboard: `H` hint, `Enter` next line, `Esc` back. In Explore: arrows to move
through the tree, `F` flips the board.

## Lichess

Open **Lichess** in the top bar and click **Sign in with Lichess**. Lichess shows
its own approval page and sends you back; the app asks only for permission to
read your private studies, and the explorer itself needs no permissions. You can
paste a personal access token instead. The token is stored in
`data/lichess.json` on your computer and is never sent to the browser.

| Feature | Where |
| --- | --- |
| **Opening explorer** | The "Opening explorer" tab in Explore: what Lichess players at your chosen ratings and time controls play in the current position (or master games). Your repertoire moves are highlighted; click a row to play it. It asks Lichess only while the tab is open. |
| **Find opponent mistakes** | Explore, the trainer, or "Find mistakes" on any chapter. See below. |
| **Puzzles** | Every mistake found becomes a puzzle with its own review schedule. "Add line to repertoire" turns the punishment into a new chapter you can learn. |
| **Gaps** | Popular replies your repertoire has no answer for, with Stockfish's suggestion. |
| **Lichess players** | Spar and Surprise drills ask the explorer what your opponents play: one queued, cached request per position. |
| **Study import** | Paste a study link on the Lichess page or the Add repertoire page, or pick from your own studies. |

Set **who your opponents are** (rating bands, time controls, how recent) in
**Settings → Opponents on Lichess**. After signing in, the Lichess page offers a
band around your own rating.

### How the mistake search works

From the position you are on, the search walks forward through your repertoire:

1. **Your move:** it follows your repertoire move, or Stockfish's best once your
   line has ended. No API call is needed.
2. **Opponent's move:** it asks the Lichess explorer what players at your level
   play there, keeping replies played in at least 5% of games.
3. Stockfish scores each of those replies. A reply that gives away 1.5 pawns or
   more (and leaves you clearly better) is a **mistake**. Stockfish then works
   out the punishment, extending it while each next move is clearly the only
   good one.
4. Replies that are fine and inside your repertoire are explored further. Popular
   replies outside your repertoire are reported as **gaps**.
5. Positions are visited in order of how likely you are to reach them, so the
   most practical mistakes come first. Each search looks up 30 positions by
   default.

Lichess asks apps to make one request at a time and to wait a minute after a
"too many requests" answer. The trainer does exactly that, and caches every
explorer answer in `data/cache` for 30 days, so repeat searches are fast.

Every threshold above is adjustable in **Settings → Mistake finder**.

### Testing without Lichess

`npm run mock-lichess` starts a fake Lichess on port 9099 with made-up explorer
numbers. Point the trainer at it with the `LICHESS_URL` and
`LICHESS_EXPLORER_URL` environment variables set to `http://localhost:9099`.

## Settings

Open **Settings** in the top bar. It is a separate control panel, so nothing
clutters the board while you train. Options are grouped in cards, every option
has a short explanation and its default, and changes save as you go. A dot marks
an option you have changed (with **Use default** next to it), the section list
counts them, and each section has **Restore defaults**. Use **Find a setting** to
search across all of them.

| Section | What you can change |
| --- | --- |
| Training | Session sizes, the instant replay after learning, quizzing every move, hints, moves from other lines, comments and arrows, reply speeds, auto-advance, practice order |
| Memory schedule | The wait for each of the eight levels, and what a mistake costs |
| Stockfish | Built-in or native engine, the .exe path, threads and memory for analysis and for background jobs, every search depth, audit threshold |
| Sparring and drills | Who the sparring opponent is, Stockfish's strength and thinking time, how long a play-out lasts and how far it may slip, Surprise session size, popularity and grading |
| Mistake finder | Search budget and depth, which replies count, how big a mistake must be, puzzle uniqueness and length, puzzles per session, when another winning move counts |
| Opponents on Lichess | Time controls, rating bands, a start date, the explorer's default source, how long answers are cached |
| Display and sound | Light, dark or system theme, figurines, coordinates, move dots, animation, sound and volume |

The Stockfish version is not a setting: the app always uses the version it ships
with, or whichever native .exe you give it. The built-in engine can use at most
512 MB of memory; a native .exe can use more.

### How memory works

- A **card** is one decision: "in this position, I play this move". Cards are
  keyed by position, so a move shared by many lines (1.e4, or a transposition
  between chapters) is one card, learned once.
- Eight levels with waits of 4 hours, 1 day, 3 days, 1 week, 2 weeks, 1 month,
  3 months and 6 months (each can be changed in **Settings → Memory schedule**).
  A correct answer on a due card moves it up one level.
- A mistake sends the card back to level 1, or down 1 to 7 levels (2 by default)
  if you choose **Drop a few levels** in Settings. A hint counts as a mistake,
  unless you turn off **A hint counts as a mistake**: then a hint costs nothing,
  but the move does not level up either.
- If you play a different move that is also in your repertoire for that
  position, the trainer tells you so and lets you try again without a penalty.
- When you make a real mistake, Stockfish scores your move against the book move
  so you can tell a blunder from a playable sideline.

### PGN tips

- Each game in a file becomes a chapter. `[ChapterName "…"]`, `[Event "…"]` or
  the players' names are used as the chapter title (Lichess study exports work).
- Variations `( … )` become separate lines. Nested variations are fine.
- `{comments}` show while you train; `[%cal Ge2e4]` and `[%csl Rf7]` become
  arrows and highlighted squares on the board.
- `[SetUp "1"]` + `[FEN "…"]` start a chapter from any position.
- Editing a repertoire keeps progress on every move that is still in the PGN.

## Your data

Settings live in `data/settings.json`, repertoires in `data/repertoires/*.json`.
Back up or sync the `data` folder to keep your progress. If the trainer's console
window is closed while you train, your answers wait in the browser and are saved as
soon as it is running again. Each file keeps its
previous version next to it as `.bak`. If a file is ever damaged (say, by a
sync conflict), the trainer keeps the damaged copy as `.corrupt-<time>`, restores
the previous version, and says so in its console window. A deleted repertoire
goes to `data/trash`, with its `.bak`: to restore it, move its `.json` file back
into `data/repertoires`. A repertoire file's name is its id, so a copy you make by
hand needs a new name of lower-case letters, digits and dashes (`my-copy.json`);
the trainer skips other names and says so in its console window.

### Another data folder, or another port

The trainer keeps its data in the `data` folder beside it and answers on port
3210. To keep the data somewhere else, such as a folder OneDrive syncs, or to use
another port, set `TRAINER_DATA_DIR` or `PORT`. For `start.bat`, run these once in
a Command Prompt; they apply from the next start:

```
setx TRAINER_DATA_DIR "D:\OneDrive\Chess\trainer-data"
setx PORT 3300
```

Close the trainer and move what is in the old `data` folder to the new one first.
To go back, run `setx TRAINER_DATA_DIR ""` or `setx PORT ""`. A new port is a
new address (`http://localhost:3300`), and the browser keeps answers that are
waiting to be saved per address, so change it only when the trainer has not told
you that saving is failing. From a terminal on any system:
`TRAINER_DATA_DIR=/path/to/data PORT=3300 npm start`.

## Project layout

```
start.bat            Double-click to start: checks Node.js, installs what changed, runs the server
server.js            Express server, REST API, starts the WebSocket bridge
engine-socket.js     The WebSocket bridge to Stockfish: runs the pages' engine requests
engine.js            UCI engine manager (native .exe or bundled WASM)
lichess.js           Lichess client: OAuth, explorer (queued, cached), studies
puzzles.js           Opponent-mistake tree search and puzzle builder
store.js             JSON file storage in ./data: atomic saves, backups, the trash
repertoire-format.js The repertoire file format: typedef, version, migration, checks
settings-schema.js   Every setting: default, range, help text (drives the Settings page)
check-node.cjs       Stops with a plain message on a too-old Node.js
check-install.cjs    Tells start.bat when to install the dependencies
public/
  index.html         App shell, import map
  css/app.css        All styles (Inter, the palette, light and dark)
  js/app.js          Header, hash router and start-up
  js/nav.js          refresh(): draw the current page again
  js/api.js          The REST API, one function per route
  js/store.js        The page's copy of repertoires and settings; saveCards()
  js/outbox.js       Answers waiting to be saved, kept in the browser until the server has them
  js/ui.js           DOM helpers (h, action, toasts, dialogs), notation, sounds
  js/board.js        Chessground board, promotion, game status, eval bar
  js/engine-client.js  Browser side of the engine bridge
  js/protocol.js     The engine WebSocket's messages
  js/constants.js    Start position, position keys, scores, Lichess speeds and ratings
  js/moves.js        Playing a move from a position (UCI or SAN), for every page and the server
  js/pgn.js          PGN tokenizer and move-tree builder
  js/repertoire.js   Lines and cards from a move tree
  js/srs.js          Spaced-repetition scheduler
  js/session.js      The training rules: what a pass quizzes, how answers, surprises and play-outs are graded
  js/opponent.js     How opponents choose moves: Lichess players by popularity, surprises off your book
  js/puzzle-utils.js Puzzle queue, PGN export, explorer formatting
  js/views/          Library, repertoire, import, trainer, explore, spar, surprise,
                     audit, lichess, finder (search dialog), puzzles, settings,
                     tools (the "From this position" list beside the board)
samples/             Two sample repertoires
engine/              Where a native Stockfish .exe goes (see engine/README.txt)
test/*.test.mjs      Unit and integration tests (npm test): storage, the file format and
                     card keys, the engine and its socket, the server's API and security,
                     the Lichess client, the mistake search, PGN, moves, scheduling, the
                     training rules, opponents, the outbox, the start-up checks
test/smoke-server.mjs Boots the server and checks the API and engine (npm run test:smoke)
test/e2e/            Playwright browser tests (npm run test:e2e; test:e2e:coverage adds
                     a report of which lines of public/js they ran)
test/mock-lichess.js Offline stand-in for the Lichess API
test/helpers/, test/fixtures/  Server and mock Lichess launchers, fake Stockfish
package.json         Dependencies, pinned exactly, and the npm scripts
eslint.config.mjs, tsconfig.json  Lint and type check (npm run check)
.c8rc.json           npm test's coverage thresholds: 100%
playwright.config.mjs  Browser test settings
.github/             CI (tests, lint, browser tests, secrets scan) and Dependabot
```

## Credits

- [Stockfish](https://stockfishchess.org) (GPLv3) via
  [stockfish.js](https://github.com/nmrugg/stockfish.js) for the WebAssembly build.
- [chessground](https://github.com/lichess-org/chessground) (GPLv3), lichess's board.
- [chess.js](https://github.com/jhlywa/chess.js) for move legality.
- [Inter](https://rsms.me/inter/) (SIL Open Font License) via Fontsource.

Because Stockfish and chessground are GPLv3, this project is GPLv3 too.
