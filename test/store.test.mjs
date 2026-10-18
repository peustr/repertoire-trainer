// Storage under stress: damaged files, files held open by other programs,
// interrupted saves. Runs against a temp data folder, never ./data.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-store-'));
process.env.TRAINER_DATA_DIR = dataDir;
const store = require('../store.js');

const SETTINGS = path.join(dataDir, 'settings.json');
const REP_DIR = path.join(dataDir, 'repertoires');
const PGN = '1. e4 e5 2. Nf3 Nc6 *';

after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const repFile = (id) => path.join(REP_DIR, `${id}.json`);
const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const setAside = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.corrupt-`));
const tempFiles = () => fs.readdirSync(REP_DIR).filter((f) => f.endsWith('.tmp'));

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
  assert.equal(store.getRepertoire(rep.id).name, 'Restorable');
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

test('deleting a repertoire removes its backup too', () => {
  const rep = store.createRepertoire({ name: 'Short lived', color: 'white', pgn: PGN });
  store.patchProgress(rep.id, { cards: {} });
  assert.ok(fs.existsSync(`${repFile(rep.id)}.bak`));
  assert.equal(store.deleteRepertoire(rep.id), true);
  assert.ok(!fs.existsSync(repFile(rep.id)) && !fs.existsSync(`${repFile(rep.id)}.bak`));
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
  assert.deepEqual(store.getRepertoire(rep.id).cards, { k: { level: 1, due: 0 } });
});

test('a save that keeps failing reports the error and leaves no temp file', (t) => {
  const rep = store.createRepertoire({ name: 'Locked', color: 'white', pgn: PGN });
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  });

  assert.throws(() => store.patchProgress(rep.id, { cards: { k: { level: 1, due: 0 } } }), { code: 'EPERM' });
  assert.deepEqual(tempFiles(), []);
  t.mock.restoreAll();
  assert.deepEqual(store.getRepertoire(rep.id).cards, {}, 'the last good version is untouched');
});

test('a save retried after a lost reply is applied once', () => {
  const rep = store.createRepertoire({ name: 'Retried', color: 'white', pgn: PGN });
  const save = { cards: { k: { level: 1, due: 0 } }, tally: { date: '2026-10-18', correct: 3, wrong: 1, lines: 1 }, saveId: 'save-1' };
  store.patchProgress(rep.id, save);
  store.patchProgress(rep.id, save); // the browser never heard back, so it sent it again
  assert.deepEqual(store.getRepertoire(rep.id).history, [{ date: '2026-10-18', correct: 3, wrong: 1, lines: 1 }]);
  store.patchProgress(rep.id, { ...save, saveId: 'save-2' });
  assert.equal(store.getRepertoire(rep.id).history[0].correct, 6, 'a different save still counts');
});

test("a puzzle's line is added to the repertoire in one save, and only once", (t) => {
  const rep = store.createRepertoire({ name: 'Puzzled', color: 'white', pgn: PGN });
  store.addPuzzles(rep.id, [{ id: 'pz1', fen: 'x' }]);
  const chapter = '[Event "Punishing 1...f6"]\n\n1. e4 f6 2. Qh5+ *\n';
  const renames = t.mock.method(fs, 'renameSync');
  const first = store.addPuzzleLine(rep.id, 'pz1', chapter);
  assert.equal(renames.mock.callCount(), 1, 'the chapter and the mark go in the same write');
  renames.mock.restore();
  assert.equal(first.pgn, `${PGN}\n\n${chapter}`);
  assert.ok(first.puzzles.pz1.addedAt);

  const again = store.addPuzzleLine(rep.id, 'pz1', chapter); // a double click, or a retry
  assert.equal(again.pgn.split('Punishing').length, 2, 'the chapter is there once');
  assert.equal(again.puzzles.pz1.addedAt, first.puzzles.pz1.addedAt);
  assert.deepEqual(store.getRepertoire(rep.id), again);
});

test('adding the line of a missing puzzle, or without a chapter, is refused', () => {
  const rep = store.createRepertoire({ name: 'Refused', color: 'white', pgn: PGN });
  store.addPuzzles(rep.id, [{ id: 'pz1', fen: 'x' }]);
  assert.throws(() => store.addPuzzleLine(rep.id, 'gone', '1. e4 *'), (err) => err.status === 404);
  assert.throws(() => store.addPuzzleLine(rep.id, '__proto__', '1. e4 *'), (err) => err.status === 404);
  assert.throws(() => store.addPuzzleLine(rep.id, 'pz1', '  '), (err) => err.status === 400);
  assert.equal(store.addPuzzleLine('no-such-rep', 'pz1', '1. e4 *'), null);
  assert.equal(store.getRepertoire(rep.id).pgn, PGN);
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
  assert.equal(store.getRepertoire(rep.id).cards.k.level, 2);
  assert.deepEqual(tempFiles(), []);
  await new Promise((resolve) => ps.once('exit', resolve));
});
