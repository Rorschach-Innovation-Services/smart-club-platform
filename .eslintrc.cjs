module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: 'detect', runtime: 'automatic' },
  },
  plugins: ['react-refresh'],
  // sst.config.ts is SST-owned infra (its own root tsconfig.json + required
  // triple-slash ambient ref); kept out of lint, same as it's out of the type gate.
  ignorePatterns: ['dist', 'node_modules', 'public', '*.config.js', '.eslintrc.cjs', 'sst.config.ts'],
  rules: {
    'react/prop-types': 'off',
    'react/jsx-no-target-blank': 'off',
    'react/no-unescaped-entities': 'off',
    'react-refresh/only-export-components': 'off',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      // TypeScript files: use the TS parser + the (non-type-checked) recommended
      // ruleset so no parserOptions.project is needed (avoids ESLint-8 project
      // resolution friction). Swap the core no-unused-vars for the TS-aware one.
      files: ['**/*.{ts,tsx}'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
      rules: {
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'warn',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
    {
      // Node-context build/config files (now that vite.config is .ts and no longer
      // matches the *.config.js ignore pattern).
      files: ['vite.config.ts'],
      env: { node: true, browser: false },
    },
  ],
};
