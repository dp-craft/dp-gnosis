/**
 * `index` — build the selected adapter's index.
 *
 * An adapter with no persistent index (linear) SUCCEEDS here as an explicit,
 * stated no-op rather than erroring. A caller scripting `index` then `retrieve`
 * must not have to know which adapters own an index; making the no-op an error
 * would push that knowledge back out to every caller.
 *
 * An adapter whose OPTIONAL dependency is absent is a third case, distinct from
 * both: nothing was built and nothing can be, so it exits PARTIAL with the
 * loader's own reason. Reporting it as success would tell a caller an index
 * exists when none does — the same conflation `indexState` exists to prevent on
 * the retrieve side.
 */
import { buildFts5Index } from '../adapters/fts5Adapter.js';
import { buildLanceDbIndex, lanceDbAvailability } from '../adapters/lanceDbAdapter.js';
import {
  buildLanceDbDenseIndex,
  type DenseRoute
} from '../adapters/lanceDbDenseAdapter.js';
import { buildMiniSearchIndex, miniSearchAvailability } from '../adapters/miniSearchAdapter.js';
import type { AdapterName } from './adapter.js';
import { hasPersistentIndex } from './adapter.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL } from './outcome.js';

const NO_INDEX_NOTE =
  'adapter has no persistent index — nothing to build (no-op); retrieve scans the vault directly';

const UNKNOWN_REASON = 'its optional dependency could not be loaded';

/** `undefined` = built; a string = the reason nothing was built. */
type Builder = (context: CommandContext) => Promise<string | undefined>;

interface Availability {
  readonly available: boolean;
  readonly reason?: string;
}

const skipReason = (adapter: AdapterName, probe: Availability): string =>
  `index: ${adapter} was not built — ${probe.reason ?? UNKNOWN_REASON}; run \`npm install\` in tools/dp-gnosis to enable it`;

const buildFts5 = async (context: CommandContext): Promise<string | undefined> => {
  buildFts5Index({ atomsDir: context.atomsDir, indexPath: context.indexPath });
  return await Promise.resolve(undefined);
};

const buildMiniSearch = async (context: CommandContext): Promise<string | undefined> => {
  const built = await buildMiniSearchIndex({
    atomsDir: context.atomsDir,
    indexPath: context.indexPath,
  });
  return built ? undefined : skipReason('minisearch', await miniSearchAvailability());
};

const buildLanceDb = async (context: CommandContext): Promise<string | undefined> => {
  const built = await buildLanceDbIndex({
    atomsDir: context.atomsDir,
    indexDir: context.indexPath,
  });
  return built ? undefined : skipReason('lancedb', await lanceDbAvailability());
};

/**
 * The dense routes embed their corpus, so a build here REFUSES loudly (the
 * embedding client throws its own named cause) rather than reporting a skip:
 * an unavailable optional dependency means this leg cannot be built, while a
 * refused embedding means it would be built WRONG.
 */
const buildDense =
  (route: DenseRoute) =>
    async (context: CommandContext): Promise<string | undefined> => {
      const built = await buildLanceDbDenseIndex({
        atomsDir: context.atomsDir,
        indexDir: context.indexPath,
        route,
      });
      return built ? undefined : skipReason(`lancedb-${route}`, await lanceDbAvailability());
    };

/**
 * One builder per index-bearing adapter. `linear` is absent by construction:
 * `hasPersistentIndex` routes it to the stated no-op before this map is read.
 */
const BUILDERS: Readonly<Partial<Record<AdapterName, Builder>>> = {
  fts5: buildFts5,
  minisearch: buildMiniSearch,
  lancedb: buildLanceDb,
  'lancedb-vec': buildDense('vec'),
  'lancedb-hybrid': buildDense('hybrid'),
};

const noOp = (context: CommandContext): CommandOutcome => ({
  exitCode: EXIT_OK,
  data: {
    command: 'index',
    adapter: context.adapter,
    built: false,
    indexPath: null,
    note: NO_INDEX_NOTE,
  },
  text: `index: ${context.adapter} — ${NO_INDEX_NOTE}`,
});

const builtOutcome = (context: CommandContext): CommandOutcome => ({
  exitCode: EXIT_OK,
  data: {
    command: 'index',
    adapter: context.adapter,
    built: true,
    indexPath: context.indexPath,
    note: `rebuilt wholesale from ${context.atomsDir}`,
  },
  text: `index: ${context.adapter} — built at ${context.indexPath}`,
});

const skippedOutcome = (context: CommandContext, reason: string): CommandOutcome => ({
  exitCode: EXIT_PARTIAL,
  data: {
    command: 'index',
    adapter: context.adapter,
    built: false,
    indexPath: null,
    note: reason,
  },
  text: reason,
});

const build = async (context: CommandContext, builder: Builder): Promise<CommandOutcome> => {
  const reason = await builder(context);
  return reason === undefined ? builtOutcome(context) : skippedOutcome(context, reason);
};

const builderFor = (context: CommandContext): Builder | undefined =>
  hasPersistentIndex(context.adapter) ? BUILDERS[context.adapter] : undefined;

export const runIndexCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const builder = builderFor(context);
  return builder === undefined ? noOp(context) : await build(context, builder);
};
