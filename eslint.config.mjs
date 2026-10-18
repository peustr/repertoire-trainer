// Lint (npm run check). Catches what tests only find late, or never: names that
// do not exist, unused code, redeclarations, and promises nobody awaits or catches.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/', 'data/', 'test-results/', 'playwright-report/', 'blob-report/'] },
  js.configs.recommended,
  {
    // Server and the scripts around it: Node, CommonJS.
    files: ['*.js', 'test/fixtures/*.js', 'test/mock-lichess.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // Tests and config: Node, ES modules.
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // The browser app. Shared modules also run in Node, so they must stick to what both have.
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // Playwright tests: code passed to page.evaluate() runs in the browser.
    files: ['test/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      // Module-level names like `const crypto = require('crypto')` may share a global's name.
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-shadow-restricted-names': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Type-aware: a promise that is neither awaited, returned nor caught fails silently.
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['eslint.config.mjs'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', {
        // node:test's test() returns a promise the runner already waits for.
        allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'it', 'describe', 'suite'], package: 'node:test' }],
      }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },
];
