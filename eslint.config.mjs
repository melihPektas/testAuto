import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import unicorn from 'eslint-plugin-unicorn';
import importx from 'eslint-plugin-import-x';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Ignore built output and generated dirs everywhere in the monorepo. Patterns
  // are anchored with `**/` so they match regardless of the cwd `eslint .` runs
  // from (each package is linted from its own directory via turbo).
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@stylistic': stylistic,
      unicorn,
      'import-x': importx,
    },
    rules: {
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/indent': ['error', 2],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/arrow-parens': ['error', 'always'],
      'unicorn/filename-case': 'off',
      'unicorn/prefer-module': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' },
        },
      ],
    },
  },
  // Build/tooling config files (vitest.config.ts, etc.) and plain JS entry
  // points (bin/*.js launchers) are not part of any package's tsconfig
  // `include` (which is `src/**` only), so the typed "project service" parser
  // cannot resolve them. Lint them without type-aware rules — stylistic and
  // import-order rules still apply and are auto-fixable.
  {
    files: ['**/*.config.{ts,cts,mts}', '**/*.{js,cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Test files live under `test/**`, which the build tsconfig excludes (and
  // cannot include without violating `rootDir: src`). Drop type-aware linting
  // for them as well so the project service does not reject them.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'test/**/*'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'test/**/*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
