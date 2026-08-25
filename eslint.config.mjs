// Flat ESLint config — the repository's sole lint + format toolchain.
// Extracted from AiChatney's config, reduced to the general TypeScript /
// functional-programming rule set that applied to its `tools/*` packages
// (the F-8 block, which listed `packages/gnosis/**`). Everything app-specific
// — React/JSX/hooks, a11y, browser globals, `src/**` layer + feature-barrel
// boundaries, electron, and the runner's `eslint-plugin-boundaries` layer tree —
// is intentionally absent: none of it has a subject in this repo.
//
// Encodes claude-artifacts/agentic-runner-rules/atoms/code/* + principles/TYPESCRIPT.md.
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

// Deterministic, idempotent import/export ordering. Strict explicit groups so the
// result is identical on every run — edit-time --fix never churns.
// Order: side-effect, node:, external pkg, relative.
const IMPORT_SORT_GROUPS = [
  ['^\\u0000'],
  ['^node:'],
  ['^@?\\w'],
  ['^\\.'],
];

// Cyclomatic-complexity tiers (decomposition.md). `complexity` reports when a
// function EXCEEDS the threshold: soft=4 warns at >4 (≥5), hard=5 errors at >5 (≥6).
export const COMPLEXITY_SOFT = 4;
export const COMPLEXITY_HARD = 5;

// functional-style.md + immutability.md: imperative constructs banned structurally.
const NO_IMPERATIVE_SYNTAX = [
  {
    selector: 'ForStatement',
    message: 'No loops — use .map/.filter/.reduce/.find (functional-style.md).',
  },
  {
    selector: 'ForInStatement',
    message: 'No loops — use Object.entries + .map (functional-style.md).',
  },
  {
    selector: 'ForOfStatement',
    message: 'No loops — use .map/.filter/.reduce/.find (functional-style.md).',
  },
  {
    selector: 'WhileStatement',
    message: 'No loops — use recursion or array methods (functional-style.md).',
  },
  {
    selector: 'DoWhileStatement',
    message: 'No loops — use recursion or array methods (functional-style.md).',
  },
  {
    selector: "VariableDeclaration[kind='let']",
    message: 'Use const — never let (functional-style.md).',
  },
  {
    selector: 'ClassDeclaration',
    message: 'No classes for business logic — use functions + types (functional-style.md).',
  },
  {
    selector: 'ExportDefaultDeclaration',
    message: 'No default exports — use named exports (TYPESCRIPT.md).',
  },
];

export const projectRules = {
  // decomposition.md
  complexity: ['warn', COMPLEXITY_SOFT],
  'max-params': ['warn', 3],
  'max-depth': ['warn', 3],
  'max-lines-per-function': ['warn', { max: 20, skipBlankLines: true, skipComments: true }],
  // functional-style.md / immutability.md
  'no-var': 'error',
  'prefer-const': 'error',
  'no-restricted-syntax': ['error', ...NO_IMPERATIVE_SYNTAX],
  // strict-typing.md
  '@typescript-eslint/no-explicit-any': 'error',
  // Honor the `_`-prefix "intentionally unused" convention (purely permissive).
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: false }],
  '@typescript-eslint/consistent-type-imports': 'warn',
  // naming-constants.md (noisy on existing code → warn while adopting)
  'no-magic-numbers': [
    'warn',
    { ignore: [-1, 0, 1, 2], ignoreArrayIndexes: true, enforceConst: true },
  ],
};

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'coverage',
      // Engine build output (checked-in compiled JS + .d.ts).
      'packages/gnosis/dist',
      // Benchmark corpora, recorded evidence, and scratch state — all generated.
      // `results/` in particular holds the byte-identity evidence the provenance
      // gates compare against (GNOSIS-BENCH.md § Provenance); it is data, not code.
      'packages/gnosis-bench/data',
      'packages/gnosis-bench/results',
      'packages/gnosis-bench/work',
      // Runtime state (vault atoms, caches, corpora) written by the engine at run time.
      'dp-gnosis/',
      // Python venv for the benchmark's metric-validation scripts.
      '**/.venv',
      '**/*.config.*',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Formatter — single quotes, semicolons, 2-space indent, es5 trailing commas,
  // as-needed arrow parens. No JSX in this repo.
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: true,
    jsx: false,
    arrowParens: false,
    braceStyle: '1tbs',
    blockSpacing: true,
    commaDangle: 'always-multiline',
  }),
  {
    files: ['**/*.{ts,mjs}'],
    rules: {
      // es5 trailing commas: arrays/objects only, not imports/calls.
      '@stylistic/comma-dangle': [
        'error',
        {
          arrays: 'always-multiline',
          objects: 'always-multiline',
          imports: 'never',
          exports: 'never',
          functions: 'never',
        },
      ],
      // Single-param arrows omit parens even with a block body: `resolve =>`.
      '@stylistic/arrow-parens': ['error', 'as-needed'],
      // Operators sit at the END of the wrapped line (`const x =\n  value`); but ternary
      // `?`/`:` AND type-union/intersection `|`/`&` go at the START (leading style) — so
      // multi-line unions read `| 'a'` / `| 'b'`, never the broken mixed `'a' |` form.
      '@stylistic/operator-linebreak': [
        'error',
        'after',
        { overrides: { '?': 'before', ':': 'before', '|': 'before', '&': 'before' } },
      ],
      // Disabled: opinionated LAYOUT rules that inflate code onto extra lines.
      '@stylistic/multiline-ternary': 'off',
      '@stylistic/indent-binary-ops': 'off',
      '@stylistic/quote-props': ['error', 'as-needed'],
    },
  },
  {
    // Deterministic import/export ordering — applies everywhere (incl. tests).
    files: ['**/*.{ts,mjs,cjs,js}'],
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': ['error', { groups: IMPORT_SORT_GROUPS }],
      'simple-import-sort/exports': 'error',
    },
  },
  {
    // Both packages adopt on the same incremental terms the AiChatney tools/ block
    // used: formatting / import-sort / no-var / unused-vars ENFORCED at error (all
    // autofixable, so the packages are clean after one sweep); the structural
    // FP + complexity + typing atoms surfaced at WARN over pre-existing debt.
    // Promote a package to error via a dedicated decomposition pass.
    files: [
      'packages/gnosis/**/*.{ts,mjs}',
      'packages/gnosis-bench/**/*.{ts,mjs}',
    ],
    rules: {
      ...projectRules,
      complexity: ['warn', COMPLEXITY_SOFT],
      'no-restricted-syntax': ['warn', ...NO_IMPERATIVE_SYNTAX],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    // Test files are exempt from FP/structure rules (principles §IV); formatting still
    // applies. Globs match this repo's actual layout: `packages/gnosis/tests/` is the
    // engine's test root, while the benchmark co-locates `*.test.ts` beside its sources
    // in `src/`, `src/fetch/`, and `scripts/`. MUST stay AFTER the package rule block
    // above, which spreads `projectRules` and would otherwise re-enable these.
    files: [
      'packages/gnosis/tests/**/*.ts',
      'packages/gnosis/**/*.{test,spec}.ts',
      'packages/gnosis-bench/**/*.{test,spec}.ts',
      'packages/gnosis-bench/fixtures/**',
      '**/__tests__/**/*.ts',
      '**/__fixtures__/**/*.ts',
    ],
    rules: {
      complexity: 'off',
      'max-lines-per-function': 'off',
      'max-params': 'off',
      'max-depth': 'off',
      'no-restricted-syntax': 'off',
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // Plain-.mjs Node scripts (typescript-eslint disables no-undef for .ts, so only
    // these need the ambient Node globals declared).
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  }
);
