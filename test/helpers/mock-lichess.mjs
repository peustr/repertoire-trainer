// Starts test/mock-lichess.js on a free port for one test file.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './server.mjs';

const SCRIPT = fileURLToPath(new URL('../mock-lichess.js', import.meta.url));

/**
 * Resolves to { url, stats(), failNext(status), stop() } once the mock is listening. Rejects,
 * with whatever the mock printed, if it exits or has not started within `timeout` ms, so a
 * test file fails rather than waits. stop() resolves once the mock has exited.
 * @param {{ delay?: number, timeout?: number, env?: Record<string, string> }} [options]
 *   env: extra environment for the mock (the tests of this helper use it)
 */
export async function startMockLichess({ delay = 0, timeout = 10000, env = {} } = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_DELAY: String(delay), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });

  const stop = () => new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve(undefined); return; }
    proc.once('exit', resolve);
    proc.kill();
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Mock Lichess did not start within ${timeout} ms`)), timeout);
      proc.stdout.on('data', () => { if (output.includes('Mock Lichess on')) { clearTimeout(timer); resolve(undefined); } });
      proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Mock Lichess exited with code ${code}`)); });
    });
  } catch (err) {
    await stop();
    err.message += output ? `\nMock Lichess output:\n${output}` : '';
    throw err;
  }
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    stats: () => fetch(`${url}/__stats`).then((r) => r.json()),
    failNext: (status) => fetch(`${url}/__fail-next?status=${status}`, { method: 'POST' }),
    stop,
  };
}
