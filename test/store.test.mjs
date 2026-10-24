// Storage under stress: damaged files, files held open by other programs,
// interrupted saves. Runs against a temp data folder, never ./data.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { must } from './helpers/must.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-store-'));
process.env.TRAINER_DATA_DIR = dataDir;
const store = await import('../store.js'); // after the environment is set: it is read on load

const SETTINGS = path.join(dataDir, 'settings.json');
const REP_DIR = path.join(dataDir, 'repertoires');
const TRASH = path.join(dataDir, 'trash');
const PGN = '1. e4 e5 2. Nf3 Nc6 *';

after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const repFile = (id) => path.join(REP_DIR, `${id}.json`);
const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const setAside = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.corrupt-`));
const positionOf = (fen) => fen.split(' ').slice(0, 4).join(' ');
const tempFiles = () => fs.readdirSync(REP_DIR).filter((f) => f.endsWith('.tmp'));
const trashed = (id) => fs.readdirSync(TRASH).filter((d) => d.startsWith(`${id}-`));

test('a damaged settings file is set aside and the previous version restored', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  store.saveSettings({ reviewBatch: 77 });
  store.saveSettings({ learnBatch: 9 }); // settings.json.bak now holds the first save
  fs.writeFileSync(SETTINGS, '{"reviewBatch": 77, "learnBa');

  const s = store.getSettings();
  assert.equal(s.reviewBatch, 77);
  assert.equal(s.learnBatch, 5, 'one save older');
  const aside = setAside(SETTINGS);
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, aside[0]), 'utf8'), '{"reviewBatch": 77, "learnBa');
  assert.match(warn.mock.calls[0].arguments[0], /settings\.json could not be read.*previous version was restored/);

  store.saveSettings({ theme: 'dark' });
  assert.equal(readFile(SETTINGS).reviewBatch, 77, 'an unrelated save keeps the restored values');
});

test('a saved setting the trainer does not know is ignored, and dropped at the next save', () => {
  fs.writeFileSync(SETTINGS, JSON.stringify({ reviewBatch: 33, noSuchSetting: true }));
  const read = store.getSettings();
  assert.equal(read.reviewBatch, 33);
  assert.equal('noSuchSetting' in read, false);
  store.saveSettings({ theme: 'dark' });
  const saved = readFile(SETTINGS);
  assert.equal(saved.reviewBatch, 33);
  assert.equal('noSuchSetting' in saved, false);
});

test('a settings file that holds no settings object gives the defaults, and the next save repairs it', () => {
  for (const text of ['"dark"', '42', 'true']) {
    fs.writeFileSync(SETTINGS, text);
    assert.equal(store.getSettings().reviewBatch, 20, `${text}: the defaults`);
  }
  store.saveSettings({ reviewBatch: 30 });
  assert.equal(readFile(SETTINGS).reviewBatch, 30);
  assert.equal(readFile(SETTINGS).learnBatch, 5);
});

test('without a backup, a damaged settings file is kept rather than overwritten', (t) => {
  t.mock.method(console, 'warn', () => {});
  fs.rmSync(`${SETTINGS}.bak`);
  fs.writeFileSync(SETTINGS, 'not json');
  const before = setAside(SETTINGS).length;
  assert.equal(store.getSettings().reviewBatch, 20, 'defaults');
  assert.equal(setAside(SETTINGS).length, before + 1);
  store.saveSettings({ theme: 'dark' });
  assert.ok(setAside(SETTINGS).some((f) => fs.readFileSync(path.join(dataDir, f), 'utf8') === 'not json'));
});

test('a damaged repertoire is restored from its backup and stays in the library', (t) => {
  t.mock.method(console, 'warn', () => {});
  const rep = store.createRepertoire({ name: 'Restorable', color: 'white', pgn: PGN });
  store.patchProgress(rep.id, { cards: { k: { level: 3, due: 0 } } }); // second write: .bak exists
  fs.writeFileSync(repFile(rep.id), '{"id": "trunc');

  assert.ok(store.listRepertoires().some((r) => r.id === rep.id));
  assert.equal(must(store.getRepertoire(rep.id)).name, 'Restorable');
  assert.equal(setAside(repFile(rep.id)).length, 1);
});

test('without a backup, a damaged repertoire is kept aside, not deleted', (t) => {
  t.mock.method(console, 'warn', () => {});
  const rep = store.createRepertoire({ name: 'No backup', color: 'black', pgn: PGN });
  fs.writeFileSync(repFile(rep.id), '{"id": "trunc');

  assert.ok(!store.listRepertoires().some((r) => r.id === rep.id));
  const [aside] = setAside(repFile(rep.id));
  assert.equal(fs.readFileSync(path.join(REP_DIR, aside), 'utf8'), '{"id": "trunc');
});

test('a deleted repertoire goes to the trash with its backup, and can be moved back', () => {
  const rep = store.createRepertoire({ name: 'Short lived', color: 'white', pgn: PGN });
  store.patchProgress(rep.id, { cards: { k: { level: 2, due: 0 } } });
  assert.ok(fs.existsSync(`${repFile(rep.id)}.bak`));
  assert.equal(store.deleteRepertoire(rep.id), true);
  assert.ok(!fs.existsSync(repFile(rep.id)) && !fs.existsSync(`${repFile(rep.id)}.bak`));
  assert.ok(!store.listRepertoires().some((r) => r.id === rep.id));

  const [bin] = trashed(rep.id);
  assert.match(bin, new RegExp(`^${rep.id}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z$`), 'named after the repertoire and the time');
  assert.deepEqual(fs.readdirSync(path.join(TRASH, bin)).sort(), [`${rep.id}.json`, `${rep.id}.json.bak`]);
  fs.renameSync(path.join(TRASH, bin, `${rep.id}.json`), repFile(rep.id)); // restoring it by hand
  assert.deepEqual(must(store.getRepertoire(rep.id)).cards, { k: { level: 2, due: 0 } });
});

test('a file that does not hold a repertoire is skipped, with a warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  fs.writeFileSync(repFile('not-a-rep'), '[1, 2]');
  t.after(() => fs.rmSync(repFile('not-a-rep'), { force: true }));
  assert.ok(!store.listRepertoires().some((r) => r.id === 'not-a-rep' || Array.isArray(r) || r[0] === 1));
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === '[store] Skipped not-a-rep.json: not-a-rep.json does not hold a repertoire.'));
  assert.throws(() => store.getRepertoire('not-a-rep'), { status: 500 });
});

test('a copied file is a repertoire of its own, named after its file', () => {
  const rep = store.createRepertoire({ name: 'Original', color: 'white', pgn: PGN });
  fs.copyFileSync(repFile(rep.id), repFile('original-copy'));
  const listed = store.listRepertoires().filter((r) => r.name === 'Original').map((r) => r.id);
  assert.deepEqual(listed.sort(), [rep.id, 'original-copy'].sort(), 'two entries, each opening its own file');

  store.patchProgress('original-copy', { cards: { k: { level: 2, due: 0 } } });
  assert.deepEqual(must(store.getRepertoire(rep.id)).cards, {}, 'a save to the copy leaves the original alone');
  assert.equal(readFile(repFile('original-copy')).id, 'original-copy', 'and the copy now carries its own id');
});

test('a file whose name is not an id is skipped, with a warning that says how to rename it', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const rep = store.createRepertoire({ name: 'Copied in Explorer', color: 'white', pgn: PGN });
  const copy = path.join(REP_DIR, `${rep.id} - Copy.json`);
  fs.copyFileSync(repFile(rep.id), copy);
  t.after(() => fs.rmSync(copy, { force: true }));
  assert.equal(store.listRepertoires().filter((r) => r.name === 'Copied in Explorer').length, 1);
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === `[store] Skipped ${rep.id} - Copy.json: rename it with only lower-case letters, digits and dashes, like my-repertoire.json.`));
});

test('an edit made from an older version is refused, and changes nothing', () => {
  const rep = store.createRepertoire({ name: 'Edited twice', color: 'white', pgn: PGN });
  // The version each edit page opened: well in the past, so a later save cannot share its millisecond.
  const opened = (time) => {
    fs.writeFileSync(repFile(rep.id), JSON.stringify({ ...readFile(repFile(rep.id)), updatedAt: time }));
    return time;
  };
  const first = opened('2026-01-01T00:00:00.000Z');
  store.patchProgress(rep.id, { cards: { k: { level: 1, due: 0 } } }); // training elsewhere is no conflict
  assert.equal(must(store.updateRepertoire(rep.id, { name: 'Renamed', baseUpdatedAt: first })).name, 'Renamed');

  const second = opened('2026-02-01T00:00:00.000Z');
  store.addLine(rep.id, { pgn: '1. d4 *' }); // a chapter added from another tab
  assert.throws(() => store.updateRepertoire(rep.id, { pgn: PGN, baseUpdatedAt: second }), {
    status: 409,
    message: 'This repertoire changed in another tab or window while you were editing it. Copy your changes, reload the page and edit it again.',
  });
  assert.match(must(store.getRepertoire(rep.id)).pgn, /1\. d4/, 'the added chapter is kept');
  assert.equal(must(store.updateRepertoire(rep.id, { audit: null })).audit, null, 'a change that names no version is not checked');
});

test('a save retries while another program briefly holds the file', (t) => {
  const rep = store.createRepertoire({ name: 'Busy', color: 'white', pgn: PGN });
  const realRename = fs.renameSync;
  let failures = 2;
  const rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (failures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return realRename(from, to);
  });

  store.patchProgress(rep.id, { cards: { k: { level: 1, due: 0 } } });
  assert.equal(rename.mock.callCount(), 3);
  assert.deepEqual(must(store.getRepertoire(rep.id)).cards, { k: { level: 1, due: 0 } });
});

test('a save that keeps failing reports the error and leaves no temp file', (t) => {
  const rep = store.createRepertoire({ name: 'Locked', color: 'white', pgn: PGN });
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  });

  assert.throws(() => store.patchProgress(rep.id, { cards: { k: { level: 1, due: 0 } } }), { code: 'EPERM' });
  assert.deepEqual(tempFiles(), []);
  t.mock.restoreAll();
  assert.deepEqual(must(store.getRepertoire(rep.id)).cards, {}, 'the last good version is untouched');
});

test('a save retried after a lost reply is applied once', () => {
  const rep = store.createRepertoire({ name: 'Retried', color: 'white', pgn: PGN });
  const save = { cards: { k: { level: 1, due: 0 } }, tally: { date: '2026-10-18', correct: 3, wrong: 1, lines: 1 }, saveId: 'save-1' };
  store.patchProgress(rep.id, save);
  store.patchProgress(rep.id, save); // the browser never heard back, so it sent it again
  assert.deepEqual(must(store.getRepertoire(rep.id)).history, [{ date: '2026-10-18', correct: 3, wrong: 1, lines: 1 }]);
  store.patchProgress(rep.id, { ...save, saveId: 'save-2' });
  assert.equal(must(store.getRepertoire(rep.id)).history[0].correct, 6, 'a different save still counts');
});

test("a puzzle's line is added to the repertoire in one save, and only once", (t) => {
  const rep = store.createRepertoire({ name: 'Puzzled', color: 'white', pgn: PGN });
  store.addPuzzles(rep.id, [{ id: 'pz1', fen: 'x' }]);
  const chapter = '[Event "Punishing 1...f6"]\n\n1. e4 f6 2. Qh5+ *\n';
  const renames = t.mock.method(fs, 'renameSync');
  const first = must(store.addPuzzleLine(rep.id, 'pz1', chapter));
  assert.equal(renames.mock.callCount(), 1, 'the chapter and the mark go in the same write');
  renames.mock.restore();
  assert.equal(first.pgn, `${PGN}\n\n${chapter}`);
  assert.ok(first.puzzles?.pz1.addedAt);

  const again = must(store.addPuzzleLine(rep.id, 'pz1', chapter)); // a double click, or a retry
  assert.equal(again.pgn.split('Punishing').length, 2, 'the chapter is there once');
  assert.equal(must(again.puzzles).pz1.addedAt, must(first.puzzles).pz1.addedAt);
  assert.deepEqual(store.getRepertoire(rep.id), again);
});

test('adding the line of a missing puzzle, or without a chapter, is refused', () => {
  const rep = store.createRepertoire({ name: 'Refused', color: 'white', pgn: PGN });
  store.addPuzzles(rep.id, [{ id: 'pz1', fen: 'x' }]);
  assert.throws(() => store.addPuzzleLine(rep.id, 'gone', '1. e4 *'), { status: 404 });
  assert.throws(() => store.addPuzzleLine(rep.id, '__proto__', '1. e4 *'), { status: 404 });
  assert.throws(() => store.addPuzzleLine(rep.id, 'pz1', '  '), { status: 400 });
  assert.equal(store.addPuzzleLine('no-such-rep', 'pz1', '1. e4 *'), null);
  assert.equal(must(store.getRepertoire(rep.id)).pgn, PGN);
});

test('temp files left by interrupted saves are swept', () => {
  fs.mkdirSync(REP_DIR, { recursive: true });
  const stale = [path.join(REP_DIR, 'x-1a2b3c.json.4242.1700000000000.tmp'), path.join(dataDir, 'settings.json.4242.1700000000000.tmp')];
  for (const f of stale) fs.writeFileSync(f, '{}');
  const unrelated = path.join(REP_DIR, 'notes.tmp');
  fs.writeFileSync(unrelated, 'keep me');

  store.sweepTempFiles();
  assert.ok(stale.every((f) => !fs.existsSync(f)));
  assert.ok(fs.existsSync(unrelated));
  fs.rmSync(unrelated);
});

test('Windows: a save succeeds while a sync client briefly holds the file', { skip: process.platform !== 'win32' && 'needs Windows file locking' }, async () => {
  const rep = store.createRepertoire({ name: 'Synced', color: 'white', pgn: PGN });
  const file = repFile(rep.id).replace(/'/g, "''");
  // Open the file the way OneDrive and scanners do: shared for reading, not for delete or rename.
  const ps = spawn('powershell', ['-NoProfile', '-Command',
    `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'Read'); Write-Output locked; Start-Sleep -Milliseconds 200; $f.Close()`]);
  await new Promise((resolve, reject) => {
    ps.stdout.once('data', resolve);
    ps.once('error', reject);
  });

  store.patchProgress(rep.id, { cards: { k: { level: 2, due: 0 } } });
  assert.equal(must(store.getRepertoire(rep.id)).cards.k.level, 2);
  assert.deepEqual(tempFiles(), []);
  await new Promise((resolve) => ps.once('exit', resolve));
});

test('without TRAINER_DATA_DIR, data lives in the data folder beside the app', () => {
  const env = { ...process.env };
  delete env.TRAINER_DATA_DIR;
  const storeUrl = new URL('../store.js', import.meta.url).href;
  // Loading the store touches no files, so this never reaches the real ./data.
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const s = await import(${JSON.stringify(storeUrl)}); console.log(s.DATA_DIR);`], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), path.join(fileURLToPath(new URL('..', import.meta.url)), 'data'));
});

test('a repertoire file that cannot be read is reported, not taken as missing', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  fs.mkdirSync(repFile('not-a-file'), { recursive: true });
  t.after(() => fs.rmSync(repFile('not-a-file'), { recursive: true, force: true }));
  assert.throws(() => store.getRepertoire('not-a-file'), { code: 'EISDIR' });
  assert.ok(!store.listRepertoires().some((r) => r.id === 'not-a-file'), 'the library skips it');
  assert.ok(warn.mock.calls.some((c) => /Skipped not-a-file\.json/.test(c.arguments[0])));
});

test('a damaged repertoire still opens from its backup when the backup cannot be copied back', (t) => {
  t.mock.method(console, 'warn', () => {});
  const rep = store.createRepertoire({ name: 'Read only', color: 'white', pgn: PGN });
  store.patchProgress(rep.id, { cards: { k: { level: 2, due: 0 } } }); // .bak holds the first version
  fs.writeFileSync(repFile(rep.id), '{"id": "trunc');
  t.mock.method(fs, 'copyFileSync', () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); });

  assert.equal(must(store.getRepertoire(rep.id)).name, 'Read only');
  assert.ok(!fs.existsSync(repFile(rep.id)), 'the next save writes it');
});

test('a failed save reports its own error even when its temp file cannot be removed', (t) => {
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); });
  t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); });
  assert.throws(() => store.saveSettings({ theme: 'dark' }), { code: 'ENOSPC' });
  t.mock.restoreAll();
  store.sweepTempFiles();
});

test('temp files another program still holds are left for the next start', (t) => {
  fs.mkdirSync(REP_DIR, { recursive: true });
  const held = path.join(REP_DIR, 'y-1a2b3c.json.4242.1700000000000.tmp');
  fs.writeFileSync(held, '{}');
  t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); });
  store.sweepTempFiles();
  assert.ok(fs.existsSync(held));
  t.mock.restoreAll();
  store.sweepTempFiles();
  assert.ok(!fs.existsSync(held));
});

test('a name with no letters or digits still gives a usable id', () => {
  const rep = store.createRepertoire({ name: '♞ ♞!', color: 'white', pgn: PGN });
  assert.match(rep.id, /^repertoire-[0-9a-f]{6}$/);
  assert.equal(rep.name, '♞ ♞!');
});

test('the library lists repertoires oldest first, whatever their names', async () => {
  const made = [];
  for (const name of ['Zulu', 'Alpha', 'Mike']) {
    made.push(store.createRepertoire({ name, color: 'white', pgn: PGN }).id);
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct creation times
  }
  const order = store.listRepertoires().filter((r) => made.includes(r.id)).map((r) => r.name);
  assert.deepEqual(order, ['Zulu', 'Alpha', 'Mike']);
});

test('changes to a repertoire that does not exist find nothing', () => {
  const id = 'no-such-rep';
  assert.equal(store.updateRepertoire(id, { name: 'X' }), null);
  assert.equal(store.patchProgress(id, { cards: {} }), null);
  assert.equal(store.addPuzzles(id, []), null);
  assert.equal(store.addLine(id, { pgn: '1. e4 *' }), null);
  assert.equal(store.addGaps(id, []), null);
  assert.equal(store.deleteGap(id, 'k'), null);
  assert.equal(store.deletePuzzle(id, 'p'), null);
  assert.equal(store.resetProgress(id), null);
  assert.equal(store.deleteRepertoire(id), false);
  assert.ok(!fs.existsSync(repFile(id)), 'and nothing is created');
});

test('only the last 200 save ids are remembered', () => {
  const rep = store.createRepertoire({ name: 'Many saves', color: 'white', pgn: PGN });
  const ids = Array.from({ length: 200 }, (_, i) => `s${i}`);
  fs.writeFileSync(repFile(rep.id), JSON.stringify({ ...readFile(repFile(rep.id)), appliedSaves: ids }));
  store.patchProgress(rep.id, { cards: { a: { level: 1, due: 0 } }, saveId: 's200' });
  const saved = must(must(store.getRepertoire(rep.id)).appliedSaves);
  assert.equal(saved.length, 200);
  assert.equal(saved[0], 's1');
  assert.equal(saved[199], 's200');
});

test('daily tallies keep the last 400 days, and missing counts add nothing', () => {
  const rep = store.createRepertoire({ name: 'Long streak', color: 'white', pgn: PGN });
  const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10);
  const history = Array.from({ length: 400 }, (_, i) => ({ date: day(i), correct: 1, wrong: 0, lines: 1 }));
  fs.writeFileSync(repFile(rep.id), JSON.stringify({ ...readFile(repFile(rep.id)), history }));

  store.patchProgress(rep.id, { tally: { date: day(400), wrong: 2 } }); // no cards, no correct, no lines
  const saved = must(store.getRepertoire(rep.id)).history;
  assert.equal(saved.length, 400);
  assert.equal(saved[0].date, day(1), 'the oldest day goes');
  assert.deepEqual(saved[399], { date: day(400), correct: 0, wrong: 2, lines: 0 });
});

test('a tally that arrives late, for an earlier day, is kept in date order', () => {
  const rep = store.createRepertoire({ name: 'Offline yesterday', color: 'white', pgn: PGN });
  store.patchProgress(rep.id, { tally: { date: '2026-10-18', correct: 1 } });
  store.patchProgress(rep.id, { tally: { date: '2026-10-17', correct: 2 } }); // queued offline, sent today
  assert.deepEqual(must(store.getRepertoire(rep.id)).history.map((d) => [d.date, d.correct]), [['2026-10-17', 2], ['2026-10-18', 1]]);
});

test('puzzles and gaps without an id or position are skipped', () => {
  const rep = store.createRepertoire({ name: 'Sparse', color: 'white', pgn: PGN });
  assert.deepEqual(must(store.addPuzzles(rep.id, undefined)).puzzles, {});
  const out = must(store.addPuzzles(rep.id, [null, { fen: 'x' }, { id: 'p1', fen: 'x' }]));
  assert.deepEqual(Object.keys(must(out.puzzles)), ['p1']);

  assert.deepEqual(must(store.addGaps(rep.id, undefined)).gaps, {});
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const gaps = must(must(store.addGaps(rep.id, [null, { share: 0.2 }, { fen, share: 0.2 }])).gaps);
  assert.deepEqual(Object.keys(gaps), [positionOf(fen)]);
});

test('a gap or puzzle can be dismissed for good, and progress reset', () => {
  const rep = store.createRepertoire({ name: 'Tidy', color: 'white', pgn: PGN });
  assert.equal(must(store.deleteGap(rep.id, 'nothing yet')).gaps, undefined, 'no gaps to remove from');
  assert.equal(must(store.deletePuzzle(rep.id, 'nothing yet')).puzzles, undefined);
  assert.equal(must(store.getRepertoire(rep.id)).dismissed, undefined, 'nothing removed, nothing to remember');

  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const afterF6 = 'rnbqkbnr/ppppp1pp/5p2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  store.addGaps(rep.id, [{ fen }]);
  store.addPuzzles(rep.id, [{ id: 'p1', fen: afterF6 }, { id: 'p2' }, { id: 'p3' }]);
  store.patchProgress(rep.id, { cards: { 'pz|p1': { level: 1, due: 0 }, k: { level: 2, due: 0 } }, tally: { date: '2026-10-18', correct: 1 } });

  assert.deepEqual(must(store.deleteGap(rep.id, positionOf(fen))).gaps, {});
  const after = must(store.deletePuzzle(rep.id, 'p1'));
  assert.deepEqual(Object.keys(must(after.puzzles)), ['p2', 'p3']);
  assert.deepEqual(after.cards, { k: { level: 2, due: 0 } }, "the puzzle's progress goes with it");

  // Remembered by position, so the next search leaves them out (puzzles.js).
  const remembered = () => {
    const { dismissed } = must(store.getRepertoire(rep.id));
    return [Object.keys(must(must(dismissed).gaps)), Object.keys(must(must(dismissed).puzzles))];
  };
  assert.deepEqual(remembered(), [[positionOf(fen)], [positionOf(afterF6)]]);
  assert.match(Object.values(must(must(store.getRepertoire(rep.id)).dismissed?.gaps))[0], /^\d{4}-\d\d-\d\dT/, 'with when');
  store.deleteGap(rep.id, 'no such gap');
  store.deletePuzzle(rep.id, 'p3'); // a puzzle without a position
  assert.deepEqual(remembered(), [[positionOf(fen)], [positionOf(afterF6)]], 'nothing new to remember');
  assert.deepEqual(Object.keys(must(must(store.getRepertoire(rep.id)).puzzles)), ['p2']);

  const reset = must(store.resetProgress(rep.id));
  assert.deepEqual([reset.cards, reset.history], [{}, []]);
  assert.deepEqual(Object.keys(must(must(store.getRepertoire(rep.id)).puzzles)), ['p2'], 'the puzzles stay');
});

test('a repertoire file without PGN (edited by hand) can still take a new line', () => {
  const rep = store.createRepertoire({ name: 'Hand edited', color: 'white', pgn: PGN });
  const { pgn, ...rest } = readFile(repFile(rep.id));
  assert.equal(pgn, PGN);
  fs.writeFileSync(repFile(rep.id), JSON.stringify({ ...rest, puzzles: { p1: { id: 'p1' } } }));
  assert.equal(must(store.addLine(rep.id, { pgn: '1. d4 *' })).pgn, '\n\n1. d4 *\n');

  fs.writeFileSync(repFile(rep.id), JSON.stringify({ ...rest, puzzles: { p1: { id: 'p1' } } }));
  assert.equal(must(store.addPuzzleLine(rep.id, 'p1', '1. c4 *')).pgn, '\n\n1. c4 *');
});

test('a repertoire deleted before its first change goes to the trash without a backup', () => {
  const rep = store.createRepertoire({ name: 'Brief', color: 'white', pgn: PGN });
  assert.ok(!fs.existsSync(`${repFile(rep.id)}.bak`));
  assert.equal(store.deleteRepertoire(rep.id), true);
  assert.ok(!fs.existsSync(repFile(rep.id)));
  const [bin] = trashed(rep.id);
  assert.deepEqual(fs.readdirSync(path.join(TRASH, bin)), [`${rep.id}.json`]);
});

/**
 * Record which files are flushed to disk and renamed during a save, in order.
 * @param {import('node:test').TestContext} t
 * @param {{ failFlush?: (name: string) => boolean }} [options]  flushing these files fails
 */
function watchDisk(t, { failFlush = () => false } = {}) {
  const steps = [];
  const opened = new Map();
  const { openSync, fsyncSync, renameSync } = fs;
  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    const fd = openSync(file, flags, mode);
    opened.set(fd, path.basename(String(file)));
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd) => {
    const name = opened.get(fd);
    if (failFlush(name)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    steps.push(`flush ${name}`);
    return fsyncSync(fd);
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    steps.push(`rename to ${path.basename(String(to))}`);
    return renameSync(from, to);
  });
  return steps;
}

test('a save is on the disk, and so is its backup, before it replaces the file', (t) => {
  const rep = store.createRepertoire({ name: 'Power cut', color: 'white', pgn: PGN });
  const steps = watchDisk(t);
  store.patchProgress(rep.id, { cards: { k: { level: 1, due: 0 } } });
  assert.equal(steps.length, 3, steps.join(', '));
  assert.match(steps[0], new RegExp(`^flush ${rep.id}\\.json\\.\\d+\\.\\d+\\.tmp$`), 'the new version first');
  assert.deepEqual(steps.slice(1), [`flush ${rep.id}.json.bak`, `rename to ${rep.id}.json`]);
});

test('a save that cannot reach the disk changes nothing and leaves no temp file', (t) => {
  const rep = store.createRepertoire({ name: 'Disk full', color: 'white', pgn: PGN });
  watchDisk(t, { failFlush: (name) => name.endsWith('.tmp') });
  assert.throws(() => store.patchProgress(rep.id, { cards: { k: { level: 1, due: 0 } } }), { code: 'EIO' });
  t.mock.restoreAll();
  assert.deepEqual(tempFiles(), []);
  assert.deepEqual(must(store.getRepertoire(rep.id)).cards, {}, 'the last good version is untouched');
});

test('a backup that cannot be flushed does not stop the save', (t) => {
  const rep = store.createRepertoire({ name: 'Slow backup', color: 'white', pgn: PGN });
  watchDisk(t, { failFlush: (name) => name.endsWith('.bak') });
  store.patchProgress(rep.id, { cards: { k: { level: 1, due: 0 } } });
  t.mock.restoreAll();
  assert.deepEqual(must(store.getRepertoire(rep.id)).cards, { k: { level: 1, due: 0 } });
  assert.deepEqual(readFile(`${repFile(rep.id)}.bak`).cards, {}, 'the backup holds the version before');
});

test('saving no settings changes nothing', () => {
  const before = store.getSettings();
  assert.deepEqual(store.saveSettings(null), before);
});
