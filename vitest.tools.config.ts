/**
 * Collects the BENCH suite. The engine suite has its own config
 * (`tools/dp-gnosis/vitest.config.ts`) and is run by `npm run gnosis:test`.
 *
 * The two MUST be run SEQUENTIALLY — run concurrently they have produced a
 * false red once already (GNOSIS-GUIDE.md § Landmines).
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/dp-gnosis-bench/**/*.{test,spec}.ts'],
    exclude: [...configDefaults.exclude],
    pool: 'forks',
    testTimeout: 240_000,
  },
});
