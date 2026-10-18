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

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Resolves to { port, base, dataDir, output(), stop() } once the server is listening.
 * @param {{ env?: Record<string, string>, settings?: Record<string, unknown>, timeout?: number }} [options]
 *   settings: saved in the data folder before the server starts
 */
export async function startServer({ env = {}, settings = null, timeout = 30000 } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-test-'));
  if (settings) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
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
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // closing the IPC channel asks it to stop
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });

  function kill() {
    // The server spawns Stockfish; on Windows kill() would orphan it.
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (err) { /* already gone */ }
    } else {
      proc.kill('SIGKILL');
    }
  }

  /**
   * Shut the server down the way Ctrl+C does (it stops Stockfish first) and wait until it
   * has exited, so nothing outlives the test and coverage tools see its run. Forced after 5 s.
   */
  async function stop() {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      const force = setTimeout(kill, 5000);
      if (proc.connected) proc.disconnect(); else kill();
      await exited;
      clearTimeout(force);
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
    await stop();
    err.message += `\nServer output:\n${output}`;
    throw err;
  }
  return { port, base: `http://127.0.0.1:${port}`, dataDir, output: () => output, stop };
}
