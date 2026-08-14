/**
 * The BM25 parameter sweep: for each selected dataset, score every (k1, b) cell
 * of the grid plus the shipped `1.2`/`0.75` reference point.
 *
 * Three properties this file exists to hold:
 *
 * 1. **The real engine is swept, never a copy.** Each cell opens a `linear` port
 *    through `engine.openPort`, which calls the SAME `createLinearScanAdapter`
 *    the CLI's `--adapter linear` builds, and every topic is ranked by
 *    `run.queryDataset` — the query path a recorded run uses. A BM25
 *    re-implementation here would be measuring this file, not the engine.
 * 2. **Ingest AND the corpus scan are paid ONCE per dataset.** Materialize +
 *    ingest + index does not depend on k1 or b, so it is hoisted out of the grid
 *    loop. Neither does the linear adapter's scan — parsing, tokenizing and
 *    counting terms — since k1 and b enter only in the final BM25 combination.
 *    Every cell therefore opens its port with `cacheCorpusScan`, turning a cost
 *    of `cells × topics × corpus` into `corpus + cells × topics`. That flag
 *    gives up the adapter's read-at-call-time rule, which is sound HERE and
 *    only here: `atomsDir` is ingested before the first cell and untouched
 *    until the dataset is done, and the adapter still re-scans if the corpus
 *    signature (file count, newest mtime) moves under it.
 * 3. **The baseline is in the same table.** A grid whose own best cell is the
 *    only number reported cannot be acted on; the reference point is measured
 *    in the same process, on the same corpus, at the same depth.
 *
 * Datasets and cells are processed one at a time: the query phase is CPU-bound
 * and each dataset owns an exclusive work directory (`engine.ts` rule 3).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readQrels, readQueries } from './beir.js';
import { openPort } from './engine.js';
import { readExcluded } from './fetch/bright.js';
import { type DatasetEntry, enabledDatasets, loadManifest } from './manifest.js';
import { currentGitSha, reportStem } from './report.js';
import {
  ensureDataset,
  MANIFEST_PATH,
  prepareOf,
  queryDataset,
  SUITE_ROOT,
  type Topic,
  topicsOf
} from './run.js';
import { scoreDataset } from './score.js';
import {
  BASELINE_B,
  BASELINE_K1,
  baselineCell,
  bestCell,
  datasetsOf,
  significanceLabel,
  type SweepCell,
  type SweepProvenance,
  writeSweepPerTopic,
  writeSweepReport,
  type WrittenSweep } from './sweepReport.js';

const RESULTS_DIR = resolve(SUITE_ROOT, 'results');
const REPO_ROOT = resolve(SUITE_ROOT, '../..');

/** The adapter the sweep drives. FTS5 hardcodes k1/b, so it cannot be swept. */
const ADAPTER = 'linear' as const;

const DEFAULT_DEPTH = 100;

/**
 * Short docs, long docs, and the split where the BM25 deficit was measured.
 *
 * Ordered MOST-INFORMATIVE FIRST, not cheapest first, because a default run is
 * hours long and is expected to be stopped early: artefacts are checkpointed
 * after every cell, so whatever has been measured when a run is cut short
 * should be the part worth having. `bright-biology-passages` leads — it scores
 * 0.1043 against a legitimate BM25 band of 0.175–0.197, which is the finding
 * the whole study exists to explain — even though at 55,695 atoms it is also by
 * far the most expensive.
 */
const DEFAULT_DATASETS: readonly string[] = [
  'bright-biology-passages',
  'bright-biology',
  'nfcorpus',
  'scifact',
];
const DEFAULT_K1: readonly number[] = [1.2, 1.0, 0.8];
const DEFAULT_B: readonly number[] = [0.6, 0.5, 0.4, 0.3];
const METRIC_DIGITS = 4;
const FAILURE_EXIT_CODE = 1;

/** The flags `sweep.sh` forwards. */
export interface SweepOptions {
  readonly only: readonly string[];
  readonly k1s: readonly number[];
  readonly bs: readonly number[];
  readonly depth: number;
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const csv = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(',')
        .map(part => part.trim())
        .filter(part => part.length > 0);

/**
 * A csv of numbers, or the fallback when the flag is absent. A part that is not
 * finite THROWS rather than becoming `NaN`: a silent `NaN` cell would score
 * every document 0 and read as a real, catastrophic result.
 */
export const numberCsv = (
  value: string | undefined,
  fallback: readonly number[]
): readonly number[] => {
  const parts = csv(value);
  if (parts.length === 0) return fallback;
  return parts.map(part => {
    const parsed = Number(part);
    if (!Number.isFinite(parsed)) {
      throw new Error(`dp-gnosis-bench: "${part}" is not a number — check --k1 / --b`);
    }
    return parsed;
  });
};

export const parseSweepArgs = (argv: readonly string[]): SweepOptions => {
  const only = csv(flagValue(argv, '--only'));
  return {
    only: only.length === 0 ? DEFAULT_DATASETS : only,
    k1s: numberCsv(flagValue(argv, '--k1'), DEFAULT_K1),
    bs: numberCsv(flagValue(argv, '--b'), DEFAULT_B),
    depth: Number(flagValue(argv, '--depth') ?? DEFAULT_DEPTH),
  };
};

/** One point of the grid. */
export interface GridPoint {
  readonly k1: number;
  readonly b: number;
  readonly baseline: boolean;
}

const isBaseline = (point: Pick<GridPoint, 'k1' | 'b'>): boolean =>
  point.k1 === BASELINE_K1 && point.b === BASELINE_B;

/**
 * The cartesian product, plus the shipped operating point as a reference cell.
 * The reference is appended only when the grid does not already contain it, so
 * a sweep that happens to include `1.2`/`0.75` measures it once, not twice.
 */
export const buildGrid = (
  k1s: readonly number[],
  bs: readonly number[]
): readonly GridPoint[] => {
  const grid = k1s.flatMap(k1 => bs.map(b => ({ k1, b, baseline: isBaseline({ k1, b }) })));
  return grid.some(point => point.baseline)
    ? grid
    : [...grid, { k1: BASELINE_K1, b: BASELINE_B, baseline: true }];
};

/** Everything a dataset's cells share — ingested once, queried per cell. */
interface DatasetContext {
  readonly entry: DatasetEntry;
  readonly topics: readonly Topic[];
  readonly qrels: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly excluded: ReadonlyMap<string, readonly string[]>;
  readonly prepared: Awaited<ReturnType<typeof prepareOf>>;
}

const contextFor = async (entry: DatasetEntry): Promise<DatasetContext> => {
  const dir = await ensureDataset(entry);
  const qrels = readQrels(dir, entry.format === 'bright' ? 'test' : entry.qrels);
  return {
    entry,
    qrels,
    topics: topicsOf(readQueries(dir), qrels),
    excluded: readExcluded(dir),
    prepared: await prepareOf(entry, dir),
  };
};

/** What a cell needs beyond its dataset: where its artefacts go, and how deep to rank. */
export interface CellRun {
  readonly resultsDir: string;
  readonly depth: number;
  /** The sweep's report stem, fixed once, so every cell's file groups with the run. */
  readonly stem: string;
}

/**
 * Measure one cell — and PERSIST its per-topic vector, not only the mean.
 *
 * `scoreDataset` computes both; keeping the mean alone would leave the four
 * headline results of a sweep impossible to significance-test without paying for
 * the whole grid again. The vector goes out in `report.ts`'s TSV format, so
 * `significance.readPerTopic` reads a cell exactly as it reads a recorded run.
 */
export const measureCell = async (
  context: DatasetContext,
  point: GridPoint,
  run: CellRun
): Promise<SweepCell> => {
  const port = openPort(context.prepared, {
    adapter: ADAPTER,
    k1: point.k1,
    b: point.b,
    cacheCorpusScan: true,
  });
  const rankContext = {
    port,
    options: { only: [], depth: run.depth, rerank: false, compare: false },
    excluded: context.excluded,
  };
  const queried = await queryDataset(rankContext, context.topics).finally(() => port.close?.());
  const scored = scoreDataset(queried.rankings, context.qrels);
  const identity = { dataset: context.entry.id, adapter: ADAPTER, k1: point.k1, b: point.b };
  return {
    ...identity,
    baseline: point.baseline,
    topics: context.topics.length,
    docCount: context.prepared.docCount,
    atomCount: context.prepared.atomCount,
    queryMs: queried.queryMs,
    metrics: scored.mean,
    perTopicPath: writeSweepPerTopic({
      resultsDir: run.resultsDir,
      stem: run.stem,
      cell: identity,
      perTopic: scored.perTopic,
    }),
  };
};

const metric = (value: number): string => value.toFixed(METRIC_DIGITS);

const cellLine = (cell: SweepCell, index: number, total: number): string =>
  `  [${index + 1}/${total}] k1=${cell.k1} b=${cell.b}${cell.baseline ? ' (baseline)' : ''}  ` +
  `nDCG@10 ${metric(cell.metrics.ndcg10)}  R@10 ${metric(cell.metrics.recall10)}  ` +
  `R@100 ${metric(cell.metrics.recall100)}  MRR@10 ${metric(cell.metrics.mrr10)}  ` +
  `(${cell.queryMs}ms)`;

/**
 * The whole sweep's shape, plus the checkpoint. A default run is long even with
 * the scan cached (the ranking still runs per topic per cell), so `write` is called
 * after EVERY cell with everything measured so far: a sweep that loses its
 * results to a crash on the last cell is worse than a slow one.
 */
interface SweepRun extends CellRun {
  readonly grid: readonly GridPoint[];
  readonly write: (cells: readonly SweepCell[]) => void;
}

/** Sequential: one port, one CPU-bound corpus scan at a time. */
const measureAll = async (
  context: DatasetContext,
  run: SweepRun,
  before: readonly SweepCell[]
): Promise<readonly SweepCell[]> =>
  run.grid.reduce<Promise<readonly SweepCell[]>>(async (pending, point, index) => {
    const done = await pending;
    const cell = await measureCell(context, point, run);
    process.stdout.write(`${cellLine(cell, index, run.grid.length)}\n`);
    const next = [...done, cell];
    run.write([...before, ...next]);
    return next;
  }, Promise.resolve([]));

const sweepDataset = async (
  entry: DatasetEntry,
  run: SweepRun,
  before: readonly SweepCell[]
): Promise<readonly SweepCell[]> => {
  process.stdout.write(`\n${entry.id}: ${run.grid.length} cells\n`);
  const context = await contextFor(entry);
  return await measureAll(context, run, before);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attempt = async (
  entry: DatasetEntry,
  run: SweepRun,
  before: readonly SweepCell[]
): Promise<readonly SweepCell[]> => {
  try {
    return await sweepDataset(entry, run, before);
  } catch (error) {
    process.stderr.write(`${entry.id}: FAILED — ${messageOf(error)}\n`);
    return [];
  }
};

const isEntry = (entry: DatasetEntry | undefined): entry is DatasetEntry => entry !== undefined;

/**
 * Ordered by the REQUEST, not by the manifest. A sweep is expected to be
 * stopped early, so the order `--only` states is the order that runs — it is
 * how a caller decides which cells are measured before they run out of
 * patience. An id that is unknown or disabled is dropped, as it was when this
 * filtered the manifest instead.
 */
export const selectDatasets = (
  only: readonly string[],
  entries: readonly DatasetEntry[]
): readonly DatasetEntry[] =>
  only.map(id => entries.find(entry => entry.id === id)).filter(isEntry);

const selected = (options: SweepOptions): readonly DatasetEntry[] =>
  selectDatasets(options.only, enabledDatasets(loadManifest(MANIFEST_PATH)));

const sweepAll = async (
  entries: readonly DatasetEntry[],
  run: SweepRun
): Promise<readonly SweepCell[]> =>
  await entries.reduce<Promise<readonly SweepCell[]>>(async (pending, entry) => {
    const before = await pending;
    return [...before, ...(await attempt(entry, run, before))];
  }, Promise.resolve([]));

const provenanceOf = (options: SweepOptions, gitSha: string): SweepProvenance => ({
  ts: new Date().toISOString(),
  gitSha,
  adapter: ADAPTER,
  depth: options.depth,
  k1s: options.k1s,
  bs: options.bs,
});

/**
 * The verdict attached to the winning cell, or nothing when there is none to
 * attach: the baseline itself won, or the cell was rated before its baseline
 * existed. An absent test is stated as absence, never as a passing one.
 */
const verdictSuffix = (best: SweepCell): string =>
  best.significance === undefined ? '' : ` — ${significanceLabel(best.significance)}`;

/**
 * The one line a reader wants at the end: the winner, what it beat, and whether
 * that is more than noise. The delta alone claims a winner the numbers may not
 * support — a measured scifact sweep printed `+0.0019` for a cell at p=0.46 —
 * so the qualifier travels with it and cannot be read past.
 */
export const winnerLine = (cells: readonly SweepCell[], dataset: string): string => {
  const scoped = cells.filter(cell => cell.dataset === dataset);
  const best = bestCell(scoped);
  const base = baselineCell(scoped);
  if (best === undefined || base === undefined) return `${dataset}: no cells`;
  const delta = best.metrics.ndcg10 - base.metrics.ndcg10;
  return (
    `${dataset}: best k1=${best.k1} b=${best.b} nDCG@10 ${metric(best.metrics.ndcg10)} ` +
    `(baseline ${metric(base.metrics.ndcg10)}, ${delta >= 0 ? '+' : ''}${metric(delta)})` +
    verdictSuffix(best)
  );
};

/**
 * The checkpoint writer. Provenance — and therefore the report stem — is fixed
 * ONCE, before the first cell: a stem derived per call would scatter a long
 * run's checkpoints across a new set of files every minute.
 */
interface SweepWriter {
  /** Shared by the checkpoint artefacts and by every cell's per-topic TSV. */
  readonly stem: string;
  readonly write: (cells: readonly SweepCell[]) => WrittenSweep;
}

const writerFor = (options: SweepOptions, sha: string): SweepWriter => {
  const provenance = provenanceOf(options, sha);
  return {
    stem: reportStem(provenance.ts),
    write: cells =>
      writeSweepReport({ resultsDir: RESULTS_DIR, repoRoot: REPO_ROOT, provenance, cells }),
  };
};

/** Reads the cells AS WRITTEN, so the winner lines carry the persisted verdicts. */
const announce = (written: WrittenSweep): void => {
  const { cells } = written;
  process.stdout.write(`\n${datasetsOf(cells).map(d => winnerLine(cells, d)).join('\n')}\n`);
  process.stdout.write(`\nwrote ${written.markdownPath}\n     ${written.svgPath}\n`);
  process.stdout.write(`     ${written.jsonPath}\n`);
};

export const main = async (argv: readonly string[], gitSha: string): Promise<number> => {
  const options = parseSweepArgs(argv);
  const entries = selected(options);
  const writer = writerFor(options, gitSha);
  const cells = await sweepAll(entries, {
    grid: buildGrid(options.k1s, options.bs),
    depth: options.depth,
    resultsDir: RESULTS_DIR,
    stem: writer.stem,
    write: writer.write,
  });
  if (cells.length > 0) announce(writer.write(cells));
  return datasetsOf(cells).length === entries.length && entries.length > 0 ? 0 : FAILURE_EXIT_CODE;
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), currentGitSha(SUITE_ROOT));
}
