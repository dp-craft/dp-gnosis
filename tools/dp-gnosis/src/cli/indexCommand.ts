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
 *
 * The same failure PER DOMAIN is reported beside it, and deliberately does NOT
 * move the exit code: a build where one domain contributed zero rows while the
 * rest indexed normally produces a plausible total, so the census (`domains`)
 * and its warning exist to make that zero legible rather than to invent a
 * second failure mode.
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
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { AtomsCensus } from './domainCensus.js';
import { atomsCensus, droppedDomains } from './domainCensus.js';
import { ENRICHMENT_FLAG } from './enrichCommand.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL } from './outcome.js';

const NO_INDEX_NOTE =
  'adapter has no persistent index — nothing to build (no-op); retrieve scans the vault directly';

const UNKNOWN_REASON = 'its optional dependency could not be loaded';

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
 * Names the two REAL causes and never guesses between them: an atom the
 * frontmatter parser refuses, and an atoms dir that belongs to another profile.
 * Both produce this identical pair of numbers, so a note claiming one would be
 * wrong half the time.
 */
const emptyNote = (context: CommandContext, files: number): string =>
  `index: ${context.adapter} — ${files} .md file(s) under ${context.atomsDir}, 0 atoms indexed. ` +
  'Either the frontmatter parser refuses those atoms, or the atoms dir and the profile do not ' +
  'match; re-run `ingest` for this profile and compare its written count against this one.';

/** One row of the per-domain split, in the wording both renderings share. */
const domainLine = (row: AtomsCensus['domains'][number]): string =>
  `${row.domain}: ${row.files} file(s) in, ${row.indexed} atom(s) out`;

const censusText = (census: AtomsCensus): string =>
  `  by domain — ${census.domains.map(domainLine).join('; ')}` +
  (census.unattributed === 0 ? '' : `; ${census.unattributed} file(s) declaring no domain`);

/**
 * A PARTIAL drop, stated as a warning and nothing more. It MUST NOT become a
 * new failure mode: the exit code stays exactly what the whole-index rule made
 * it, and this only makes the zero visible to whoever reads the run.
 */
const dropWarning = (dropped: readonly string[]): string =>
  `index: domain(s) ${dropped.join(', ')} contributed .md file(s) and 0 atoms — the rest of the ` +
  'corpus indexed normally, so no total reports this; re-run `ingest` for this profile and ' +
  'compare that domain\'s written count against this one.';

/** Absent unless a domain really dropped, so its PRESENCE is the signal. */
const warningFields = (census: AtomsCensus): Readonly<Record<string, unknown>> => {
  const dropped = droppedDomains(census);
  return dropped.length === 0 ? {} : { warning: dropWarning(dropped) };
};

/** The census fields both outcomes carry, so a caller reads one shape either way. */
const censusFields = (census: AtomsCensus): Readonly<Record<string, unknown>> => ({
  domains: census.domains,
  unattributed: census.unattributed,
  ...warningFields(census),
});

/**
 * `built` stays TRUE: an index WAS written — it holds nothing. Reporting it as
 * unbuilt would send a caller looking for a missing file that is right there.
 */
const emptyOutcome = (context: CommandContext, census: AtomsCensus): CommandOutcome => ({
  exitCode: EXIT_PARTIAL,
  data: {
    command: 'index',
    adapter: context.adapter,
    built: true,
    indexPath: context.indexPath,
    note: emptyNote(context, census.files),
    reason: INDEX_EMPTY_REASON,
    ...censusFields(census),
  },
  text: [emptyNote(context, census.files), ...censusLines(census)].join('\n'),
});

/** The census lines a rendering carries: the split, and the warning if one fired. */
const censusLines = (census: AtomsCensus): readonly string[] => {
  const dropped = droppedDomains(census);
  return [censusText(census), ...(dropped.length === 0 ? [] : [dropWarning(dropped)])];
};

/** Same census on the success path, exit code untouched. */
const withCensus = (outcome: CommandOutcome, census: AtomsCensus): CommandOutcome => ({
  ...outcome,
  data: { ...outcome.data, ...censusFields(census) },
  text: [outcome.text, ...censusLines(census)].join('\n'),
});

/**
 * A genuinely EMPTY atoms directory is not this defect — it is an empty corpus,
 * and an empty index over it is the correct answer — so the gate fires only when
 * files are present and none of them reached the index.
 */
const builtOutcome = (context: CommandContext, indexed: number): CommandOutcome => {
  const census = atomsCensus(context.atomsDir, context.profile.domains);
  return indexed === 0 && census.files > 0
    ? emptyOutcome(context, census)
    : withCensus(okOutcome(context), census);
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
