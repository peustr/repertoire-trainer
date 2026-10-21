// The progress outbox (public/js/outbox.js): queued, ordered, retried saves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, applyCards, webStorage } from '../public/js/outbox.js';
import { must } from './helpers/must.mjs';

function memoryStorage(entries = []) {
  return { get: () => entries, set: (next) => { entries = next; } };
}

/** Timers that only fire when the test says so; fire() returns the delay used. */
function manualTimers() {
  const queue = [];
  return {
    setTimer: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    clearTimer: () => {},
    async fire() {
      const { fn, ms } = queue.shift();
      await fn();
      return ms;
    },
  };
}

const offline = () => Promise.reject(new TypeError('Failed to fetch'));

test('saves are sent in order and leave the queue once stored', async () => {
  const storage = memoryStorage();
  const sent = [];
  const outbox = createOutbox({ storage, send: async (e) => { sent.push(e.cards.k); } });
  await Promise.all([outbox.add({ repId: 'r', cards: { k: 1 } }), outbox.add({ repId: 'r', cards: { k: 2 } })]);
  assert.deepEqual(sent, [1, 2]);
  assert.equal(outbox.size(), 0);
});

test('a failed save is kept and retried, with growing pauses, until the server takes it', async () => {
  const timers = manualTimers();
  const events = [];
  let failures = 2;
  const stored = [];
  const outbox = createOutbox({
    storage: memoryStorage(),
    send: (e) => (failures-- > 0 ? offline() : Promise.resolve(stored.push(e))),
    onChange: (ev) => events.push(Object.keys(ev).join('+')),
    ...timers,
  });

  await outbox.add({ repId: 'r', cards: { k: 1 } });
  assert.equal(outbox.size(), 1, 'kept while the server is away');
  assert.equal(await timers.fire(), 1000);
  assert.equal(outbox.size(), 1);
  assert.equal(await timers.fire(), 2000);
  assert.equal(outbox.size(), 0);
  assert.equal(stored.length, 1);
  assert.deepEqual(events, ['error', 'recovered'], 'one warning, one all-clear');
});

test('saves left from before a reload are sent', async () => {
  const storage = memoryStorage([{ repId: 'r', cards: { k: 1 }, saveId: 'from-last-time' }]);
  const sent = [];
  const outbox = createOutbox({ storage, send: async (e) => { sent.push(e.saveId); } });
  await outbox.flush();
  assert.deepEqual(sent, ['from-last-time']);
});

test('a save the server can never accept is dropped, and the rest still go', async () => {
  const events = [];
  const sent = [];
  const outbox = createOutbox({
    storage: memoryStorage([{ repId: 'gone', cards: { k: 1 }, saveId: 'a' }, { repId: 'r', cards: { k: 2 }, saveId: 'b' }]),
    send: (e) => (e.repId === 'gone' ? Promise.reject(Object.assign(new Error('Not found'), { status: 404 })) : Promise.resolve(sent.push(e.saveId))),
    onChange: (ev) => events.push(ev.dropped ? `dropped ${ev.dropped.saveId}` : Object.keys(ev).join('+')),
  });
  await outbox.flush();
  assert.deepEqual(sent, ['b']);
  assert.deepEqual(events, ['dropped a']);
  assert.equal(outbox.size(), 0);
});

test('two tabs share one queue without losing a save', async () => {
  const storage = memoryStorage();
  const server = new Map(); // saveId -> cards, as the server dedupes by saveId
  const store = async (e) => { server.set(e.saveId, e.cards); };
  const timers = manualTimers();
  const tabA = createOutbox({ storage, send: offline, ...timers }); // this tab cannot reach the server
  const tabB = createOutbox({ storage, send: store });

  await tabA.add({ repId: 'r', cards: { a: 1 } });
  await tabB.add({ repId: 'r', cards: { b: 1 } });
  assert.deepEqual([...server.values()], [{ a: 1 }, { b: 1 }], "tab B also sent tab A's save");
  assert.equal(storage.get().length, 0);
});

test('unsaved cards for a repertoire are merged in order, removals included', () => {
  const outbox = createOutbox({
    storage: memoryStorage([
      { repId: 'r1', cards: { a: 1, b: 1 }, saveId: '1' },
      { repId: 'r2', cards: { c: 1 }, saveId: '2' },
      { repId: 'r1', cards: { b: 2, a: null }, saveId: '3' },
    ]),
    send: offline,
  });
  const unsaved = outbox.pendingCards('r1');
  assert.deepEqual(unsaved, { a: null, b: 2 });
  assert.deepEqual(applyCards({ a: 0, z: 9 }, unsaved), { z: 9, b: 2 });
});

test('a repertoire whose saves keep failing does not hold up the others', async () => {
  const timers = manualTimers();
  const events = [];
  let brokenUp = false; // the server cannot write repertoire "broken" (say, a read-only file)
  const sent = [];
  const outbox = createOutbox({
    storage: memoryStorage([
      { repId: 'broken', cards: { a: 1 }, saveId: 'a1' },
      { repId: 'r', cards: { b: 1 }, saveId: 'b1' },
      { repId: 'broken', cards: { a: 2 }, saveId: 'a2' },
      { repId: 'r', cards: { b: 2 }, saveId: 'b2' },
    ]),
    send: (e) => (e.repId === 'broken' && !brokenUp
      ? Promise.reject(Object.assign(new Error('EPERM'), { status: 500 }))
      : Promise.resolve(sent.push(e.saveId))),
    onChange: (ev) => events.push(Object.keys(ev).join('+')),
    ...timers,
  });

  await outbox.flush();
  assert.deepEqual(sent, ['b1', 'b2'], 'the other repertoire was saved');
  assert.equal(outbox.size(), 2, "the broken repertoire's saves are kept");
  assert.deepEqual(events, ['error'], 'one warning');

  brokenUp = true;
  assert.equal(await timers.fire(), 1000);
  assert.deepEqual(sent, ['b1', 'b2', 'a1', 'a2'], 'and they go, in their order, once it can be written');
  assert.equal(outbox.size(), 0);
  assert.deepEqual(events, ['error', 'recovered']);
});

/** A localStorage stand-in; full = true refuses writes as a browser does over its quota. */
function fakeLocalStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    full: false,
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem(key, value) {
      if (this.full) throw new Error('QuotaExceededError');
      items.set(key, value);
    },
    removeItem: (key) => { items.delete(key); },
  };
}

const storedIds = (local) => JSON.parse(local.items.get('outbox') || '[]').map((e) => e.saveId);

test('saves are kept, and sent, while the browser storage refuses writes', async () => {
  const older = [{ repId: 'r', cards: { a: 1 }, saveId: 'old' }];
  const local = fakeLocalStorage({ outbox: JSON.stringify(older) });
  const storage = webStorage(() => local, 'outbox');
  local.full = true;

  const timers = manualTimers();
  let online = false;
  const sent = [];
  const outbox = createOutbox({ storage, send: (e) => (online ? Promise.resolve(sent.push(e.saveId)) : offline()), ...timers });
  await outbox.add({ repId: 'r', cards: { b: 1 } });
  assert.equal(outbox.size(), 2, 'the new save is not lost behind the older stored copy');
  assert.deepEqual(outbox.pendingCards('r'), { a: 1, b: 1 });

  online = true;
  await timers.fire();
  assert.equal(sent.length, 2, 'both were sent');
  assert.equal(outbox.size(), 0);

  local.full = false;
  await outbox.add({ repId: 'r', cards: { c: 1 } });
  assert.equal(local.items.get('outbox'), '[]', 'back to storage once it takes writes again');
});

test('a tab that cannot store its saves still sees, and keeps, the ones other tabs store', () => {
  const local = fakeLocalStorage();
  const tabA = webStorage(() => local, 'outbox');
  const tabB = webStorage(() => local, 'outbox');
  local.full = true;
  tabA.set([{ saveId: 'a1' }]); // A's save stays in A's memory
  local.full = false; // space is freed, so B can store its save
  tabB.set([...tabB.get(), { saveId: 'b1' }]);

  assert.deepEqual(tabA.get().map((e) => e.saveId), ['b1', 'a1'], "A sees B's save");
  tabA.set(tabA.get().filter((e) => e.saveId !== 'a1')); // A sent its save, and this write works
  assert.deepEqual(storedIds(local), ['b1'], "B's save is still stored for B to send");
});

test('saves sent while storage refuses writes are not left there to be sent again after a reload', async () => {
  const local = fakeLocalStorage({ outbox: JSON.stringify([{ repId: 'r', cards: { a: 1 }, saveId: 'old' }]) });
  local.full = true;
  const sent = [];
  await createOutbox({ storage: webStorage(() => local, 'outbox'), send: (e) => Promise.resolve(sent.push(e.saveId)) }).flush();
  assert.deepEqual(sent, ['old']);

  const afterReload = [];
  await createOutbox({ storage: webStorage(() => local, 'outbox'), send: (e) => Promise.resolve(afterReload.push(e.saveId)) }).flush();
  assert.deepEqual(afterReload, [], 'nothing is sent twice');
});

test('a tab hears once when it starts holding saves that only it has', () => {
  const local = fakeLocalStorage();
  let heard = 0;
  const storage = webStorage(() => local, 'outbox', { onUnstored: () => { heard++; } });
  storage.set([{ saveId: 'a' }]);
  assert.equal(storage.unstored(), 0);

  local.full = true;
  storage.set([...storage.get(), { saveId: 'b' }]);
  storage.set([...storage.get(), { saveId: 'c' }]);
  assert.equal(storage.unstored(), 2);
  assert.equal(heard, 1, 'once, not for every save');

  local.full = false;
  storage.set(storage.get());
  assert.equal(storage.unstored(), 0);
  assert.deepEqual(storedIds(local), ['a', 'b', 'c'], 'all stored once the browser takes writes again');
});

test('blocked browser storage keeps the queue in memory', () => {
  const storage = webStorage(() => { throw new Error('SecurityError'); }, 'outbox');
  assert.deepEqual(storage.get(), []);
  storage.set([{ saveId: 'x' }]);
  assert.deepEqual(storage.get(), [{ saveId: 'x' }]);
});

test('a stored queue that is not a list reads as empty', () => {
  const storage = webStorage(() => fakeLocalStorage({ outbox: '{"saveId":"x"}' }), 'outbox');
  assert.deepEqual(storage.get(), []);
});

test('saves sent while storage refuses every change stay hidden, not sent again', () => {
  const backend = {
    getItem: () => JSON.stringify([{ saveId: 'a' }]),
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const storage = webStorage(() => backend, 'outbox');
  storage.set([]);
  assert.deepEqual(storage.get(), [], 'the stored copy of a sent save is not read again');
});

test('card updates for nothing change nothing', () => {
  const target = { a: 1 };
  assert.equal(applyCards(target, undefined), target);
  assert.deepEqual(target, { a: 1 });
});

test('storage that has nothing yet reads as an empty queue', () => {
  const outbox = createOutbox({ storage: { get: () => null, set: () => {} }, send: async () => {} });
  assert.equal(outbox.size(), 0);
  assert.deepEqual(outbox.pendingCards('r'), {});
});

test('saves still get an id where the browser has no crypto.randomUUID (a page not served securely)', async (t) => {
  const real = must(Object.getOwnPropertyDescriptor(globalThis, 'crypto'));
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'crypto', real));
  const ids = [];
  const outbox = createOutbox({ storage: memoryStorage(), send: async (e) => { ids.push(e.saveId); } });
  await outbox.add({ repId: 'r', cards: { a: 1 } });
  await outbox.add({ repId: 'r', cards: { b: 1 } });
  assert.match(ids[0], /^[a-z0-9]+-[a-z0-9]+$/);
  assert.notEqual(ids[0], ids[1]);
});
