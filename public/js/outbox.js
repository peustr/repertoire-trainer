// Progress saves that survive a server hiccup.
//
// Every save is queued in storage (localStorage in the browser, so it also survives
// a reload and is shared between tabs), sent in order, and retried with growing
// pauses until the server takes it. Each save carries an id, so the server can
// ignore one it already applied when a retry follows a lost reply.
// No DOM code here: the tests run this module in Node.

const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
// Answers that retrying cannot change: the repertoire is gone, or the data is invalid.
const PERMANENT = new Set([400, 404, 413, 422]);

function newId() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The outbox's storage in localStorage (or anything shaped like it), shared between tabs.
 * When the browser will not take a write (storage full, blocked, a private window), this
 * tab remembers how its queue differs from the stored one: the saves it could not store,
 * and the stored saves it has since sent. Reads lay those over the stored queue, so saves
 * other tabs add or send still count, and the next write that succeeds stores the lot.
 * @param {() => { getItem(key: string): string | null, setItem(key: string, value: string): void,
 *   removeItem(key: string): void }} backend  a function, because merely touching localStorage can throw
 * @param {string} key
 * @param {{ onUnstored?: () => void }} [options]  onUnstored hears when this tab starts
 *   holding saves that only it has, which a reload or closing the tab would lose
 * @returns {{ get(): any[], set(entries: any[]): void, unstored(): number }}
 */
export function webStorage(backend, key, { onUnstored = () => {} } = {}) {
  let unstored = []; // saves this tab could not store
  let sent = new Set(); // saveIds still stored only because the write that drops them failed

  function stored() {
    try {
      const entries = JSON.parse(backend().getItem(key) || '[]');
      return Array.isArray(entries) ? entries : [];
    } catch (err) {
      return [];
    }
  }

  return {
    get() {
      const entries = stored();
      if (!unstored.length && !sent.size) return entries;
      const ids = new Set(entries.map((e) => e.saveId));
      return [...entries.filter((e) => !sent.has(e.saveId)), ...unstored.filter((e) => !ids.has(e.saveId))];
    },
    set(entries) {
      try {
        backend().setItem(key, JSON.stringify(entries));
        unstored = [];
        sent = new Set();
        return;
      } catch (err) { /* worked out below */ }
      const before = stored();
      const ids = new Set(before.map((e) => e.saveId));
      const wanted = new Set(entries.map((e) => e.saveId));
      const had = unstored.length;
      unstored = entries.filter((e) => !ids.has(e.saveId));
      sent = new Set(before.filter((e) => !wanted.has(e.saveId)).map((e) => e.saveId));
      // Everything stored has been sent: clear it, so a reload cannot send it again.
      if (before.length && sent.size === before.length) {
        try { backend().removeItem(key); sent = new Set(); } catch (e) { /* still hidden from reads */ }
      }
      if (!had && unstored.length) onUnstored();
    },
    unstored: () => unstored.length,
  };
}

/** Apply card updates in place: a null state removes the card. */
export function applyCards(target, cards) {
  for (const [key, state] of Object.entries(cards || {})) {
    if (state === null) delete target[key];
    else target[key] = state;
  }
  return target;
}

/**
 * @param {object} options
 * @param {{ get(): any[] | null, set(entries: any[]): void }} options.storage
 * @param {(entry: any) => Promise<unknown>} options.send rejects with err.status for an HTTP error
 * @param {(event: { error?: any, recovered?: boolean, dropped?: any }) => void} [options.onChange]
 *   hears when saving starts failing, when it recovers, and when a save is given up for good
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 */
export function createOutbox({ storage, send, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let flushing = null;
  let attempt = 0;
  let timer = null;
  let failing = false;

  const read = () => storage.get() || [];
  // Always re-read before writing: another tab may have added or sent saves.
  const remove = (saveId) => storage.set(read().filter((e) => e.saveId !== saveId));

  /** Queue a save ({ repId, cards, tally? }) and try to send it. */
  function add(entry) {
    storage.set([...read(), { ...entry, saveId: newId() }]);
    return flush();
  }

  /** Card updates for one repertoire that the server does not have yet, merged in order. */
  function pendingCards(repId) {
    const cards = {};
    for (const e of read()) if (e.repId === repId) Object.assign(cards, e.cards);
    return cards;
  }

  /** Send everything queued. Never rejects; failures schedule a retry. */
  function flush() {
    if (!flushing) flushing = run().finally(() => { flushing = null; });
    return flushing;
  }

  /**
   * Saves for one repertoire go in order (a later one may overwrite an earlier card).
   * When one fails, the rest of that repertoire's saves wait for the retry, but other
   * repertoires' saves still go: a repertoire whose file cannot be written must not
   * hold up everything else.
   */
  async function run() {
    clearTimer(timer);
    timer = null;
    const held = new Set(); // repertoires whose next save failed in this round
    let lastError = null;
    for (;;) {
      const next = read().find((e) => !held.has(e.repId));
      if (!next) break;
      try {
        await send(next);
      } catch (err) {
        if (PERMANENT.has(err && err.status)) {
          remove(next.saveId);
          onChange({ dropped: next, error: err });
          continue;
        }
        held.add(next.repId);
        lastError = err;
        continue;
      }
      remove(next.saveId);
    }
    if (held.size) {
      if (!failing) { failing = true; onChange({ error: lastError }); }
      timer = setTimer(flush, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]);
      attempt++;
      return;
    }
    if (failing) { failing = false; onChange({ recovered: true }); }
    attempt = 0;
  }

  return { add, flush, pendingCards, size: () => read().length };
}
