/**
 * Score an EXTERNAL retrieval system's TREC run through THIS suite's scorer.
 *
 * A foreign system (qmd) publishes a run file, not metrics. Quoting the numbers
 * IT prints beside the numbers this suite prints compares two scorers as much as
 * two retrievers: the averaging convention, the document-level dedupe and the
 * depth cutoff would all differ silently. So the run file is read here and sent
 * through `score.ts:scoreDataset` unchanged — the same code path every gnosis row
 * was measured on. Nothing in this file computes a metric.
 *
 * Two conventions are load-bearing and are why the alignment step exists at all:
 *
 * | Convention | Why |
 * |---|---|
 * | average over the QRELS topic set | a topic the run retrieved nothing for has no lines in the file; dropping it flatters the run (measured 0.015 nDCG@10 on nfcorpus, handbook/GNOSIS-BENCH.md § Benchmarking) |
 * | order by the RANK COLUMN | line order is the producer's convenience, rank is its claim |
 *
 * A doc id the corpus does not hold, or a run that shares no topic with the
 * qrels, REFUSES (exit 3) rather than scoring the part that happened to join —
 * a partial join reads as a poor system rather than as a mis-aligned id space,
 * which is the failure class this whole harness is built to refuse.
 *
 * The row it records is self-labelling: `adapter` carries `--system`, so an
 * external arm can never be read as a gnosis adapter in `history.jsonl`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type Qrel, readCorpus, readQrels } from './beir.js';
import { flagValue, invokedDirectly, messageOf } from './cli/shared.js';
import { safeDocId } from './docId.js';
import { assertKnownFlags, type FlagSpec } from './flags.js';
import {
  type CorpusChecksum,
  corpusChecksum,
  currentGitSha,
  type DatasetResult,
  NO_TYPE_FILTER,
  PROVENANCE_MERGE,
  recordDataset,
  type RunProvenance
} from './report.js';
import { type DatasetScore, scoreDataset } from './score.js';

/** The run was scored and recorded. */
export const EXTERNAL_EXIT_OK = 0;

/** The invocation itself is unusable: an unknown flag, or a missing required one. */
export const EXTERNAL_EXIT_USAGE = 2;

/** The run cannot be scored SOUNDLY: an unresolvable doc id, or no topic overlap. */
export const EXTERNAL_EXIT_UNSOUND = 3;

const TREC_FIELDS = 6;
const RANK_FIELD = 3;
const DOC_FIELD = 2;
const METRIC_DIGITS = 4;
const UNRESOLVABLE_EXAMPLES = 3;
const QRELS_SPLIT = 'test';
const CORPUS_FILE = 'corpus.jsonl';
const DEFAULT_DEPTH = 100;
const DEFAULT_SYSTEM = 'external';
const DEFAULT_MS = 0;
const DEFAULT_ATOM_MAX_CHARS = 4000;

/** The domain and shape an external row carries — it ingested no atoms of ours. */
const EXTERNAL_DOMAIN = 'external';
const EXTERNAL_DOC_SHAPE = 'document';
const EXTERNAL_ANALYZER = 'external';

/**
 * A foreign system weighted no columns of ours — it built no index at all — so
 * the row stamps `external` rather than a weighting it never applied. It differs
 * from `DEFAULT_FIELD_WEIGHTS_TEXT` (`report.ts`) on purpose: an external row must never
 * compare EQUAL on a treatment it does not have, the same rule
 * `EXTERNAL_ANALYZER` states one field over.
 */
const EXTERNAL_FIELD_WEIGHTS = 'external';

/** One `qid Q0 docid rank score tag` line, reduced to the three fields that rank it. */
interface RunLine {
  readonly queryId: string;
  readonly docId: string;
  readonly rank: number;
}

/**
 * A malformed line THROWS rather than being skipped: a run file silently short a
 * topic scores as a system that retrieved nothing, which is the exact confusion
 * this tool exists to prevent.
 */
const parseLine = (line: string): RunLine => {
  const fields = line.split(/\s+/);
  if (fields.length !== TREC_FIELDS) {
    throw new Error(
      `dp-gnosis-bench: a TREC run line needs ${TREC_FIELDS} fields, got ${fields.length}: "${line}"`
    );
  }
  const rank = Number(fields[RANK_FIELD]);
  if (!Number.isFinite(rank)) {
    throw new Error(`dp-gnosis-bench: non-numeric rank in TREC run line: "${line}"`);
  }
  return { queryId: fields[0]!, docId: fields[DOC_FIELD]!, rank };
};

const groupByQuery = (lines: readonly RunLine[]): ReadonlyMap<string, readonly RunLine[]> =>
  lines.reduce((acc, line) => {
    const prior = acc.get(line.queryId) ?? [];
    return acc.set(line.queryId, [...prior, line]);
  }, new Map<string, readonly RunLine[]>());

const byRank = (left: RunLine, right: RunLine): number => left.rank - right.rank;

/**
 * Query id → its document ids in RANK order. The rank column decides, never the
 * line order: a producer is free to emit topics interleaved or a topic's rows
 * unsorted, and reading them as given would score an order it never claimed.
 */
export const parseTrecRun = (text: string): ReadonlyMap<string, readonly string[]> => {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(parseLine);
  return new Map(
    [...groupByQuery(lines)].map(([queryId, rows]) => [
      queryId,
      [...rows].sort(byRank).map(row => row.docId),
    ])
  );
};

/**
 * One entry per QRELS topic, in qrels order, truncated to `depth`. A topic the
 * run never mentions gets `[]` rather than no entry — `scoreDataset` averages
 * over what it is handed, so an omitted zero-hit topic would raise every mean.
 */
export const alignToQrels = (
  rankings: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>,
  depth: number
): ReadonlyMap<string, readonly string[]> =>
  new Map([...qrels.keys()].map(id => [id, (rankings.get(id) ?? []).slice(0, depth)]));

/** The distinct run ids the corpus does not hold — the refusal's whole evidence. */
export const unresolvableIds = (
  rankings: ReadonlyMap<string, readonly string[]>,
  known: ReadonlySet<string>
): readonly string[] =>
  [...new Set([...rankings.values()].flat())].filter(id => !known.has(id));

/**
 * The corpus and the qrels are both keyed on `safeDocId`, so the run must be
 * joined on the same mapping or a fully-covered corpus would score zero. It is
 * the identity on every dataset whose ids are already filename-safe, so this
 * hides no genuinely unknown id from the refusal below.
 */
const onSafeIds = (
  rankings: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly string[]> =>
  new Map([...rankings].map(([queryId, docs]) => [queryId, docs.map(safeDocId)]));

/** The parsed invocation. Every numeric field is already resolved to its default. */
export interface ExternalArgs {
  readonly dataset: string;
  readonly runPath: string;
  readonly dataDir: string;
  readonly resultsDir: string;
  readonly depth: number;
  readonly system: string;
  readonly queryP50Ms: number;
  readonly queryP95Ms: number;
  readonly queryMs: number;
  readonly ingestMs: number;
  readonly rerankModel: string | undefined;
  readonly rerankPool: number | undefined;
  readonly atomMaxChars: number;
}

/** Declared ONCE beside the parser, as every other bench CLI declares its own. */
export const EXTERNAL_FLAGS: FlagSpec = {
  value: [
    '--dataset',
    '--run',
    '--data-dir',
    '--results-dir',
    '--depth',
    '--system',
    '--query-p50-ms',
    '--query-p95-ms',
    '--query-ms',
    '--ingest-ms',
    '--rerank-model',
    '--rerank-pool',
    '--atom-max-chars',
  ],
  boolean: ['--help'],
};

export const EXTERNAL_HELP = [
  'gnosis:external — score an EXTERNAL system\'s TREC run through this suite\'s scorer.',
  '',
  'usage: tsx src/externalScore.ts --dataset <id> --run <path> --data-dir <dir>',
  '                               --results-dir <dir> [--system <name>] [--depth <n>]',
  '',
  '  --dataset      the dataset id the run was produced on',
  '  --run          the TREC run file: qid Q0 docid rank score tag',
  '  --data-dir     the BEIR-layout directory holding corpus.jsonl and qrels/',
  '  --results-dir  where the row is recorded; an external arm MUST NOT enter results/',
  `  --system       the label recorded as \`adapter\`, default ${DEFAULT_SYSTEM}`,
  `  --depth        the scoring cutoff, default ${DEFAULT_DEPTH}`,
  '  --query-p50-ms / --query-p95-ms / --query-ms / --ingest-ms   measured cost, default 0',
  '  --rerank-model / --rerank-pool   the external system\'s rerank arm, if it had one',
  `  --atom-max-chars  the cap the external system chunked at, default ${DEFAULT_ATOM_MAX_CHARS}`,
  '',
  'exit codes:',
  `  ${EXTERNAL_EXIT_OK}  the run was scored and recorded`,
  `  ${EXTERNAL_EXIT_USAGE}  unusable invocation (unknown flag, missing required flag)`,
  `  ${EXTERNAL_EXIT_UNSOUND}  refused (unresolvable doc id, or no topic overlap with the qrels)`,
  '',
].join('\n');

const required = (argv: readonly string[], name: string): string => {
  const value = flagValue(argv, name);
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`dp-gnosis-bench: ${name} <value> is required`);
  }
  return value;
};

/** A non-numeric value THROWS: a silently defaulted cost lands on the row as a fact. */
const numberFlag = (argv: readonly string[], name: string, fallback: number): number => {
  const raw = flagValue(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`dp-gnosis-bench: ${name} needs a number, got "${raw}"`);
  return value;
};

const optionalNumber = (argv: readonly string[], name: string): number | undefined =>
  flagValue(argv, name) === undefined ? undefined : numberFlag(argv, name, DEFAULT_MS);

const costArgs = (argv: readonly string[]): Pick<
  ExternalArgs,
  'queryP50Ms' | 'queryP95Ms' | 'queryMs' | 'ingestMs'
> => ({
  queryP50Ms: numberFlag(argv, '--query-p50-ms', DEFAULT_MS),
  queryP95Ms: numberFlag(argv, '--query-p95-ms', DEFAULT_MS),
  queryMs: numberFlag(argv, '--query-ms', DEFAULT_MS),
  ingestMs: numberFlag(argv, '--ingest-ms', DEFAULT_MS),
});

export const parseExternalArgs = (argv: readonly string[]): ExternalArgs => {
  assertKnownFlags(argv, EXTERNAL_FLAGS);
  return {
    dataset: required(argv, '--dataset'),
    runPath: required(argv, '--run'),
    dataDir: required(argv, '--data-dir'),
    resultsDir: required(argv, '--results-dir'),
    depth: numberFlag(argv, '--depth', DEFAULT_DEPTH),
    system: flagValue(argv, '--system') ?? DEFAULT_SYSTEM,
    ...costArgs(argv),
    rerankModel: flagValue(argv, '--rerank-model'),
    rerankPool: optionalNumber(argv, '--rerank-pool'),
    atomMaxChars: numberFlag(argv, '--atom-max-chars', DEFAULT_ATOM_MAX_CHARS),
  };
};

const unresolvableRefusal = (unresolvable: readonly string[]): string =>
  `dp-gnosis-bench: ${unresolvable.length} run document ids are not in the corpus, ` +
  `e.g. ${unresolvable.slice(0, UNRESOLVABLE_EXAMPLES).join(', ')} — REFUSED rather than ` +
  'dropped: an id space that does not join scores as a poor system';

const overlapRefusal = (
  rankings: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>
): string =>
  `dp-gnosis-bench: the run's ${rankings.size} topics overlap none of the ${qrels.size} ` +
  'qrels topics — REFUSED: every metric would be a true zero over a mis-keyed join';

/** The reason this run MUST NOT be scored, or `undefined` when it may be. */
const soundnessRefusal = (
  rankings: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>,
  known: ReadonlySet<string>
): string | undefined => {
  const unresolvable = unresolvableIds(rankings, known);
  if (unresolvable.length > 0) return unresolvableRefusal(unresolvable);
  const shared = [...rankings.keys()].filter(id => qrels.has(id));
  return shared.length === 0 ? overlapRefusal(rankings, qrels) : undefined;
};

/** One scored external run, ready to record — grouped so each builder takes one argument. */
interface ScoredRun {
  readonly args: ExternalArgs;
  readonly rankings: ReadonlyMap<string, readonly string[]>;
  readonly score: DatasetScore;
  readonly checksum: CorpusChecksum;
}

/**
 * `docCount` and `atomCount` are both the corpus line count: an external system
 * chunked nothing of ours, so its "atoms" ARE its documents, and recording a 0
 * would read as an empty index rather than as an unchunked one.
 */
const resultOf = (run: ScoredRun): DatasetResult => ({
  dataset: run.args.dataset,
  domain: EXTERNAL_DOMAIN,
  docShape: EXTERNAL_DOC_SHAPE,
  corpusBytes: run.checksum.corpusBytes,
  corpusLines: run.checksum.corpusLines,
  atomMaxChars: run.args.atomMaxChars,
  topics: run.rankings.size,
  docCount: run.checksum.corpusLines,
  atomCount: run.checksum.corpusLines,
  ingestMs: run.args.ingestMs,
  queryMs: run.args.queryMs,
  queryP50Ms: run.args.queryP50Ms,
  queryP95Ms: run.args.queryP95Ms,
  metrics: run.score.mean,
  metricsSd: run.score.sd,
  rPrecisionTopics: run.score.rPrecisionTopics,
  perTopic: run.score.perTopic,
  rankings: run.rankings,
});

/** `adapter` carries the SYSTEM, so a foreign row can never be read as a gnosis one. */
const provenanceOf = (args: ExternalArgs, suiteRoot: string): RunProvenance => ({
  ts: new Date().toISOString(),
  gitSha: currentGitSha(suiteRoot),
  adapter: args.system,
  depth: args.depth,
  rerank: args.rerankModel !== undefined,
  rerankModel: args.rerankModel,
  rerankPool: args.rerankPool,
  analyzer: EXTERNAL_ANALYZER,
  fieldWeights: EXTERNAL_FIELD_WEIGHTS,
  queryAdjacency: false,
  provenanceMerge: PROVENANCE_MERGE,
  prf: false,
  typeFilter: NO_TYPE_FILTER,
});

const metric = (value: number): string => value.toFixed(METRIC_DIGITS);

/** A cutoff this run's depth never reached prints as absent, never as a score. */
const optionalMetric = (value: number | undefined): string =>
  value === undefined ? '—' : metric(value);

const summaryLine = (result: DatasetResult, system: string): string =>
  `${result.dataset} [${system}]: nDCG@10 ${metric(result.metrics.ndcg10)}  ` +
  `R@10 ${optionalMetric(result.metrics.recall10)}  ` +
  `R@100 ${optionalMetric(result.metrics.recall100)}  ` +
  `MRR@10 ${metric(result.metrics.mrr10)}  ` +
  `(${result.topics} topics)`;

const recordRun = (run: ScoredRun, suiteRoot: string): number => {
  const result = resultOf(run);
  const recorded = recordDataset({
    resultsDir: resolve(run.args.resultsDir),
    provenance: provenanceOf(run.args, suiteRoot),
    result,
  });
  process.stdout.write(`${summaryLine(result, run.args.system)}\n`);
  process.stdout.write(`wrote ${recorded.perTopicPath}\n`);
  return EXTERNAL_EXIT_OK;
};

const scoreExternal = (args: ExternalArgs, suiteRoot: string): number => {
  const qrels = readQrels(args.dataDir, QRELS_SPLIT);
  const known = new Set(readCorpus(args.dataDir).map(doc => doc.id));
  const rankings = onSafeIds(parseTrecRun(readFileSync(args.runPath, 'utf8')));
  const refusal = soundnessRefusal(rankings, qrels, known);
  if (refusal !== undefined) {
    process.stderr.write(`${refusal}\n`);
    return EXTERNAL_EXIT_UNSOUND;
  }
  const aligned = alignToQrels(rankings, qrels, args.depth);
  const score = scoreDataset(aligned, qrels, args.depth);
  const checksum = corpusChecksum(resolve(args.dataDir, CORPUS_FILE));
  return recordRun({ args, rankings: aligned, score, checksum }, suiteRoot);
};

export const main = (argv: readonly string[], suiteRoot: string): number => {
  if (argv.includes('--help')) {
    process.stdout.write(EXTERNAL_HELP);
    return EXTERNAL_EXIT_OK;
  }
  try {
    return scoreExternal(parseExternalArgs(argv), suiteRoot);
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return EXTERNAL_EXIT_USAGE;
  }
};

/** Guarded so the exported helpers stay importable from a test. */
if (invokedDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), resolve(import.meta.dirname, '..'));
}
