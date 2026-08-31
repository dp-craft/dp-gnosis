/**
 * `gnosis:goldaudit` — the ZERO-GPU instrument audit.
 *
 * `run.ts:goldIdsOf` returns `undefined` for every non-derived dataset, so every
 * BEIR corpus is ingested under a GOLD-BLIND exact-body dedupe and never reaches
 * `assertGoldIndexed`. When the dedupe keeps the mirror the judgments do not
 * name, the judged document leaves the indexed corpus and its relevant
 * judgments cannot be won by ANY ranking — a recall ceiling that no recorded row
 * displays. This tool quantifies that ceiling per corpus and writes the from→to
 * mapping to a file.
 *
 * Three rules:
 *
 * 1. It MEASURES ONLY. Nothing here changes `goldIdsOf`, edits a golden set, or
 *    rewrites a recorded `.trec`. The re-pointed qrels exist in memory, for one
 *    re-scoring, and are never written back — fixing orphaned gold MOVES the
 *    measuring instrument (GNOSIS-GUIDE § Landmines).
 * 2. It builds NO index, opens NO port and calls NO reranker: one ingest per
 *    dataset, then arithmetic. `--run` re-scores an ALREADY-RECORDED TREC file.
 * 3. An unmeasurable cell is EMPTY, never `0` — the `report.ts:tsvCell`
 *    precedent. `recall@100` from a run retrieved to depth 40 is not measurable
 *    and prints blank rather than a number under the wrong name.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { type BeirDoc, readCorpus, readQrels } from './beir.js';
import {
  cell,
  exitCodeOf,
  flagValue,
  invokedDirectly,
  messageOf,
  TOOL_EXIT_OK,
  TOOL_EXIT_REFUSED,
  TOOL_EXIT_USAGE
} from './cli/shared.js';
import { auditDuplicates, type DuplicateLink, type PrepareDatasetOptions } from './engine.js';
import { assertKnownFlags, type FlagSpec } from './flags.js';
import { MALFORMED_RUN_LINE_CAUSE, readRunFile } from './forensics.js';
import {
  auditGold,
  GOLD_AUDIT_NO_CORPUS_CAUSE,
  GOLD_AUDIT_NO_JUDGMENTS_CAUSE,
  type GoldAudit,
  rePointQrels
} from './goldAudit.js';
import { type DatasetEntry, loadManifest, qrelsSplitOf } from './manifest.js';
import { meanMetrics, type Metrics, type Qrel, scoreTopic } from './metrics.js';
import { effectiveAtomMaxChars, ensureDataset, goldIdsOf, MANIFEST_PATH, WORK_ROOT } from './run.js';

/** The audit ran and every requested dataset was measured. */
export const GOLD_AUDIT_EXIT_OK = TOOL_EXIT_OK;

/** The invocation itself is unusable: no `--dataset`, an unknown id, or a missing run file. */
export const GOLD_AUDIT_EXIT_USAGE = TOOL_EXIT_USAGE;

/** Refused — the inputs read fine, and the data is not what the invocation claims. */
export const GOLD_AUDIT_EXIT_REFUSED = TOOL_EXIT_REFUSED;

/** `error.cause` when the `--run` file exists yet ranks not one topic. */
export const GOLD_AUDIT_EMPTY_RUN_CAUSE = 'dp-gnosis-bench/gold-audit-empty-run';

/**
 * The `error.cause` values THIS tool answers with a refusal. A malformed run
 * line is among them: a truncated artefact is a state mismatch, not a typo in
 * the invocation that read it.
 */
const GOLD_AUDIT_REFUSAL_CAUSES: readonly string[] = [
  GOLD_AUDIT_EMPTY_RUN_CAUSE,
  GOLD_AUDIT_NO_CORPUS_CAUSE,
  GOLD_AUDIT_NO_JUDGMENTS_CAUSE,
  MALFORMED_RUN_LINE_CAUSE,
];

const fail = (message: string, cause: string): never => {
  throw new Error(message, { cause });
};

/** How many empty-ranking topic ids one report names before it stops listing. */
const NAMED_EMPTY_TOPICS = 10;

export const GOLD_AUDIT_HELP = [
  'gnosis:goldaudit — zero-GPU audit of the gold lost to the ingest exact-body dedupe.',
  '',
  'usage: npm run gnosis:goldaudit -- --dataset <id> [--dataset <id>...] [--run <trec>] [--out <path>]',
  '',
  '  --dataset  a dataset id from datasets.json; repeatable',
  '  --run      an already-recorded TREC run file, re-scored against the qrels ON DISK',
  '             and against the re-pointed variant, side by side (no retrieval, no GPU)',
  '  --out      write the orphan→survivor mapping to this path, as JSON',
  '',
  'It builds no index and edits no golden set: the re-pointed qrels live in memory only.',
  '',
  'exit codes:',
  `  ${GOLD_AUDIT_EXIT_OK}  the audit ran`,
  `  ${GOLD_AUDIT_EXIT_USAGE}  unusable invocation (no --dataset, unknown id, unreadable --run)`,
  `  ${GOLD_AUDIT_EXIT_REFUSED}  refused — the data is not what the invocation claims (an empty or`,
  '     malformed run, a corpus with no document, a golden set with no judgment)',
  '',
].join('\n');

export interface GoldAuditArgs {
  readonly datasets: readonly string[];
  readonly runPath?: string | undefined;
  readonly outPath?: string | undefined;
}

const flagValues = (argv: readonly string[], flag: string): readonly string[] =>
  argv.flatMap((token, index) => (token === flag ? [argv[index + 1] ?? ''] : []));

/** Every flag this tool reads, `--help` included; anything else is refused by name. */
export const GOLD_AUDIT_FLAGS: FlagSpec = {
  value: ['--dataset', '--run', '--out'],
  boolean: ['--help'],
};

export const parseGoldAuditArgs = (argv: readonly string[]): GoldAuditArgs => {
  assertKnownFlags(argv, GOLD_AUDIT_FLAGS);
  const datasets = flagValues(argv, '--dataset').filter(id => id.length > 0);
  if (datasets.length === 0) {
    throw new Error('gnosis:goldaudit: name at least one dataset with --dataset <id>');
  }
  return {
    datasets,
    runPath: flagValue(argv, '--run'),
    outPath: flagValue(argv, '--out'),
  };
};

const entryFor = (manifest: readonly DatasetEntry[], id: string): DatasetEntry => {
  const entry = manifest.find(candidate => candidate.id === id);
  if (entry === undefined) {
    throw new Error(
      `gnosis:goldaudit: no dataset "${id}" in datasets.json — known ids: ` +
        manifest.map(candidate => candidate.id).join(', ')
    );
  }
  return entry;
};

/**
 * The ingest the audit measures MUST be the one production runs: `run.ts` hands
 * a derived dataset the ids its judgments name, and the dedupe survivor rule is
 * JUDGED FIRST. Auditing gold-blind therefore reports orphans production never
 * loses — measured on `vault`, 9 orphans and 13 lost judgments, every one an
 * artefact of the audit itself.
 */
export const auditIngestOptions = (
  entry: DatasetEntry,
  docs: readonly BeirDoc[],
  qrels: ReadonlyMap<string, Qrel>
): PrepareDatasetOptions => ({
  id: entry.id,
  docs,
  workRoot: WORK_ROOT,
  atomMaxChars: effectiveAtomMaxChars(entry),
  goldIds: goldIdsOf(entry, qrels),
});

export interface DatasetAudit {
  readonly audit: GoldAudit;
  readonly links: readonly DuplicateLink[];
  readonly qrels: ReadonlyMap<string, Qrel>;
}

const auditDataset = async (entry: DatasetEntry): Promise<DatasetAudit> => {
  const dir = await ensureDataset(entry);
  const qrels = readQrels(dir, qrelsSplitOf(entry));
  const docs = readCorpus(dir);
  const audited = await auditDuplicates(auditIngestOptions(entry, docs, qrels));
  const audit = auditGold({
    datasetId: entry.id,
    corpusDocIds: docs.map(doc => doc.id),
    representedDocIds: audited.representedDocIds,
    qrels,
  });
  return { audit, links: audited.links, qrels };
};

const share = (part: number, whole: number): string =>
  whole === 0 ? '' : `${((part / whole) * 100).toFixed(2)}%`;

const auditLines = (result: DatasetAudit): readonly string[] => {
  const audit = result.audit;
  return [
    `dataset ${audit.datasetId}`,
    `  corpus documents        ${audit.corpusDocs}`,
    `  represented in atoms    ${audit.representedDocs}`,
    `  orphaned by dedupe      ${audit.orphanedDocs}`,
    `  …judged relevant        ${audit.orphanedJudgedDocs}`,
    `  lost judgments          ${audit.lostJudgments} of ${audit.totalRelevantJudgments}` +
      ` (${share(audit.lostJudgments, audit.totalRelevantJudgments)})`,
    `  topics affected         ${audit.affectedTopics}`,
    `  orphan→survivor links   ${result.links.length}`,
  ];
};

const depthOf = (run: ReadonlyMap<string, readonly string[]>): number =>
  [...run.values()].reduce((deepest, ranking) => Math.max(deepest, ranking.length), 0);

/**
 * Averaged over EVERY topic in the qrels, a topic the run never ranked scoring 0
 * — the base `run.ts` scores on. Averaging over the topics PRESENT in the .trec
 * divides by a smaller denominator: nfcorpus printed nDCG@10 0.3319 where
 * `history.jsonl` records 0.3164 for the same run (0.3164 × 323 / 308 = 0.3318),
 * a number that reads comparable to a recorded row and is not.
 */
export const scoreRun = (
  run: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>
): Metrics => {
  const depth = depthOf(run);
  const scored = [...qrels].map(([topicId, qrel]) => scoreTopic(run.get(topicId) ?? [], qrel, depth));
  return meanMetrics(scored);
};

/**
 * Topics the run retrieved NOTHING for — absent from the .trec, or present with
 * no lines. This project's headline failure class is a component producing
 * nothing and the pipeline recording it as data (GNOSIS-GUIDE § Landmines), and
 * these topics sink the mean silently: 15 of 323 nfcorpus test topics.
 */
export const emptyRankingTopics = (
  run: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>
): readonly string[] => [...qrels.keys()].filter(topicId => (run.get(topicId) ?? []).length === 0);

export const emptyRankingLines = (
  run: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>
): readonly string[] => {
  const empty = emptyRankingTopics(run, qrels);
  return [
    `  topics with an EMPTY ranking: ${empty.length} of ${qrels.size}`,
    `  empty topics: ${empty.slice(0, NAMED_EMPTY_TOPICS).join(' ')}`,
  ];
};

const comparisonLines = (
  runPath: string,
  result: DatasetAudit
): readonly string[] => {
  const run = readRunFile(runPath);
  const onDisk = scoreRun(run, result.qrels);
  const rePointed = scoreRun(run, rePointQrels(result.qrels, result.links));
  return [
    `  re-scored ${basename(runPath)} over ${result.qrels.size} qrels topics` +
      ` (${run.size} ranked) at depth ${depthOf(run)}`,
    ...emptyRankingLines(run, result.qrels),
    '  metric      on-disk qrels   re-pointed qrels',
    `  nDCG@10     ${cell(onDisk.ndcg10).padEnd(15)} ${cell(rePointed.ndcg10)}`,
    `  recall@100  ${cell(onDisk.recall100).padEnd(15)} ${cell(rePointed.recall100)}`,
  ];
};

const linesFor = (result: DatasetAudit, runPath: string | undefined): readonly string[] => [
  ...auditLines(result),
  ...(runPath === undefined ? [] : comparisonLines(runPath, result)),
  '',
];

interface MappingFile {
  readonly generatedAt: string;
  readonly datasets: readonly {
    readonly dataset: string;
    readonly audit: GoldAudit;
    readonly links: readonly DuplicateLink[];
  }[];
}

const mappingOf = (results: readonly DatasetAudit[], now: string): MappingFile => ({
  generatedAt: now,
  datasets: results.map(result => ({
    dataset: result.audit.datasetId,
    audit: result.audit,
    links: result.links,
  })),
});

const writeMapping = (outPath: string, mapping: MappingFile): void => {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(mapping, undefined, 2)}\n`, 'utf8');
};

const emptyRunMessage = (runPath: string): string =>
  `gnosis:goldaudit: the TREC run file ${runPath} holds no ranking line at all. Scoring it ` +
  'averages every qrels topic at depth 0 and prints a confident nDCG@10 0.0000 beside recorded ' +
  'rows — an empty artefact read as a measured result.';

/**
 * Both checks run BEFORE the ingest, so an unusable `--run` costs no corpus
 * work. Emptiness is judged over the WHOLE file: topics the run legitimately
 * retrieved nothing for are already named by `emptyRankingLines`, and only a
 * file that ranks not one topic refuses.
 */
export const requireRunFile = (runPath: string | undefined): void => {
  if (runPath === undefined) return;
  if (!existsSync(runPath)) {
    throw new Error(`gnosis:goldaudit: no TREC run file at ${runPath}`);
  }
  if (readRunFile(runPath).size === 0) fail(emptyRunMessage(runPath), GOLD_AUDIT_EMPTY_RUN_CAUSE);
};

const auditAll = async (
  entries: readonly DatasetEntry[]
): Promise<readonly DatasetAudit[]> =>
  entries.reduce<Promise<readonly DatasetAudit[]>>(
    async (previous, entry) => [...(await previous), await auditDataset(entry)],
    Promise.resolve([])
  );

export const main = async (argv: readonly string[], now: string): Promise<number> => {
  if (argv.includes('--help')) {
    process.stdout.write(GOLD_AUDIT_HELP);
    return GOLD_AUDIT_EXIT_OK;
  }
  try {
    const args = parseGoldAuditArgs(argv);
    requireRunFile(args.runPath);
    const manifest = loadManifest(MANIFEST_PATH);
    const results = await auditAll(args.datasets.map(id => entryFor(manifest, id)));
    const mapped = results.flatMap(result => linesFor(result, args.runPath));
    process.stdout.write(`${mapped.join('\n')}\n`);
    if (args.outPath !== undefined) writeMapping(args.outPath, mappingOf(results, now));
    return GOLD_AUDIT_EXIT_OK;
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return exitCodeOf(error, GOLD_AUDIT_REFUSAL_CAUSES);
  }
};

/** Guarded so the exported helpers stay importable from a test. */
if (invokedDirectly(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), new Date().toISOString());
}
