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
 *
 * A FOURTH case is the one this command exists to make impossible to miss: an
 * index that WAS built and holds nothing while the atoms directory holds files.
 * That path has no error of its own anywhere — every query simply answers
 * nothing — so it is caught here, at the only point that knows both numbers,
 * and reported as PARTIAL under a stable machine token.
 */
import { existsSync, readdirSync } from 'node:fs';

import { buildFts5Index } from '../adapters/fts5Adapter.js';
import { buildLanceDbIndex, lanceDbAvailability } from '../adapters/lanceDbAdapter.js';
import {
  buildLanceDbDenseIndex,
  type DenseRoute
} from '../adapters/lanceDbDenseAdapter.js';
import { buildMiniSearchIndex, miniSearchAvailability } from '../adapters/miniSearchAdapter.js';
import type { AdapterName } from './adapter.js';
import { hasPersistentIndex } from './adapter.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import { ENRICHMENT_FLAG } from './enrichCommand.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL } from './outcome.js';

const NO_INDEX_NOTE =
  'adapter has no persistent index — nothing to build (no-op); retrieve scans the vault directly';

const UNKNOWN_REASON = 'its optional dependency could not be loaded';

const MARKDOWN_EXT = '.md';

/**
 * The machine token for "an index was built and it holds no atoms". The CLI is
 * driven by an agent through a bash tool, where an exit code alone cannot say
 * WHICH partial fired, so the token is named here and asserted by name rather
 * than spelled as a literal at the one place that emits it.
 */
export const INDEX_EMPTY_REASON = 'index-empty';

/** A number = how many atoms were indexed; a string = why nothing was built. */
type Builder = (context: CommandContext) => Promise<string | number>;

interface Availability {
  readonly available: boolean;
  readonly reason?: string;
}

const skipReason = (adapter: AdapterName, probe: Availability): string =>
  `index: ${adapter} was not built — ${probe.reason ?? UNKNOWN_REASON}; run \`npm install\` in tools/dp-gnosis to enable it`;

/**
 * `--enrichment` is OPT-IN at index time, with no default path: an absent flag
 * builds the single-column index this adapter has always built, byte for byte.
 * Defaulting to a conventional location would let a sidecar that happens to
 * exist change the ranking of a build nobody asked to enrich — the silent
 * failure class this project treats as a defect.
 */
const buildFts5 = async (context: CommandContext): Promise<string | number> =>
  await Promise.resolve(
    buildFts5Index({
      atomsDir: context.atomsDir,
      indexPath: context.indexPath,
      enrichmentPath: stringFlag(context.flags, ENRICHMENT_FLAG),
    })
  );

const buildMiniSearch = async (context: CommandContext): Promise<string | number> => {
  const indexed = await buildMiniSearchIndex({
    atomsDir: context.atomsDir,
    indexPath: context.indexPath,
  });
  return indexed ?? skipReason('minisearch', await miniSearchAvailability());
};

const buildLanceDb = async (context: CommandContext): Promise<string | number> => {
  const indexed = await buildLanceDbIndex({
    atomsDir: context.atomsDir,
    indexDir: context.indexPath,
  });
  return indexed ?? skipReason('lancedb', await lanceDbAvailability());
};

/**
 * The dense routes embed their corpus, so a build here REFUSES loudly (the
 * embedding client throws its own named cause) rather than reporting a skip:
 * an unavailable optional dependency means this leg cannot be built, while a
 * refused embedding means it would be built WRONG.
 */
const buildDense =
  (route: DenseRoute) =>
    async (context: CommandContext): Promise<string | number> => {
      const indexed = await buildLanceDbDenseIndex({
        atomsDir: context.atomsDir,
        indexDir: context.indexPath,
        route,
      });
      return indexed ?? skipReason(`lancedb-${route}`, await lanceDbAvailability());
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
  'lancedb-hybrid-full': buildDense('hybrid-full'),
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

const okOutcome = (context: CommandContext): CommandOutcome => ({
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

/**
 * How many `.md` files the atoms directory holds — the number the built count is
 * weighed against. It counts FILES, never parseable atoms: the gap between the
 * two IS the finding, so re-using an adapter's entry collector here would hide
 * exactly what the note has to report. One consumer, so it stays local.
 */
const markdownFileCount = (atomsDir: string): number =>
  existsSync(atomsDir)
    ? readdirSync(atomsDir, { recursive: true, encoding: 'utf8' }).filter(rel =>
      rel.endsWith(MARKDOWN_EXT)
    ).length
    : 0;

/**
 * Names the two REAL causes and never guesses between them: an atom the
 * frontmatter parser refuses, and an atoms dir that belongs to another profile.
 * Both produce this identical pair of numbers, so a note claiming one would be
 * wrong half the time.
 */
const emptyNote = (context: CommandContext, files: number): string =>
  `index: ${context.adapter} — ${files} .md file(s) under ${context.atomsDir}, 0 atoms indexed. ` +
  'Either the frontmatter parser refuses those atoms, or the atoms dir and the profile do not ' +
  'match; re-run `ingest` for this profile and compare its written count against this one.';

/**
 * `built` stays TRUE: an index WAS written — it holds nothing. Reporting it as
 * unbuilt would send a caller looking for a missing file that is right there.
 */
const emptyOutcome = (context: CommandContext, files: number): CommandOutcome => ({
  exitCode: EXIT_PARTIAL,
  data: {
    command: 'index',
    adapter: context.adapter,
    built: true,
    indexPath: context.indexPath,
    note: emptyNote(context, files),
    reason: INDEX_EMPTY_REASON,
  },
  text: emptyNote(context, files),
});

/**
 * A genuinely EMPTY atoms directory is not this defect — it is an empty corpus,
 * and an empty index over it is the correct answer — so the gate fires only when
 * files are present and none of them reached the index.
 */
const builtOutcome = (context: CommandContext, indexed: number): CommandOutcome => {
  const files = indexed === 0 ? markdownFileCount(context.atomsDir) : 0;
  return files > 0 ? emptyOutcome(context, files) : okOutcome(context);
};

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
  const outcome = await builder(context);
  return typeof outcome === 'string'
    ? skippedOutcome(context, outcome)
    : builtOutcome(context, outcome);
};

const builderFor = (context: CommandContext): Builder | undefined =>
  hasPersistentIndex(context.adapter) ? BUILDERS[context.adapter] : undefined;

export const runIndexCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const builder = builderFor(context);
  return builder === undefined ? noOp(context) : await build(context, builder);
};
