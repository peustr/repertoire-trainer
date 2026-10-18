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

  async function run() {
    clearTimer(timer);
    timer = null;
    for (;;) {
      const [next] = read();
      if (!next) {
        if (failing) { failing = false; onChange({ recovered: true }); }
        attempt = 0;
        return;
      }
      try {
        await send(next);
      } catch (err) {
        if (PERMANENT.has(err && err.status)) {
          remove(next.saveId);
          onChange({ dropped: next, error: err });
          continue;
        }
        if (!failing) { failing = true; onChange({ error: err }); }
        timer = setTimer(flush, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]);
        attempt++;
        return;
      }
      remove(next.saveId);
    }
  }

  return { add, flush, pendingCards, size: () => read().length };
}
