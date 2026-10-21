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
const { SCHEMA_VERSION, migrate, checkRepertoireInput, checkProgress } = await import('../repertoire-format.js');

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
  const { updatedAt } = store.getRepertoire(rep.id);
  assert.equal(store.updateRepertoire(rep.id, { name: 'Edited', color: 'black', pgn: PGN, baseUpdatedAt: updatedAt }).color, 'black', 'the edit form');
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
    { name: 'X', baseUpdatedAt: 1700000000000 },
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

const CHAPTER = '[Event "Surprise: 2...d6"]\n[ChapterName "Answer to 2...d6"]\n\n1. e4 e5 2. Nf3 d6 { Played in 9% of Lichess games here (1600–1999). } 3. d4 *\n';

test('a line is added as a new chapter at the end, and answers its gap', () => {
  const rep = store.createRepertoire({ name: 'Growing', color: 'white', pgn: PGN });
  store.addGaps(rep.id, [{ fen: 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3', lineMoves: ['e2e4', 'e7e5', 'g1f3', 'd7d6'], share: 0.09 }]);
  const [gapKey] = Object.keys(onDisk(rep.id).gaps);
  const saved = store.addLine(rep.id, { pgn: CHAPTER, gapKey });
  assert.equal(saved.pgn, `${PGN}\n\n${CHAPTER}`);
  assert.deepEqual(onDisk(rep.id).gaps, {}, 'the gap is answered now');
  assert.equal(onDisk(rep.id).pgn, saved.pgn);
  assert.ok(store.addLine(rep.id, { pgn: CHAPTER, gapKey: 'not-a-gap' }), 'an unknown gap is no reason to refuse the line');
  assert.equal(store.addLine('no-such-rep', { pgn: CHAPTER }), null);
});

test('a line to add with the wrong shape is refused and changes nothing', () => {
  const rep = store.createRepertoire({ name: 'Picky', color: 'white', pgn: PGN });
  const before = fs.readFileSync(file(rep.id), 'utf8');
  const bad = [
    [undefined, /missing/],
    ['   ', /missing/],
    [42, /missing/],
    ['[Event "Just headers"]\n\n*', /no moves/],
    ['1. e4 e5 *\n\n1. d4 d5 *', /one line/],
    ['1. e4 e5 2. Ke3 *', /could not be read.*Ke3/],
    [`1. e4 { ${'x'.repeat(20000)} } *`, /too long/],
  ];
  for (const [pgn, message] of bad) assert.throws(() => store.addLine(rep.id, { pgn }), { status: 400, message }, String(pgn).slice(0, 40));
  assert.equal(fs.readFileSync(file(rep.id), 'utf8'), before);
});

test('the API answers 400 with the reason, for every kind of update', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const send = (method, url, body) => fetch(server.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rep = await (await send('POST', '/api/repertoires', { name: 'Over HTTP', color: 'white', pgn: PGN })).json();
  const put = await send('PUT', `/api/repertoires/${rep.id}`, { audit: 'done' });
  assert.equal(put.status, 400);
  assert.match((await put.json()).error, /audit/);
  const patch = await send('PATCH', `/api/repertoires/${rep.id}/progress`, { cards: { k: { level: 9, due: 0 } } });
  assert.equal(patch.status, 400);
  assert.match((await patch.json()).error, /level/);
  const badLine = await send('POST', `/api/repertoires/${rep.id}/lines`, { pgn: '1. e4 e5 2. Ke3 *' });
  assert.equal(badLine.status, 400);
  assert.match((await badLine.json()).error, /could not be read/);

  const added = await send('POST', `/api/repertoires/${rep.id}/lines`, { pgn: CHAPTER });
  assert.equal(added.status, 200);
  assert.match((await added.json()).pgn, /Answer to 2\.\.\.d6/);
  assert.equal((await send('POST', '/api/repertoires/no-such-rep/lines', { pgn: CHAPTER })).status, 404);
  assert.equal((await send('POST', '/api/repertoires/Bad..Id/lines', { pgn: CHAPTER })).status, 400, 'ids are checked before they touch the disk');
});

test('a file with a version that makes no sense is refused', () => {
  for (const schemaVersion of [0, -1, 1.5, 'one', null]) {
    assert.throws(() => migrate({ id: 'odd', schemaVersion }, 'odd.json'), { status: 500, message: /^odd\.json has an unknown format version/ }, String(schemaVersion));
  }
});

test('a file that does not hold an object is not a repertoire', () => {
  for (const value of [[], [1, 2], 'text', 5, true]) {
    assert.throws(() => migrate(value, 'odd.json'), { status: 500, message: 'odd.json does not hold a repertoire.' }, JSON.stringify(value));
  }
});

test('parts of an old file in the wrong shape are replaced by empty ones', () => {
  const rep = migrate({ id: 'messy', notes: 5, cards: [], history: {}, audit: 'done' });
  assert.deepEqual([rep.notes, rep.cards, rep.history, rep.audit], ['', {}, [], null]);
});

test('a new repertoire needs a name, a colour and some PGN', () => {
  assert.throws(() => checkRepertoireInput({}), { status: 400, message: 'Give the repertoire a name. Choose White or Black. Paste or upload some PGN.' });
  assert.throws(() => checkRepertoireInput({ name: '  ', color: 'red', pgn: ' ' }), { message: 'Give the repertoire a name. Choose White or Black. Paste or upload some PGN.' });
  assert.throws(() => checkRepertoireInput({ name: '' }, true), { message: 'Give the repertoire a name.' }, 'a change may not clear the name');
  for (const input of [null, [], 'name', 5]) {
    assert.throws(() => checkRepertoireInput(input), { status: 400, message: 'Send the repertoire as a JSON object.' });
    assert.throws(() => checkProgress(input), { status: 400, message: 'Send the progress as a JSON object.' });
  }
});

test('a card whose last review time is not a time is refused', () => {
  assert.throws(() => checkProgress({ cards: { k: { ...STATE, last: 'yesterday' } } }), { status: 400, message: 'The card k has a bad last.' });
  assert.doesNotThrow(() => checkProgress({ cards: { k: { ...STATE, last: 0 } } }));
});
