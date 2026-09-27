import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** Packages talk to each other only through their public index (`@yandecode/<pkg>`). */
const packageBoundary = (pkg, others) => ({
  files: [`packages/${pkg}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: others.map((o) => `@${o}/*`),
            message: `Import other packages through @yandecode/<package>, not their internals.`,
          },
          {
            group: ['../*'],
            message: 'Use the package alias (e.g. @cli/…) instead of parent-relative imports.',
          },
        ],
      },
    ],
  },
});

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.yandecode/**',
      'coverage/**',
      'fixtures/**',
      'examples/demo/project/**',
      'benchmarks/rag/token-savings.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always'],
      complexity: ['error', 15],
      'no-console': 'error',
    },
  },
  packageBoundary('core', ['retrieval', 'cli']),
  packageBoundary('retrieval', ['core', 'cli']),
  packageBoundary('cli', ['core', 'retrieval']),
  {
    files: ['**/*.js', '**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    // Plain JavaScript cannot declare the types this rule asks for.
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['packages/*/test/fixtures/**/*.mjs'],
    languageOptions: { globals: { Buffer: 'readonly', process: 'readonly' } },
  },
  {
    files: ['scripts/**/*.mjs', 'examples/**/*.mjs', 'benchmarks/**/*.ts', 'benchmarks/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
