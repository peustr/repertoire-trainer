// Starts test/mock-lichess.js on a free port for one test file.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './server.mjs';

const SCRIPT = fileURLToPath(new URL('../mock-lichess.js', import.meta.url));

/** Resolves to { url, stats(), failNext(status), stop() } once the mock is listening. */
export async function startMockLichess({ delay = 0 } = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_DELAY: String(delay) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('Mock Lichess on')) resolve(); });
    proc.once('exit', (code) => reject(new Error(`Mock Lichess exited with code ${code}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    stats: () => fetch(`${url}/__stats`).then((r) => r.json()),
    failNext: (status) => fetch(`${url}/__fail-next?status=${status}`, { method: 'POST' }),
    stop: () => proc.kill(),
  };
}
