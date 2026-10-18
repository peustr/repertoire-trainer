// The progress outbox (public/js/outbox.js): queued, ordered, retried saves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, applyCards } from '../public/js/outbox.js';

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
