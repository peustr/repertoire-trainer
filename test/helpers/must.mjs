// For tests: a value the test expects to be there. It fails the test, saying so, when the
// value is null or undefined, and hands the type checker the value without them.

import assert from 'node:assert/strict';

/**
 * @template T
 * @param {T} value
 * @param {string} [what]  what was expected, for the failure message
 * @returns {NonNullable<T>}
 */
export function must(value, what = 'a value') {
  if (value === null || value === undefined) assert.fail(`expected ${what}, got ${value}`);
  return value;
}
