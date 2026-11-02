import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', 'dist/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  { files: ['**/*.{js,mjs}'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
  {
    files: ['eslint.config.js', 'scripts/**/*.mjs', 'services/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['sdk/**/*.js', 'modules/**/*.js', 'tests/transport.browser.mjs'],
    languageOptions: { globals: globals.browser },
  },
];
