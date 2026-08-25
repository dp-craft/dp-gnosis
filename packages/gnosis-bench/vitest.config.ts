/**
 * Collects the BENCH suite. The engine suite has its own config
 * (`packages/gnosis/vitest.config.ts`) and is run by `npm run gnosis:test`.
 *
 * The two MUST be run SEQUENTIALLY — run concurrently they have produced a
 * false red once already (GNOSIS-GUIDE.md § Landmines).
 *
 * `root` is anchored on THIS FILE's directory, not `process.cwd()`, exactly as
 * the engine's config already does: `npm run bench:test` invokes vitest from
 * the repo root, and a cwd-relative `include` matched nothing there and printed
 * "No test files found" — a false green.
 *
 * `include` names its directories EXPLICITLY rather than `**`. A bare `**`
 * under this root would walk `results/` — gigabytes of recorded .trec evidence
 * — plus `data/` and `work/`, none of which `configDefaults.exclude` covers.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
    exclude: [...configDefaults.exclude],
    pool: 'forks',
    testTimeout: 240_000,
  },
});
