// Starts the real server for a test, on a free port with a throwaway data folder.
// Never touches ./data or the network: TRAINER_DATA_DIR is a temp folder and the
// Lichess URLs point at a closed local port.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Resolves to { port, base, dataDir, output(), stop() } once the server is listening. */
export async function startServer({ env = {}, timeout = 30000 } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-test-'));
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      TRAINER_DATA_DIR: dataDir,
      LICHESS_URL: 'http://127.0.0.1:9',
      LICHESS_EXPLORER_URL: 'http://127.0.0.1:9',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });

  function stop() {
    if (proc.exitCode === null && proc.signalCode === null) {
      // The server spawns Stockfish; on Windows kill() would orphan it.
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (err) { /* already gone */ }
      } else {
        proc.kill('SIGTERM');
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start within ${timeout} ms`)), timeout);
      proc.stdout.on('data', () => { if (output.includes('is running')) { clearTimeout(timer); resolve(); } });
      proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
    });
  } catch (err) {
    stop();
    err.message += `\nServer output:\n${output}`;
    throw err;
  }
  return { port, base: `http://127.0.0.1:${port}`, dataDir, output: () => output, stop };
}
