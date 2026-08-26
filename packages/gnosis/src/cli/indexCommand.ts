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
import {
  buildFts5Index,
  type KeywordCensus,
  readEmptyBodyAtoms,
  readEnrichmentRecords,
  readKeywordCensus
} from '../adapters/fts5Adapter.js';
import { buildLanceDbIndex, lanceDbAvailability } from '../adapters/lanceDbAdapter.js';
import {
  buildLanceDbDenseIndex,
  type DenseRoute
} from '../adapters/lanceDbDenseAdapter.js';
import { buildMiniSearchIndex, miniSearchAvailability } from '../adapters/miniSearchAdapter.js';
import {
  BODY_SOURCES,
  type BodySource,
  DEFAULT_BODY_SOURCE,
  DEFAULT_ENRICHMENT_COLUMN_SPEC,
  DEFAULT_ENRICHMENT_COLUMNS,
  DEFAULT_KEYWORD_FILTER,
  type EnrichmentColumnSpec,
  KEYWORD_FILTERS,
  type KeywordFilter,
  parseEnrichmentColumns
} from '../config.js';
import type { AdapterName } from './adapter.js';
import { hasPersistentIndex } from './adapter.js';
import type { FlagValues } from './args.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { AtomsCensus } from './domainCensus.js';
import { atomsCensus, droppedDomains } from './domainCensus.js';
import { ENRICHMENT_FLAG } from './enrichCommand.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

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

/**
 * The two machine tokens for "the build produced NONE of what was asked for".
 * Both name a build that WROTE a real index and refused the treatment its
 * caller named — exit 3's definition — and both are asserted by NAME for the
 * reason {@link INDEX_EMPTY_REASON} is: an exit code alone cannot say which
 * partial fired.
 */
export const ENRICHMENT_EMPTY_REASON = 'enrichment-none-merged';

export const BODY_SOURCE_EMPTY_REASON = 'body-source-all-empty';

/** A number = how many atoms were indexed; a string = why nothing was built. */
type Builder = (context: CommandContext) => Promise<string | number>;

interface Availability {
  readonly available: boolean;
  readonly reason?: string;
}

const skipReason = (adapter: AdapterName, probe: Availability): string =>
  `index: ${adapter} was not built — ${probe.reason ?? UNKNOWN_REASON}; run \`npm install\` in packages/gnosis to enable it`;

/**
 * WHERE the `body` column's text comes from. OPT-IN like `--enrichment`: an
 * absent flag builds the body from the atom, which is the index every recorded
 * number was measured on.
 */
export const BODY_SOURCE_FLAG = '--body-source';

/** The named source, or the default. An unknown name never reaches here. */
const bodySourceOf = (flags: FlagValues): BodySource => {
  const raw = stringFlag(flags, BODY_SOURCE_FLAG);
  return BODY_SOURCES.find(source => source === raw) ?? DEFAULT_BODY_SOURCE;
};

/**
 * A name outside the vocabulary is a USAGE error, never a silent fallback: a
 * build that quietly indexed the atom body under a caller who asked for
 * summaries would be reported as the arm they asked for.
 */
const bodySourceError = (flags: FlagValues): string | undefined => {
  const raw = stringFlag(flags, BODY_SOURCE_FLAG);
  return raw === undefined || BODY_SOURCES.some(source => source === raw)
    ? undefined
    : `${BODY_SOURCE_FLAG} names no body source: "${raw}" — pass one of: ${BODY_SOURCES.join(', ')}`;
};

/**
 * WHETHER a keyword that merely re-emits body vocabulary reaches the index.
 * OPT-IN like `--body-source`: an absent flag keeps every generated keyword,
 * which is the index every recorded number was measured on.
 */
export const KEYWORD_FILTER_FLAG = '--keyword-filter';

/** The named filter, or the default. An unknown name never reaches here. */
const keywordFilterOf = (flags: FlagValues): KeywordFilter => {
  const raw = stringFlag(flags, KEYWORD_FILTER_FLAG);
  return KEYWORD_FILTERS.find(filter => filter === raw) ?? DEFAULT_KEYWORD_FILTER;
};

/** A name outside the vocabulary is a USAGE error, for `--body-source`'s reason. */
const keywordFilterError = (flags: FlagValues): string | undefined => {
  const raw = stringFlag(flags, KEYWORD_FILTER_FLAG);
  return raw === undefined || KEYWORD_FILTERS.some(filter => filter === raw)
    ? undefined
    : `${KEYWORD_FILTER_FLAG} names no keyword filter: "${raw}" — pass one of: ${KEYWORD_FILTERS.join(', ')}`;
};

/**
 * WHICH enrichment columns the build populates. OPT-IN like `--keyword-filter`:
 * an absent flag populates every column the sidecar offers, which is the index
 * every recorded number was measured on.
 */
export const ENRICHMENT_COLUMNS_FLAG = '--enrichment-columns';

/** The named selection, or the default. An unparseable value never reaches here. */
const enrichmentColumnsOf = (flags: FlagValues): EnrichmentColumnSpec => {
  const raw = stringFlag(flags, ENRICHMENT_COLUMNS_FLAG);
  const parsed = raw === undefined ? undefined : parseEnrichmentColumns(raw);
  return parsed?.ok === true ? parsed.spec : DEFAULT_ENRICHMENT_COLUMN_SPEC;
};

/** A value naming no column is a USAGE error, for `--body-source`'s reason. */
const enrichmentColumnsError = (flags: FlagValues): string | undefined => {
  const raw = stringFlag(flags, ENRICHMENT_COLUMNS_FLAG);
  const parsed = raw === undefined ? undefined : parseEnrichmentColumns(raw);
  return parsed === undefined || parsed.ok
    ? undefined
    : `${ENRICHMENT_COLUMNS_FLAG} ${parsed.reason}`;
};

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
      bodySource: bodySourceOf(context.flags),
      keywordFilter: keywordFilterOf(context.flags),
      enrichmentColumns: enrichmentColumnsOf(context.flags),
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

/** The one adapter whose build merges an enrichment sidecar. */
const ENRICHED_ADAPTER: AdapterName = 'fts5';

/** What a run that NAMED a sidecar has to report: the file, and what it merged. */
interface EnrichmentReport {
  readonly path: string;
  readonly merged: number;
}

/**
 * `undefined` unless this run named a sidecar on the adapter that merges one —
 * an unenriched build reports exactly what it always did.
 *
 * The count is READ BACK off the stamp the build just wrote, never recounted
 * from the sidecar: the sidecar states what was OFFERED, and the fact worth
 * reporting is what was MERGED. An absent stamp reads as 0, which warns —
 * visible is the safe direction for a build that cannot prove it enriched.
 */
const enrichmentReport = (context: CommandContext): EnrichmentReport | undefined => {
  const path = stringFlag(context.flags, ENRICHMENT_FLAG);
  return path === undefined || context.adapter !== ENRICHED_ADAPTER
    ? undefined
    : { path, merged: readEnrichmentRecords(context.indexPath) ?? 0 };
};

const mergedLine = (report: EnrichmentReport): string =>
  `index: ${report.merged} enrichment record(s) merged from ${report.path}`;

/**
 * The silent hole this closes: `index` WITHOUT `--enrichment` and `index` with a
 * sidecar that matched no atom produce the identical index — empty enrichment
 * columns, exit 0, baseline results — so a forgotten or mismatched sidecar costs
 * an enrichment run and says nothing. Stated as a warning only: like a dropped
 * domain, it MUST NOT move the exit code, since the index itself is sound.
 */
const zeroMergedWarning = (report: EnrichmentReport): string =>
  `index: ${ENRICHMENT_FLAG} named ${report.path} and 0 record(s) merged — every enrichment ` +
  'column is empty, so this index ranks exactly as an unenriched one; check that the sidecar ' +
  'was written for THIS atoms dir, and re-run `enrich` for this profile if it was not.';

/**
 * Its OWN key, deliberately not the census's `warning`: both can fire on one
 * build, and sharing the key would let whichever is merged last erase the other
 * — a silent drop is the failure class this command exists to report.
 */
const enrichmentFields = (report: EnrichmentReport): Readonly<Record<string, unknown>> => ({
  enrichmentRecords: report.merged,
  ...(report.merged === 0 ? { enrichmentWarning: zeroMergedWarning(report) } : {}),
});

const enrichmentLines = (report: EnrichmentReport): readonly string[] => [
  mergedLine(report),
  ...(report.merged === 0 ? [zeroMergedWarning(report)] : []),
];

/** What a GENERATED-body run has to report: the source, and what it left empty. */
interface BodySourceReport {
  readonly source: BodySource;
  readonly empty: number;
}

/**
 * `undefined` unless this run really generated a body on the adapter that can —
 * a default build reports exactly what it always did.
 *
 * The count is READ BACK off the stamp the build just wrote, for the reason the
 * enrichment count is: the sidecar states what was offered, and the fact worth
 * reporting is how many atoms ended up with NO body text at all.
 */
const bodySourceReport = (context: CommandContext): BodySourceReport | undefined => {
  const source = bodySourceOf(context.flags);
  return source === DEFAULT_BODY_SOURCE || context.adapter !== ENRICHED_ADAPTER
    ? undefined
    : { source, empty: readEmptyBodyAtoms(context.indexPath) ?? 0 };
};

const bodySourceLine = (report: BodySourceReport): string =>
  `index: body column built from ${BODY_SOURCE_FLAG} ${report.source} — ` +
  `${report.empty} atom(s) with an empty body`;

/**
 * The silent hole this closes: under a generated source an atom with no sidecar
 * record carries an EMPTY body, matches no body term, and the build still exits
 * 0 over a plausible atom count. Stated as a warning only — like the enrichment
 * and domain warnings it MUST NOT move the exit code; the index itself is sound.
 */
const emptyBodyWarning = (report: BodySourceReport): string =>
  `index: ${BODY_SOURCE_FLAG} ${report.source} left ${report.empty} atom(s) with an EMPTY body — ` +
  'no body term can reach them, so they are indexed and unfindable; enrich those atoms and ' +
  're-run, or build with the atom body.';

/** Its OWN key, for the reason the enrichment warning has one: both can fire. */
const bodySourceFields = (report: BodySourceReport): Readonly<Record<string, unknown>> => ({
  bodySource: report.source,
  emptyBodyAtoms: report.empty,
  ...(report.empty === 0 ? {} : { bodySourceWarning: emptyBodyWarning(report) }),
});

const bodySourceLines = (report: BodySourceReport): readonly string[] => [
  bodySourceLine(report),
  ...(report.empty === 0 ? [] : [emptyBodyWarning(report)]),
];

/** What a FILTERED-keyword run has to report: the filter, and both counts. */
interface KeywordFilterReport {
  readonly filter: KeywordFilter;
  readonly census: KeywordCensus;
}

/**
 * `undefined` unless this run really filtered keywords on the adapter that can —
 * an unfiltered build reports exactly what it always did.
 *
 * The counts are READ BACK off the stamp the build just wrote, for the reason
 * the enrichment count is: the sidecar states what was OFFERED, and the fact
 * worth reporting is what the index HOLDS.
 */
const keywordFilterReport = (context: CommandContext): KeywordFilterReport | undefined => {
  const filter = keywordFilterOf(context.flags);
  return filter === DEFAULT_KEYWORD_FILTER || context.adapter !== ENRICHED_ADAPTER
    ? undefined
    : { filter, census: readKeywordCensus(context.indexPath) ?? { kept: 0, dropped: 0 } };
};

/** The echo rate is stated as a PERCENTAGE, so the ratio is scaled by this. */
const PERCENT = 100;

/** Keywords OFFERED to this build — the denominator of its own echo rate. */
const offeredKeywords = (census: KeywordCensus): number => census.kept + census.dropped;

/**
 * The echo rate THIS run measured, or nothing at all when no keyword was
 * offered. A build with no keywords has no rate: printing `NaN %`, or a `0 %`
 * that reads as "this corpus barely echoes", would both be a number the run
 * never measured.
 */
const echoRate = (census: KeywordCensus): string =>
  offeredKeywords(census) === 0
    ? ''
    : ` (${((census.dropped / offeredKeywords(census)) * PERCENT).toFixed(1)} %)`;

/**
 * The rate is stated PER RUN because it is a property of the corpus and the
 * generator, not of this code: it was measured at 71.3 % on `vault` (300
 * keywords) and 78.7 % on `nfcorpus` (1018), so no default could describe both.
 */
const keywordFilterLine = (report: KeywordFilterReport): string =>
  `index: ${KEYWORD_FILTER_FLAG} ${report.filter} dropped ${report.census.dropped} of ` +
  `${offeredKeywords(report.census)} keyword(s)${echoRate(report.census)} as pure body echo — ` +
  `${report.census.kept} kept. The rate is a property of THIS corpus and generator; read it ` +
  'off this run rather than from another.';

const keywordFilterFields = (report: KeywordFilterReport): Readonly<Record<string, unknown>> => ({
  keywordFilter: report.filter,
  keywordsKept: report.census.kept,
  keywordsDropped: report.census.dropped,
});

/**
 * `undefined` unless this run really left a column out on the adapter that has
 * those columns — a full build reports exactly what it always did.
 */
const enrichmentColumnsReport = (context: CommandContext): string | undefined => {
  const spec = enrichmentColumnsOf(context.flags);
  return spec.label === DEFAULT_ENRICHMENT_COLUMNS || context.adapter !== ENRICHED_ADAPTER
    ? undefined
    : spec.label;
};

/**
 * The columns left out are stated as well as the ones kept: "populated
 * questions" and "populated questions, and nothing else" are the same index and
 * very different readings of a bench row.
 */
const enrichmentColumnsLine = (label: string): string =>
  `index: ${ENRICHMENT_COLUMNS_FLAG} ${label} — only those enrichment columns were populated; ` +
  'every other one is EMPTY and contributes no term.';

/** Same selected-columns report in both renderings, exit code untouched. */
const withEnrichmentColumns = (
  outcome: CommandOutcome,
  label: string | undefined
): CommandOutcome =>
  label === undefined
    ? outcome
    : {
        ...outcome,
        data: { ...outcome.data, enrichmentColumns: label },
        text: [outcome.text, enrichmentColumnsLine(label)].join('\n'),
      };

/** Same keyword-filter report in both renderings, exit code untouched. */
const withKeywordFilter = (
  outcome: CommandOutcome,
  report: KeywordFilterReport | undefined
): CommandOutcome =>
  report === undefined
    ? outcome
    : {
        ...outcome,
        data: { ...outcome.data, ...keywordFilterFields(report) },
        text: [outcome.text, keywordFilterLine(report)].join('\n'),
      };

/** Same body-source report in both renderings, exit code untouched. */
const withBodySource = (
  outcome: CommandOutcome,
  report: BodySourceReport | undefined
): CommandOutcome =>
  report === undefined
    ? outcome
    : {
        ...outcome,
        data: { ...outcome.data, ...bodySourceFields(report) },
        text: [outcome.text, ...bodySourceLines(report)].join('\n'),
      };

/** Same enrichment report in both renderings, exit code untouched. */
const withEnrichment = (
  outcome: CommandOutcome,
  report: EnrichmentReport | undefined
): CommandOutcome =>
  report === undefined
    ? outcome
    : {
        ...outcome,
        data: { ...outcome.data, ...enrichmentFields(report) },
        text: [outcome.text, ...enrichmentLines(report)].join('\n'),
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
 * A sidecar was NAMED and not one record merged: every enrichment column is
 * empty, so the caller got NONE of the enrichment they asked for. A PARTIAL
 * merge is a different fact and keeps its warning at exit 0 — escalating it too
 * would make the code unreadable as a signal.
 */
const enrichmentTotalFailure = (report: EnrichmentReport | undefined): boolean =>
  report !== undefined && report.merged === 0;

/**
 * A generated body left EVERY indexed atom empty: no body term reaches any atom,
 * so the caller got NONE of the body they asked for. `indexed > 0` is required —
 * an empty corpus leaves nothing to be empty, and its own gate already covers it.
 */
const bodySourceTotalFailure = (
  report: BodySourceReport | undefined,
  indexed: number
): boolean => report !== undefined && indexed > 0 && report.empty === indexed;

/**
 * The ONE reason a total failure reports. Enrichment is named FIRST because it
 * is the root when both fire: a generated body is built FROM the sidecar, so a
 * sidecar that merged nothing is why every body is empty.
 */
const totalFailureReason = (
  enrichment: EnrichmentReport | undefined,
  bodySource: BodySourceReport | undefined,
  indexed: number
): string | undefined =>
  enrichmentTotalFailure(enrichment)
    ? ENRICHMENT_EMPTY_REASON
    : bodySourceTotalFailure(bodySource, indexed)
      ? BODY_SOURCE_EMPTY_REASON
      : undefined;

/**
 * Exit 3 over the SAME text: the warning already says what happened, and exit 3
 * is this repo's "real output was produced AND something was refused" — a real
 * index was written, and the treatment the caller named produced nothing.
 */
const escalated = (outcome: CommandOutcome, reason: string | undefined): CommandOutcome =>
  reason === undefined
    ? outcome
    : { ...outcome, exitCode: EXIT_PARTIAL, data: { ...outcome.data, reason } };

/** The success rendering, with every report this run has to make. */
const reportedOutcome = (
  context: CommandContext,
  census: AtomsCensus,
  indexed: number
): CommandOutcome => {
  const enrichment = enrichmentReport(context);
  const bodySource = bodySourceReport(context);
  const reported = withEnrichmentColumns(
    withKeywordFilter(
      withBodySource(withEnrichment(withCensus(okOutcome(context), census), enrichment), bodySource),
      keywordFilterReport(context)
    ),
    enrichmentColumnsReport(context)
  );
  return escalated(reported, totalFailureReason(enrichment, bodySource, indexed));
};

/**
 * A genuinely EMPTY atoms directory is not this defect — it is an empty corpus,
 * and an empty index over it is the correct answer — so the gate fires only when
 * files are present and none of them reached the index.
 */
const builtOutcome = (context: CommandContext, indexed: number): CommandOutcome => {
  const census = atomsCensus(context.atomsDir, context.profile.domains);
  return indexed === 0 && census.files > 0
    ? emptyOutcome(context, census)
    : reportedOutcome(context, census, indexed);
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

/**
 * Every build-treatment gate, in one list: a new treatment is added HERE rather
 * than by lengthening a `??` chain, so the refusal path cannot quietly outgrow
 * the complexity cap that keeps it readable.
 */
const BUILD_REFUSALS: readonly ((flags: FlagValues) => string | undefined)[] = [
  bodySourceError,
  keywordFilterError,
  enrichmentColumnsError,
];

/** The FIRST refusal, so a caller who named two bad values fixes one at a time. */
const buildRefusal = (flags: FlagValues): string | undefined =>
  BUILD_REFUSALS.map(check => check(flags)).find(reason => reason !== undefined);

export const runIndexCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const refusal = buildRefusal(context.flags);
  if (refusal !== undefined) return usageError(refusal);
  const builder = builderFor(context);
  return builder === undefined ? noOp(context) : await build(context, builder);
};
