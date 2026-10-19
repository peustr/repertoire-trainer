// Starting the real server (server.js): what it says about its engine, the port and host
// it takes by default, and how it stops when it cannot listen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, freePort } from './helpers/server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the start-up notes name a native engine, its threads and any warning; one that will not run stops nothing', async (t) => {
  const server = await startServer({
    env: { STOCKFISH_PATH: path.join(root, 'package.json') }, // a file, but not a program
    settings: { analysisThreads: 2, enginePath: '\\\\nas\\share\\stockfish.exe' },
  });
  t.after(() => server.stop());
  await new Promise((resolve) => setTimeout(resolve, 500)); // warming up tries to start it
  const engine = await fetch(`${server.base}/api/engine`);
  assert.equal(engine.status, 200, 'still running');
  assert.match(server.output(), /Engine: native \(package\.json\), 2 threads, \d+ MB hash/);
  assert.match(server.output(), /Note: Engines on a network share are not run\./);
});

test('the start-up notes name the built-in engine, with one thread', async (t) => {
  const own = fs.readdirSync(path.join(root, 'engine')).filter((n) => /^stockfish/i.test(n));
  if (own.length) return t.skip(`this checkout has its own engine (${own[0]})`);
  const server = await startServer({ env: { STOCKFISH_PATH: '' }, settings: { analysisThreads: 1, engineBuild: 'native' } });
  t.after(() => server.stop());
  await fetch(`${server.base}/api/lichess/status`);
  assert.match(server.output(), /Engine: built-in Stockfish \([^)]+\), 1 thread, /);
  assert.match(server.output(), /Note: No stockfish \.exe in the engine folder; using the built-in one\./);
});

/** Run server.js with exactly this environment until it exits (killed after 20 s). */
function runUntilExit(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', (d) => { output += d; });
    proc.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else proc.kill('SIGKILL');
    }, 20000);
    proc.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/** This process's environment without the server settings, and a throwaway data folder. */
function plainEnv(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainer-start-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, TRAINER_DATA_DIR: dataDir, ...extra };
  for (const name of ['PORT', 'HOST', 'LICHESS_URL', 'LICHESS_EXPLORER_URL', 'ALLOWED_HOSTS']) if (!(name in extra)) delete env[name];
  return env;
}

test('by default the server takes port 3210 on this computer, and says so plainly when it is taken', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => {
    blocker.once('error', resolve); // already taken (a running trainer, say): just as good
    blocker.listen(3210, '127.0.0.1', () => resolve(undefined));
  });
  t.after(() => blocker.close());
  const { code, output } = await runUntilExit(plainEnv(t));
  assert.equal(code, 1);
  assert.match(output, /Port 3210 is already in use\. Is the trainer already running\? Try http:\/\/localhost:3210/);
});

test('any other failure to listen is shown, and the server stops', async (t) => {
  // 192.0.2.1 is reserved for documentation: no computer has it, so it cannot be listened on.
  const { code, output } = await runUntilExit(plainEnv(t, { PORT: String(await freePort()), HOST: '192.0.2.1' }));
  assert.equal(code, 1);
  assert.match(output, /EADDRNOTAVAIL/);
  assert.doesNotMatch(output, /Unhandled 'error' event/, 'reported by the server, not by Node crashing');
});
