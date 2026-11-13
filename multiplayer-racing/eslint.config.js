import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'track-previews/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // The sanitiser deliberately matches control characters.
      'no-control-regex': 'off',
    },
  },
  {
    // The deterministic simulation and the protocol must not depend on a platform:
    // no DOM, no Node, no wall clock, no unseeded randomness.
    files: ['shared/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'process', 'Buffer', 'performance', 'setTimeout', 'setInterval', 'require'],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng so the simulation stays deterministic.' },
        { object: 'Date', property: 'now', message: 'The simulation must not read the wall clock.' },
      ],
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/server/**', '**/client/**', 'node:*', 'three', 'ws'], message: 'shared/ must stay platform independent.' }] }],
    },
  },
  {
    files: ['shared/net/netsim.ts'],
    // The network simulator takes its random source as a parameter; Math.random is only the default.
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['server/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/client/**', 'three'], message: 'The server must not depend on client code.' }] }],
    },
  },
  {
    files: ['client/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/server/**', 'ws', 'node:*'], message: 'The client must not depend on server code.' }] }],
      // User-controlled text must never be parsed as HTML.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent / the h() helper so user text cannot inject markup.' },
        { property: 'outerHTML', message: 'Use textContent / the h() helper so user text cannot inject markup.' },
        { property: 'insertAdjacentHTML', message: 'Use textContent / the h() helper so user text cannot inject markup.' },
      ],
    },
  },
  {
    files: ['client/vite.config.ts', 'tests/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.ts', '*.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: { globals: globals.node },
  },
);
