// npm run test:e2e:coverage: the browser tests, then a report of which lines of the browser
// code (public/js) they ran. There is no threshold: npm test holds the shared modules to
// 100%, and this shows what the browser-only modules and the views leave untested.
// The browser tests' fixture saves each test's coverage when E2E_COVERAGE_DIR is set.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const raw = path.join(root, 'coverage', 'e2e', 'raw'); // test/e2e/c8.json reads it from here
fs.rmSync(raw, { recursive: true, force: true });

/** Run a Node.js script from node_modules, as npx would, but without a shell. */
const run = (script, args, env = {}) => spawnSync(process.execPath, [path.join(root, 'node_modules', script), ...args], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ...env },
}).status;

const tests = run('@playwright/test/cli.js', ['test', ...process.argv.slice(2)], { E2E_COVERAGE_DIR: raw });
const report = run('c8/bin/c8.js', ['report', '--config', 'test/e2e/c8.json']);
process.exitCode = tests || report;
