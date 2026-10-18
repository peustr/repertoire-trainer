// The repertoire file format (repertoire-format.js): format versions and migration on
// read, and the checks on what the browser may write. Runs against a temp data folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-format-'));
process.env.TRAINER_DATA_DIR = dataDir;
const store = await import('../store.js'); // after the environment is set: it is read on load
const { SCHEMA_VERSION } = await import('../repertoire-format.js');

const REP_DIR = path.join(dataDir, 'repertoires');
const PGN = '1. e4 e5 2. Nf3 Nc6 *';
const file = (id) => path.join(REP_DIR, `${id}.json`);
const onDisk = (id) => JSON.parse(fs.readFileSync(file(id), 'utf8'));
const writeRaw = (rep) => { fs.mkdirSync(REP_DIR, { recursive: true }); fs.writeFileSync(file(rep.id), JSON.stringify(rep)); };

after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// What the browser really sends: an audit as audit.js builds it, and a progress save
// as the outbox sends it (srs.js card states, null to remove a card, a dated tally).
const AUDIT = {
  at: '2026-10-18T10:00:00.000Z', depth: 18, threshold: 80, checked: 12, complete: true,
  flags: { 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq|b8c6': { loss: 120, label: '2...Nc6', bestLabel: '2...Nf6', best: 'g8f6' } },
};
const STATE = { level: 3, due: 1_800_000_000_000, reps: 4, lapses: 1, last: 1_799_000_000_000 };

test('new repertoires are saved with the current format version', () => {
  const rep = store.createRepertoire({ name: 'New', color: 'white', pgn: PGN });
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(onDisk(rep.id).schemaVersion, 1);
});

test('a file from before format versions loads as version 1 and is saved as version 1', () => {
  // As older versions of the trainer wrote it: no version, history, audit or notes.
  const old = { id: 'old-one', name: 'Old', color: 'black', pgn: PGN, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z', cards: { k: STATE } };
  writeRaw(old);
  const rep = store.getRepertoire('old-one');
  assert.equal(rep.schemaVersion, 1);
  assert.deepEqual(rep.cards, old.cards, 'progress is kept');
  assert.deepEqual(rep.history, []);
  assert.equal(rep.audit, null);
  assert.equal(rep.notes, '');
  assert.equal(onDisk('old-one').schemaVersion, undefined, 'reading alone does not rewrite the file');
  assert.ok(store.listRepertoires().some((r) => r.id === 'old-one' && r.schemaVersion === 1));

  store.patchProgress('old-one', { cards: { k2: STATE } });
  const saved = onDisk('old-one');
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(Object.keys(saved.cards).sort(), ['k', 'k2']);
});

test('a file from a newer trainer is left alone, not half-read', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  writeRaw({ id: 'from-later', name: 'Later', color: 'white', pgn: PGN, cards: {}, schemaVersion: SCHEMA_VERSION + 1 });
  const before = fs.readFileSync(file('from-later'), 'utf8');
  assert.throws(() => store.getRepertoire('from-later'), { status: 409, message: /newer version of the trainer/ });
  assert.throws(() => store.patchProgress('from-later', { cards: { k: STATE } }), { status: 409 });
  assert.ok(!store.listRepertoires().some((r) => r.id === 'from-later'), 'kept out of the library');
  assert.match(String(warn.mock.calls.at(-1).arguments[0]), /from-later\.json.*newer version/);
  assert.equal(fs.readFileSync(file('from-later'), 'utf8'), before, 'the file is untouched');
});

test('what the browser sends is accepted', () => {
  const rep = store.createRepertoire({ name: 'Accepted', color: 'white', pgn: PGN, notes: 'My notes' });
  assert.equal(store.updateRepertoire(rep.id, { name: 'Renamed', notes: '', audit: AUDIT }).audit.checked, 12);
  assert.equal(store.updateRepertoire(rep.id, { audit: null }).audit, null);
  const saved = store.patchProgress(rep.id, {
    cards: { a: STATE, 'pz|abc123': { level: 1, due: 0, reps: 1, lapses: 0, last: 0 }, b: null },
    tally: { date: '2026-10-18', correct: 2, wrong: 1, lines: 1 },
    saveId: crypto.randomUUID(),
  });
  assert.deepEqual(Object.keys(saved.cards).sort(), ['a', 'pz|abc123']);
  assert.deepEqual(store.patchProgress(rep.id, { cards: {}, tally: { date: '2026-10-18', correct: 1 } }).history.at(-1), { date: '2026-10-18', correct: 3, wrong: 1, lines: 1 });
});

test('a repertoire update with the wrong shape is refused and changes nothing', () => {
  const rep = store.createRepertoire({ name: 'Guarded', color: 'white', pgn: PGN });
  const before = fs.readFileSync(file(rep.id), 'utf8');
  const bad = [
    { notes: 5 },
    { audit: 'done' },
    { audit: [] },
    { audit: { ...AUDIT, depth: 'deep' } },
    { audit: { ...AUDIT, flags: [] } },
    { audit: { ...AUDIT, flags: { k: { loss: 'a lot' } } } },
  ];
  for (const patch of bad) assert.throws(() => store.updateRepertoire(rep.id, patch), { status: 400 }, JSON.stringify(patch));
  assert.throws(() => store.createRepertoire({ name: 'X', color: 'white', pgn: PGN, notes: {} }), { status: 400 });
  assert.equal(fs.readFileSync(file(rep.id), 'utf8'), before);
});

test('a progress save with the wrong shape is refused and changes nothing', () => {
  const rep = store.createRepertoire({ name: 'Progress', color: 'white', pgn: PGN });
  const before = fs.readFileSync(file(rep.id), 'utf8');
  const bad = [
    { cards: [] },
    { cards: 'all' },
    { cards: { k: 'learned' } },
    { cards: { k: { level: 'one', due: 0 } } },
    { cards: { k: { level: 9, due: 0 } } },
    { cards: { k: { level: 2 } } },
    { cards: { k: { ...STATE, reps: -1 } } },
    { cards: JSON.parse('{"__proto__": {"level": 1, "due": 0}}') },
    { tally: 'today' },
    { tally: { date: 'yesterday', correct: 1 } },
    { tally: { date: '2026-10-18', correct: -1 } },
    { tally: { date: '2026-10-18', wrong: 1.5 } },
    { saveId: 5 },
    { saveId: 'x'.repeat(65) },
  ];
  for (const patch of bad) assert.throws(() => store.patchProgress(rep.id, patch), { status: 400 }, JSON.stringify(patch));
  assert.equal(fs.readFileSync(file(rep.id), 'utf8'), before);
});

test('the API answers 400 with the reason, for both kinds of update', async () => {
  const server = await startServer();
  try {
    const send = (method, url, body) => fetch(server.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const rep = await (await send('POST', '/api/repertoires', { name: 'Over HTTP', color: 'white', pgn: PGN })).json();
    const put = await send('PUT', `/api/repertoires/${rep.id}`, { audit: 'done' });
    assert.equal(put.status, 400);
    assert.match((await put.json()).error, /audit/);
    const patch = await send('PATCH', `/api/repertoires/${rep.id}/progress`, { cards: { k: { level: 9, due: 0 } } });
    assert.equal(patch.status, 400);
    assert.match((await patch.json()).error, /level/);
  } finally {
    await server.stop();
  }
});
