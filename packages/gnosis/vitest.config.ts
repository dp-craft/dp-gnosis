import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Isolated suite. `npm run gnosis:test` from the repo root routes here.
//
// This config stays the package-local entry point: it owns adapter-gated
// optionalDependencies that resolve from `packages/gnosis/node_modules`, and a
// missing one skips its adapter (lazy dynamic import) rather than failing the
// suite.
//
// Running bare `vitest packages/gnosis` against the APPLICATION config prints
// "No test files found" and exits 0 — a false green. Always use `gnosis:test`.
// `root` defaults to `process.cwd()`, NOT the config directory — measured: from
// the repo root, `include: ['tests/**/*.test.ts']` matched nothing and printed
// "No test files found". Anchoring root on this file makes both `include` and
// `coverage.include` package-relative regardless of the invoking directory.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text'], include: ['src/**/*.ts'] },
  },
});
