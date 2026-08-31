/**
 * `gnosis:forensics` — the CLI entry point for `forensics.ts`.
 *
 * It runs NO retrieval and starts no benchmark: it re-scores an ALREADY-RECORDED
 * run from its persisted TREC run file, so every number here costs zero compute
 * and zero GPU.
 *
 * Three rules it inherits rather than restates:
 *
 * 1. **The rankings are resolved from the row's `runPath` field ONLY** — never
 *    from a reconstructed filename. Two arms of one minute share a stem at
 *    minute resolution, so a derived name can hand this tool another run's
 *    rankings under this run's label (GUIDE § Outputs).
 * 2. **Every score comes from `forensics.ts` / `metrics.ts`**, the modules
 *    `pytrec_eval` attests. A second formula here could drift from the one the
 *    recorded runs were measured with.
 * 3. **An unmeasurable cell is EMPTY, never `0`** — the `report.ts:tsvCell`
 *    precedent. A `0` reads as "measured, none", which is exactly how the
 *    recurring failure class in this project presents itself.
 *
 * And one guard it adds. The recorded per-topic TSV already holds each topic's
 * nDCG@10; this tool recomputes it from the `.trec` against the qrels ON DISK
 * TODAY. If the two disagree, the golden set moved under the recorded run and
 * every number below would be scored against judgments the run never saw — so
 * it REFUSES, naming both values, rather than publishing a silently re-based
 * score.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fitToTokenBudget } from '../../gnosis/src/budget.js';
import {
  RETRIEVE_TOKEN_BUDGET
} from '../../gnosis/src/config.js';
import type { RetrievedAtom } from '../../gnosis/src/port.js';
import { type AtomDomain, defaultAtomType } from '../../gnosis/src/vocabulary.js';
import { readQrels } from './beir.js';
import { readAtomDocs } from './fetch/vault.js';
import { assertKnownFlags, type FlagSpec } from './flags.js';
import { readRunFile, topicForensics } from './forensics.js';
import { type DatasetEntry, loadManifest } from './manifest.js';
import {
  meanMetrics,
  type Metrics,
  type Qrel,
  rPrecisionTopics,
  scoreTopic
} from './metrics.js';
import { describeRun, resolveRun } from './pair.js';
import {
  HISTORY_FILE,
  type HistoryRow,
  PER_TOPIC_METRIC_COLUMNS,
  readHistory,
  runFilePath,
  runStamp
} from './report.js';
import { ensureDataset, MANIFEST_PATH, SUITE_ROOT } from './run.js';
import {
  type MetricName,
  type ParsedMetrics,
  perTopicPath,
  readPerTopic,
  type TopicScores
} from './significance.js';

/** The forensics TSV was written. */
export const FORENSICS_EXIT_OK = 0;

/** The invocation itself is unusable: a bad flag value, or a selector naming no unique run. */
export const FORENSICS_EXIT_USAGE = 2;

/** The run cannot be re-scored: no `runPath`, drifted qrels, or atoms newer than the run. */
export const FORENSICS_EXIT_REFUSED = 3;

export const CAUSE_NO_RUN_PATH = 'dp-gnosis-bench/forensics-no-run-path';
export const CAUSE_NO_PER_TOPIC = 'dp-gnosis-bench/forensics-no-per-topic';
export const CAUSE_QREL_DRIFT = 'dp-gnosis-bench/forensics-qrel-drift';
export const CAUSE_ATOMS_NEWER_THAN_RUN = 'dp-gnosis-bench/forensics-atoms-newer-than-run';

const DIGITS = 4;
const DEFAULT_CUT = 10;
const DEFAULT_SERVED_K = 5;

/** Where the per-topic forensics TSVs go, relative to the results dir. */
export const FORENSICS_DIR = 'forensics';

/**
 * The only datasets `goldSurvivesBudget` is defined for. Both project one atom
 * per document 1:1, so "the served document's first atom" is the whole document;
 * on every other dataset a document is many atoms and the simulation would
 * budget a body the engine never presents.
 */
export const BUDGET_DATASETS: readonly string[] = ['vault', 'vault-hu'];

/**
 * How far a recomputed nDCG@10 may sit from the recorded one before it counts as
 * drift. The recorded TSV stores 4 decimals, so up to 5e-5 of the gap is pure
 * rounding; anything above 1e-4 is a real difference in the judgments.
 */
export const NDCG_AGREEMENT_TOLERANCE = 1e-4;

export const FORENSICS_HELP = [
  'gnosis:forensics — offline ordering-vs-recall decomposition of a recorded run.',
  '',
  'usage: npm run gnosis:forensics -- --run <selector> [--k 10] [--served-k 5] [--budget <n>]',
  '',
  '  --run       a unique SUBSTRING of the run\'s recorded perTopicPath;',
  '              an ambiguous or unmatched selector fails loudly, listing candidates',
  '  --k         the nDCG / recall cut (default 10)',
  '  --served-k  how many documents the consumer is served, for goldSurvivesBudget',
  `              (default ${DEFAULT_SERVED_K})`,
  `  --budget    the presentation token budget (default ${RETRIEVE_TOKEN_BUDGET})`,
  '',
  'allGoldInBudget is 1 when the WHOLE gold set is served and survives the budget, else 0;',
  'noiseAtServedK is 1 - P@servedK over what was delivered, budget-free so every dataset has it.',
  '',
  `goldSurvivesBudget is defined for ${BUDGET_DATASETS.join(' / ')} only — they project`,
  'one atom per document; elsewhere the column is EMPTY and the summary says why.',
  '',
  'exit codes:',
  `  ${FORENSICS_EXIT_OK}  the forensics TSV was written`,
  `  ${FORENSICS_EXIT_USAGE}  unusable invocation (bad flag value, ambiguous or unmatched selector)`,
  `  ${FORENSICS_EXIT_REFUSED}  refused (no runPath, drifted qrels, atoms newer than the run)`,
  '',
].join('\n');

export interface ForensicsArgs {
  readonly run: string;
  readonly k: number;
  readonly servedK: number;
  readonly budget: number;
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

/** A non-integer or non-positive count is a caller bug, never clamped. */
const positiveInt = (raw: string | undefined, name: string, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`dp-gnosis-bench: ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
};

const requiredSelector = (argv: readonly string[]): string => {
  const value = flagValue(argv, '--run');
  if (value === undefined || value.startsWith('--')) {
    throw new Error('dp-gnosis-bench: --run <selector> is required');
  }
  return value;
};

/**
 * Every flag this tool reads, `--help` included: an unrecognised one used to be
 * dropped in silence and the TSV recorded the DEFAULT cut under the operator's
 * intended label — `flags.ts`'s failure class exactly.
 */
export const FORENSICS_FLAGS: FlagSpec = {
  value: ['--run', '--k', '--served-k', '--budget'],
  boolean: ['--help'],
};

export const parseForensicsArgs = (argv: readonly string[]): ForensicsArgs => {
  assertKnownFlags(argv, FORENSICS_FLAGS);
  return {
    run: requiredSelector(argv),
    k: positiveInt(flagValue(argv, '--k'), '--k', DEFAULT_CUT),
    servedK: positiveInt(flagValue(argv, '--served-k'), '--served-k', DEFAULT_SERVED_K),
    budget: positiveInt(flagValue(argv, '--budget'), '--budget', RETRIEVE_TOKEN_BUDGET),
  };
};

/**
 * One topic's row of the forensics TSV.
 *
 * `metrics` is the WHOLE `scoreTopic` output at the run's recorded depth, not a
 * selection: every consumer measure a caller might want is already computed by
 * the attested module, and re-deriving one here by a second route is how two
 * numbers under one name start to disagree. The decomposition fields beside it
 * are the ones `scoreTopic` does not own.
 *
 * `undefined` anywhere is an UNMEASURABLE cell, and serializes EMPTY.
 */
export interface ForensicsRow {
  readonly queryId: string;
  readonly metrics: Metrics;
  readonly oracleNdcg10: number;
  readonly orderingLoss: number;
  readonly recallLoss: number;
  readonly firstGoldRank: number | undefined;
  readonly recallLimited: boolean;
  readonly goldSurvivesBudget: number | undefined;
  readonly allGoldInBudget: number | undefined;
  readonly noiseAtServedK: number | undefined;
}

/**
 * The consumer measures the TSV carries, in column order. A subset of
 * `PER_TOPIC_METRIC_COLUMNS`: the recall cutoffs live in the recorded per-topic
 * TSV already and add nothing to a forensics read, while `rPrecision` /
 * `rbpResidual` / `map` / `allGoldInTop10` are exactly the columns the champion
 * rows predate. They are still all DRIFT-CHECKED — see `ndcgDisagreements`.
 */
export const CONSUMER_METRIC_COLUMNS = [
  'ndcg10',
  'precision5',
  'precision10',
  'allGoldInTop10',
  'map',
  'rPrecision',
  'rbpResidual',
] as const satisfies readonly MetricName[];

export const FORENSICS_COLUMNS: readonly string[] = [
  'query_id',
  ...CONSUMER_METRIC_COLUMNS,
  'oracleNdcg10',
  'orderingLoss',
  'recallLoss',
  'firstGoldRank',
  'recallLimited',
  'goldSurvivesBudget',
  'allGoldInBudget',
  'noiseAtServedK',
];

/** An unmeasurable cell is EMPTY — `report.ts:tsvCell`'s rule, not a second one. */
export const forensicsCell = (value: number | undefined): string =>
  value === undefined ? '' : value.toFixed(DIGITS);

/** A rank is an ordinal, not a measure — it serializes without decimals. */
const rankCell = (value: number | undefined): string =>
  value === undefined ? '' : String(value);

export const forensicsTsvRow = (row: ForensicsRow): string =>
  [
    row.queryId,
    ...CONSUMER_METRIC_COLUMNS.map(column => forensicsCell(row.metrics[column])),
    forensicsCell(row.oracleNdcg10),
    forensicsCell(row.orderingLoss),
    forensicsCell(row.recallLoss),
    rankCell(row.firstGoldRank),
    String(row.recallLimited),
    forensicsCell(row.goldSurvivesBudget),
    forensicsCell(row.allGoldInBudget),
    forensicsCell(row.noiseAtServedK),
  ].join('\t');

export const forensicsTsv = (rows: readonly ForensicsRow[]): string =>
  `${[FORENSICS_COLUMNS.join('\t'), ...rows.map(forensicsTsvRow)].join('\n')}\n`;

/**
 * The domain and type a budget probe carries. `fitToTokenBudget` reads `body`,
 * `id` and `sourcePath` alone, so these two exist only to satisfy the shape —
 * a synthetic atom never reaches an index and its vocabulary is never narrowed.
 */
const PROBE_DOMAIN: AtomDomain = 'docs';

const probeAtom = (docId: string, body: string): RetrievedAtom => ({
  id: docId,
  title: docId,
  domain: PROBE_DOMAIN,
  type: defaultAtomType(),
  body,
  score: 0,
  sourcePath: `${docId}.md`,
  originPaths: [`${docId}.md`],
});

const isGold = (qrel: Qrel, docId: string): boolean => (qrel.get(docId) ?? 0) > 0;

const keptIds = (
  served: readonly string[],
  bodies: ReadonlyMap<string, string>,
  maxTokens: number
): ReadonlySet<string> => {
  const atoms = served.map(docId => probeAtom(docId, bodies.get(docId) ?? ''));
  return new Set(fitToTokenBudget(atoms, maxTokens).kept.map(atom => atom.id));
};

/**
 * The share of the topic's gold that SURVIVES the presentation cap — measured
 * over the gold the served window actually holds, so it isolates what the budget
 * costs rather than re-reporting recall@servedK.
 *
 * `undefined` when the window holds no gold at all (there is nothing for the
 * budget to drop) or when an atom body is missing (the simulation would charge
 * 0 tokens for a document that has a size).
 */
export const goldSurvivingBudget = (
  ranking: readonly string[],
  qrel: Qrel,
  bodies: ReadonlyMap<string, string>,
  servedK: number,
  maxTokens: number
): number | undefined => {
  const served = ranking.slice(0, servedK);
  const gold = served.filter(docId => isGold(qrel, docId));
  if (gold.length === 0 || !served.every(docId => bodies.has(docId))) return undefined;
  const kept = keptIds(served, bodies, maxTokens);
  return gold.filter(docId => kept.has(docId)).length / gold.length;
};

/**
 * Whether the topic's ENTIRE gold set is delivered: 1 when every judged-positive
 * document is BOTH inside the served window AND kept by the presentation cap,
 * 0 otherwise. `goldSurvivesBudget` reports a SHARE of what the window already
 * held; this reports whether the consumer sees the whole answer.
 *
 * `undefined` when the topic has no gold at all, or when a served body is
 * missing — the missing-body guard runs FIRST so the column is never a confident
 * 0 produced from a simulation that charged a real document 0 tokens.
 */
export const allGoldInBudget = (
  ranking: readonly string[],
  qrel: Qrel,
  bodies: ReadonlyMap<string, string>,
  servedK: number,
  maxTokens: number
): number | undefined => {
  const served = ranking.slice(0, servedK);
  if (!served.every(docId => bodies.has(docId))) return undefined;
  const gold = [...qrel.keys()].filter(docId => isGold(qrel, docId));
  if (gold.length === 0) return undefined;
  const kept = keptIds(served, bodies, maxTokens);
  return gold.every(docId => kept.has(docId)) ? 1 : 0;
};

/**
 * The share of the served window that is NOT gold — `1 − P@servedK`.
 *
 * The denominator is the window's OWN length, i.e. what was actually delivered,
 * not `servedK`: a topic served three documents is not 40 % noisier for the two
 * it never had to show.
 *
 * It deliberately does NOT apply the token budget. `goldSurvivesBudget` and
 * `allGoldInBudget` already carry the budget's cost, so this column stays
 * defined on EVERY dataset rather than only on the `BUDGET_DATASETS` that have a
 * 1:1 atom projection.
 *
 * `undefined` when the window is empty — nothing delivered, so no noise share
 * exists to report.
 */
export const noiseAtServedK = (
  ranking: readonly string[],
  qrel: Qrel,
  servedK: number
): number | undefined => {
  const window = ranking.slice(0, servedK);
  if (window.length === 0) return undefined;
  return 1 - window.filter(docId => isGold(qrel, docId)).length / window.length;
};

export interface TopicInput {
  readonly queryId: string;
  readonly ranking: readonly string[];
  readonly qrel: Qrel;
}

/** What a row needs beyond the topic itself: the cuts and the budget inputs. */
export interface RowContext {
  /** The DECOMPOSITION cut for the oracle split; the consumer measures are fixed-cut. */
  readonly k: number;
  /** The run's RECORDED depth — what `scoreTopic` calls a measure unmeasurable against. */
  readonly depth: number;
  readonly servedK: number;
  readonly budget: number;
  readonly bodies: ReadonlyMap<string, string> | undefined;
}

export const forensicsRow = (topic: TopicInput, context: RowContext): ForensicsRow => {
  const scored = topicForensics(topic.ranking, topic.qrel, context.k);
  const { bodies } = context;
  return {
    queryId: topic.queryId,
    metrics: scoreTopic(topic.ranking, topic.qrel, context.depth),
    oracleNdcg10: scored.oracleNdcg,
    orderingLoss: scored.orderingLoss,
    recallLoss: scored.recallLoss,
    firstGoldRank: scored.firstRelevantRank,
    recallLimited: scored.recallLimited,
    goldSurvivesBudget:
      bodies === undefined
        ? undefined
        : goldSurvivingBudget(topic.ranking, topic.qrel, bodies, context.servedK, context.budget),
    allGoldInBudget:
      bodies === undefined
        ? undefined
        : allGoldInBudget(topic.ranking, topic.qrel, bodies, context.servedK, context.budget),
    noiseAtServedK: noiseAtServedK(topic.ranking, topic.qrel, context.servedK),
  };
};

/**
 * The topics to score, taken from the QRELS set rather than the run file: a
 * topic that retrieved nothing has no line in the `.trec` and would otherwise be
 * silently omitted, which is the convention `metrics.ts` is attested under.
 */
export const topicInputs = (
  qrels: ReadonlyMap<string, Qrel>,
  run: ReadonlyMap<string, readonly string[]>
): readonly TopicInput[] =>
  [...qrels.entries()].map(([queryId, qrel]) => ({
    queryId,
    qrel,
    ranking: run.get(queryId) ?? [],
  }));

/** One topic-and-measure where the recomputed value misses the recorded one. */
export interface MetricDisagreement {
  readonly queryId: string;
  readonly metric: MetricName;
  readonly recorded: number | undefined;
  readonly recomputed: number | undefined;
}

/**
 * A column the recorded TSV does not carry is NOT RECORDED, and is skipped.
 *
 * Treating an absent column as a measured `0` is a live defect class here: it
 * cost `report.ts` a legacy depth-20 row during T0.2, where a missing `map`
 * parsed as `0` and was subtracted as a real difference. Every champion row
 * predates four of these columns, so this branch is the common case, not an edge.
 */
const agrees = (recorded: number | undefined, recomputed: number | undefined): boolean =>
  recorded === undefined ||
  (recomputed !== undefined && Math.abs(recorded - recomputed) <= NDCG_AGREEMENT_TOLERANCE);

const disagreementOf = (
  row: ForensicsRow,
  metric: MetricName,
  scores: ParsedMetrics | undefined
): MetricDisagreement | undefined => {
  const recorded = scores?.[metric];
  const recomputed = row.metrics[metric];
  return scores !== undefined && agrees(recorded, recomputed)
    ? undefined
    : { queryId: row.queryId, metric, recorded, recomputed };
};

const isDisagreement = (value: MetricDisagreement | undefined): value is MetricDisagreement =>
  value !== undefined;

const rowDisagreements = (
  row: ForensicsRow,
  recorded: TopicScores
): readonly (MetricDisagreement | undefined)[] =>
  PER_TOPIC_METRIC_COLUMNS.map(metric =>
    disagreementOf(row, metric, recorded.get(row.queryId))
  );

/**
 * Every topic-and-measure where the qrels ON DISK no longer reproduce what the
 * run recorded, over EVERY column the recorded TSV carries — not nDCG@10 alone.
 * A topic the recorded TSV never scored at all counts too: it is the same
 * failure seen from the other side, a topic set that has moved since the run.
 */
export const metricDisagreements = (
  rows: readonly ForensicsRow[],
  recorded: TopicScores
): readonly MetricDisagreement[] =>
  rows.flatMap(row => rowDisagreements(row, recorded)).filter(isDisagreement);

/** Which measures the recorded TSV actually carries, for the agreement report. */
export const recordedMetrics = (recorded: TopicScores): readonly MetricName[] => {
  const first = [...recorded.values()][0];
  return first === undefined
    ? []
    : PER_TOPIC_METRIC_COLUMNS.filter(metric => first[metric] !== undefined);
};

const describeDisagreement = (item: MetricDisagreement): string =>
  `  ${item.queryId} ${item.metric}: recorded ${item.recorded?.toFixed(DIGITS) ?? '(not scored)'} ` +
  `vs recomputed ${item.recomputed?.toFixed(DIGITS) ?? '(unmeasurable)'}`;

export const driftRefusalLines = (
  row: HistoryRow,
  disagreements: readonly MetricDisagreement[]
): readonly string[] => [
  'NO FORENSICS — the golden set moved under the recorded run: ' +
    `${disagreements.length} topic-metric pair(s) no longer reproduce their recorded value.`,
  `run: ${describeRun(row)}`,
  ...disagreements.map(describeDisagreement),
  'Re-run the arm against the current judgments before reading these numbers.',
];

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);

const measured = (values: readonly (number | undefined)[]): readonly number[] =>
  values.filter((value): value is number => value !== undefined);

const budgetSummary = (rows: readonly ForensicsRow[], note: string): string => {
  const values = measured(rows.map(row => row.goldSurvivesBudget));
  return values.length === 0
    ? `goldSurvivesBudget n/a (${note})`
    : `goldSurvivesBudget ${mean(values).toFixed(DIGITS)} over ${values.length} topics`;
};

/**
 * A run-level mean beside the count of topics it was measured over — a mean of a
 * SUBSET quoted without its denominator reads as a whole-run number.
 */
const meanSummary = (label: string, values: readonly (number | undefined)[]): string => {
  const present = measured(values);
  return present.length === 0
    ? `${label} n/a`
    : `${label} ${mean(present).toFixed(DIGITS)} over ${present.length} topics`;
};

const cell = (value: number | undefined): string =>
  value === undefined ? 'n/a' : value.toFixed(DIGITS);

/**
 * Every run-level mean, from `meanMetrics` — the same aggregator the recorded
 * rows were written with, so a number here and a number in `history.jsonl` are
 * the same statistic. `rPrecision` carries its MEASURED-topic count because its
 * denominator is a subset, and a subset mean that does not say so is quoted as a
 * whole one.
 */
const metricSummary = (perTopic: readonly Metrics[]): string => {
  const means = meanMetrics(perTopic);
  const parts = CONSUMER_METRIC_COLUMNS.map(metric => `${metric} ${cell(means[metric])}`);
  return `${parts.join('  ')} (rPrecisionTopics ${rPrecisionTopics(perTopic)})`;
};

/** Which columns the agreement covers — silence about a skipped column reads as a pass. */
const agreementSummary = (rows: readonly ForensicsRow[], recorded: TopicScores): string => {
  const checked = recordedMetrics(recorded);
  return `agrees with the recorded TSV on ${rows.length} topics × ` +
    `${checked.length} recorded columns [${checked.join(', ')}]`;
};

export const summaryLine = (
  row: HistoryRow,
  rows: readonly ForensicsRow[],
  recorded: TopicScores,
  context: { readonly budgetNote: string; readonly tsvPath: string }
): string =>
  `${row.dataset}/${row.adapter} depth=${row.depth}: ${rows.length} topics  ` +
  `${metricSummary(rows.map(item => item.metrics))}  ` +
  `orderingLoss ${mean(rows.map(item => item.orderingLoss)).toFixed(DIGITS)}  ` +
  `recallLoss ${mean(rows.map(item => item.recallLoss)).toFixed(DIGITS)}  ` +
  `${budgetSummary(rows, context.budgetNote)}  ` +
  `${meanSummary('allGoldInBudget', rows.map(item => item.allGoldInBudget))}  ` +
  `${meanSummary('noiseAtK', rows.map(item => item.noiseAtServedK))}  ` +
  `${agreementSummary(rows, recorded)}  ` +
  `→ ${context.tsvPath}`;

export type ForensicsOutcome =
  | {
    readonly kind: 'report';
    readonly lines: readonly string[];
    readonly tsv: string;
    readonly tsvPath: string;
  }
  | { readonly kind: 'refused'; readonly cause: string; readonly lines: readonly string[] }
  | { readonly kind: 'usage'; readonly lines: readonly string[] };

/** Everything the pure report needs, already read off disk. */
export interface ForensicsInput {
  readonly row: HistoryRow;
  readonly run: ReadonlyMap<string, readonly string[]>;
  readonly qrels: ReadonlyMap<string, Qrel>;
  readonly recorded: TopicScores;
  /** `undefined` when the dataset has no 1:1 atom projection — see `budgetNote`. */
  readonly bodies: ReadonlyMap<string, string> | undefined;
  readonly budgetNote: string;
  readonly tsvPath: string;
  readonly args: ForensicsArgs;
}

/**
 * The whole decomposition as text plus a TSV — pure, so the drift refusal is
 * assertable without a process, a results directory or a dataset on disk.
 */
export const forensicsReport = (input: ForensicsInput): ForensicsOutcome => {
  const context: RowContext = { ...input.args, depth: input.row.depth, bodies: input.bodies };
  const rows = topicInputs(input.qrels, input.run).map(topic => forensicsRow(topic, context));
  const drift = metricDisagreements(rows, input.recorded);
  if (drift.length > 0) {
    return { kind: 'refused', cause: CAUSE_QREL_DRIFT, lines: driftRefusalLines(input.row, drift) };
  }
  return {
    kind: 'report',
    lines: [summaryLine(input.row, rows, input.recorded, input)],
    tsv: forensicsTsv(rows),
    tsvPath: input.tsvPath,
  };
};

const selectionFailure = (selector: string, history: readonly HistoryRow[]): ForensicsOutcome => {
  const selection = resolveRun(history, selector);
  const lines =
    selection.kind === 'ambiguous'
      ? [
          `NO FORENSICS — "${selector}" is ambiguous, matching ${selection.matches.length} runs:`,
          ...selection.matches.map(match => `  ${match}`),
        ]
      : [`NO FORENSICS — "${selector}" matches no recorded run's perTopicPath.`];
  return { kind: 'usage', lines };
};

const entryFor = (dataset: string): DatasetEntry => {
  const entry = loadManifest(MANIFEST_PATH).find(item => item.id === dataset);
  if (entry === undefined) {
    throw new Error(`dp-gnosis-bench: no manifest entry for dataset "${dataset}"`);
  }
  return entry;
};

/** The split `run.ts` scores this format under — read from there, never guessed. */
const splitOf = (entry: DatasetEntry): string =>
  entry.format === 'bright' ? 'test' : entry.qrels;

/**
 * The atoms directory whose bodies the budget simulation reads, or `undefined`
 * when the dataset has no 1:1 atom-to-document projection.
 */
export const atomsDirOf = (entry: DatasetEntry): string | undefined =>
  entry.format === 'beir-local' &&
  entry.derive !== undefined &&
  BUDGET_DATASETS.includes(entry.id)
    ? resolve(SUITE_ROOT, entry.derive.atoms)
    : undefined;

/**
 * The newest mtime under `dir`, files included. The directory's own mtime moves
 * only when an entry is added or removed, so it alone would miss a re-ingest
 * that rewrote every body in place — and a body that changed after the run is
 * exactly the untracked-cache landmine this guard exists for.
 */
export const latestMtimeMs = (dir: string): number =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(entry => entry.endsWith('.md'))
    .map(entry => statSync(resolve(dir, entry)).mtimeMs)
    .reduce((newest, value) => Math.max(newest, value), statSync(dir).mtimeMs);

export const staleAtomsLines = (
  row: HistoryRow,
  dir: string,
  mtimeMs: number
): readonly string[] => [
  'NO FORENSICS — the atoms directory changed AFTER the run being scored, so its ' +
    'bodies are not the ones the run measured.',
  `atoms: ${dir} (newest .md mtime ${new Date(mtimeMs).toISOString()})`,
  `run:   ${describeRun(row)}`,
  'Re-run the arm against the current atoms before reading a budget number.',
];

interface Bodies {
  readonly bodies: ReadonlyMap<string, string> | undefined;
  readonly note: string;
}

const loadBodies = (entry: DatasetEntry): Bodies => {
  const dir = atomsDirOf(entry);
  if (dir === undefined) {
    return {
      bodies: undefined,
      note: `"${entry.id}" has no 1:1 atom-to-document projection; ` +
        `defined for ${BUDGET_DATASETS.join(' / ')} only`,
    };
  }
  const docs = readAtomDocs(dir);
  return { bodies: new Map(docs.map(doc => [doc.id, doc.text])), note: 'measured' };
};

interface Loaded {
  readonly qrels: ReadonlyMap<string, Qrel>;
  readonly bodies: ReadonlyMap<string, string> | undefined;
  readonly budgetNote: string;
  readonly staleAtoms: readonly string[];
}

const loadDataset = async (row: HistoryRow): Promise<Loaded> => {
  const entry = entryFor(row.dataset);
  const dir = await ensureDataset(entry);
  const qrels = readQrels(dir, splitOf(entry));
  const atomsDir = atomsDirOf(entry);
  const mtimeMs = atomsDir === undefined ? 0 : latestMtimeMs(atomsDir);
  const stale = atomsDir !== undefined && mtimeMs > Date.parse(row.ts);
  const loaded = loadBodies(entry);
  return {
    qrels,
    bodies: loaded.bodies,
    budgetNote: loaded.note,
    staleAtoms: stale && atomsDir !== undefined ? staleAtomsLines(row, atomsDir, mtimeMs) : [],
  };
};

const missingRunPath = (row: HistoryRow): ForensicsOutcome => ({
  kind: 'refused',
  cause: CAUSE_NO_RUN_PATH,
  lines: [
    'NO FORENSICS — the recorded row names no TREC run file, so its rankings cannot be ' +
      'resolved; it predates the `runPath` field. A derived filename is not a substitute.',
    `run: ${describeRun(row)}`,
  ],
});

const missingPerTopic = (row: HistoryRow): ForensicsOutcome => ({
  kind: 'refused',
  cause: CAUSE_NO_PER_TOPIC,
  lines: [
    'NO FORENSICS — the recorded row names no readable per-topic TSV, so the recomputed ' +
      'scores cannot be checked against the ones the run recorded.',
    `run: ${describeRun(row)}`,
  ],
});

const tsvPathOf = (resultsDir: string, row: HistoryRow, now: string): string =>
  resolve(resultsDir, FORENSICS_DIR, `${runStamp(now)}-${row.adapter}-${row.dataset}.tsv`);

const reportForRow = async (
  resultsDir: string,
  row: HistoryRow,
  args: ForensicsArgs,
  now: string
): Promise<ForensicsOutcome> => {
  const runPath = runFilePath(resultsDir, row);
  if (runPath === undefined || !existsSync(runPath)) return missingRunPath(row);
  const topicPath = perTopicPath(resultsDir, row);
  const recorded = topicPath === undefined ? undefined : readPerTopic(topicPath);
  if (recorded === undefined) return missingPerTopic(row);
  const loaded = await loadDataset(row);
  if (loaded.staleAtoms.length > 0) {
    return { kind: 'refused', cause: CAUSE_ATOMS_NEWER_THAN_RUN, lines: loaded.staleAtoms };
  }
  return forensicsReport({
    row, run: readRunFile(runPath), qrels: loaded.qrels, recorded,
    bodies: loaded.bodies, budgetNote: loaded.budgetNote,
    tsvPath: tsvPathOf(resultsDir, row, now), args,
  });
};

const emit = (outcome: ForensicsOutcome): number => {
  if (outcome.kind === 'report') {
    mkdirSync(dirname(outcome.tsvPath), { recursive: true });
    writeFileSync(outcome.tsvPath, outcome.tsv, 'utf8');
    process.stdout.write(`${outcome.lines.join('\n')}\n`);
    return FORENSICS_EXIT_OK;
  }
  process.stderr.write(`${outcome.lines.join('\n')}\n`);
  return outcome.kind === 'usage' ? FORENSICS_EXIT_USAGE : FORENSICS_EXIT_REFUSED;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const main = async (argv: readonly string[], resultsDir: string): Promise<number> => {
  if (argv.includes('--help')) {
    process.stdout.write(FORENSICS_HELP);
    return FORENSICS_EXIT_OK;
  }
  try {
    const args = parseForensicsArgs(argv);
    const history = readHistory(resolve(resultsDir, HISTORY_FILE));
    const selection = resolveRun(history, args.run);
    if (selection.kind !== 'run') return emit(selectionFailure(args.run, history));
    return emit(await reportForRow(resultsDir, selection.row, args, new Date().toISOString()));
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return FORENSICS_EXIT_USAGE;
  }
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), resolve(SUITE_ROOT, 'results'));
}
