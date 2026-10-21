// The docs that describe the code's files: README.md's project layout and CLAUDE.md's
// list of shared modules. A new file, or one that changes its role, shows up here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { must } from './helpers/must.mjs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const list = (dir, pattern) => fs.readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => pattern.test(f));

test('the README’s project layout names every source file', () => {
  const readme = read('README.md');
  const layout = readme.slice(readme.indexOf('## Project layout'), readme.indexOf('## Credits'));
  const files = [
    ...list('.', /\.(js|cjs|mjs|bat)$/),
    ...list('public/js', /\.js$/).map((f) => `js/${f}`),
  ];
  const missing = files.filter((f) => !layout.includes(f));
  assert.deepEqual(missing, [], 'add them to the layout in README.md');
});

test('CLAUDE.md lists exactly the shared modules: the ones in public/js that coverage counts', () => {
  const browserOnly = JSON.parse(read('.c8rc.json')).exclude.join().match(/\{([^}]+)\}/)[1].split(',');
  const shared = list('public/js', /\.js$/).map((f) => f.replace(/\.js$/, '')).filter((m) => !browserOnly.includes(m)).sort();
  const claude = read('CLAUDE.md');
  const line = must(claude.split('\n').find((l) => l.startsWith('- **Shared modules**')));
  const listed = [...line.slice(0, line.indexOf(' run in ')).matchAll(/`(?:public\/js\/)?([\w-]+)\.js`/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, shared);
});
