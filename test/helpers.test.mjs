// The test helpers themselves: a mock Lichess that cannot start must fail its test file at
// once, saying what it printed, and stop() must not return before the mock has gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLichess } from './helpers/mock-lichess.mjs';

test('a mock Lichess that does not start in time is stopped, and the test is told', async () => {
  await assert.rejects(startMockLichess({ timeout: 1 }), { message: /^Mock Lichess did not start within 1 ms/ });
});

test('a mock Lichess that exits says so, with what it printed', async () => {
  await assert.rejects(startMockLichess({ env: { MOCK_PORT: '99999' } }), {
    message: /^Mock Lichess exited with code 1\nMock Lichess output:[\s\S]*ERR_SOCKET_BAD_PORT/,
  });
});

test('stop() resolves once the mock has gone, and may be called again', async () => {
  const mock = await startMockLichess();
  assert.equal((await mock.stats()).explorerCalls, 0);
  await mock.stop();
  await assert.rejects(mock.stats(), 'nothing answers any more');
  await mock.stop();
});
