/**
 * `gnosis:fuseforecast` — the CLI entry point for `fuseForecast.ts`.
 *
 * It runs NO retrieval and starts no benchmark: it fuses ALREADY-RECORDED runs
 * from their persisted TREC files, so every number here costs zero compute and
 * zero GPU. What it forecasts is whether the `fts5`, `linear` and `fts5+prf`
 * arms are COMPLEMENTARY — which is a per-topic claim, so the report carries
 * win/loss/tie counts and not a mean alone.
 *
 * Two rules it inherits rather than restates:
 *
 * 1. **The rankings are resolved from the row's `runPath` field ONLY** — never
 *    from a reconstructed filename. Two arms of one minute share a stem at
 *    minute resolution, so a derived name can hand this tool another run's
 *    rankings under this run's label (GUIDE § Outputs).
 * 2. **Provenance-match first** — `assertProvenanceMatch` runs before any
 *    fusion, and a drift REFUSES by name rather than joining three runs that
 *    measured different corpora.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readQrels } from './beir.js';
import { readRunFile } from './forensics.js';
import {
  type ForecastInput,
  forecastReport,
  FUSE_DEPTH,
  type Leg,
  RERANK_RRF_K
} from './fuseForecast.js';
import { type DatasetEntry, loadManifest } from './manifest.js';
import type { Qrel } from './metrics.js';
import { HISTORY_FILE, type HistoryRow, readHistory, runFilePath } from './report.js';
import { ensureDataset, MANIFEST_PATH, SUITE_ROOT } from './run.js';

/** The forecast was written. */
export const FUSE_FORECAST_EXIT_OK = 0;

/** Unusable invocation, or a guard refused: bad `--only`, a missing leg, drift, no reproduction. */
export const FUSE_FORECAST_EXIT_USAGE = 2;

/** The datasets the plan forecasts, in report order. */
export const FUSE_FORECAST_DATASETS: readonly string[] = ['vault', 'nfcorpus'];

/** One leg's identity in `history.jsonl`: an adapter and a PRF state. */
export interface LegSpec {
  readonly label: string;
  readonly adapter: string;
  readonly prf: boolean;
}

/** The three legs, in the order `fuseForecast.ts` expects them. */
export const FUSE_LEG_SPECS: readonly LegSpec[] = [
  { label: 'fts5', adapter: 'fts5', prf: false },
  { label: 'linear', adapter: 'linear', prf: false },
  { label: 'fts5+prf', adapter: 'fts5', prf: true },
];

export const FUSE_FORECAST_HELP = [
  'gnosis:fuseforecast — offline RRF forecast over the recorded fts5 / linear / fts5+prf runs.',
  '',
  'usage: npm run gnosis:fuseforecast -- [--only <dataset>]',
  '',
  `  --only  forecast one dataset instead of ${FUSE_FORECAST_DATASETS.join(' and ')}`,
  '',
  `It retrieves nothing: each leg is the LATEST history row with depth ${FUSE_DEPTH},`,
  'rerank off and a recorded runPath, re-scored from its persisted .trec.',
  'It REFUSES when the legs do not share provenance, or when a leg no longer',
  'reproduces its recorded nDCG@10.',
  '',
  `Fusion is the engine's RRF at K=${RERANK_RRF_K}, w on the first leg.`,
  '',
  'exit codes:',
  `  ${FUSE_FORECAST_EXIT_OK}  the forecast was written`,
  `  ${FUSE_FORECAST_EXIT_USAGE}  unusable invocation, or a guard refused`,
  '',
].join('\n');

export interface FuseForecastArgs {
  readonly datasets: readonly string[];
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

/** An unknown `--only` is a caller bug, named against the manifest of forecastable ids. */
export const parseFuseForecastArgs = (argv: readonly string[]): FuseForecastArgs => {
  const only = flagValue(argv, '--only');
  if (only === undefined) return { datasets: FUSE_FORECAST_DATASETS };
  if (only.startsWith('--')) throw new Error('dp-gnosis-bench: --only <dataset> is required');
  return { datasets: [only] };
};

/** A leg candidate: the same dataset, retrieved to `FUSE_DEPTH`, unreranked, with a `.trec`. */
export const isFusableRow = (row: HistoryRow, dataset: string): boolean =>
  row.dataset === dataset && row.depth === FUSE_DEPTH && !row.rerank && row.runPath !== undefined;

/**
 * An ABSENT `prf` reads as OFF, never as a moved treatment — `compare.ts`'s rule
 * verbatim: no row recorded before the flag existed expanded its query. Reading
 * absence as "not false" excluded the whole pre-flag population, which is where
 * the plain BM25 legs live.
 */
const prfExpanded = (row: HistoryRow): boolean => row.prf ?? false;

const matchesSpec = (row: HistoryRow, spec: LegSpec): boolean =>
  row.adapter === spec.adapter && prfExpanded(row) === spec.prf;

/** The LATEST matching row by timestamp — a leg is never derived from a filename. */
export const selectLegRow = (
  history: readonly HistoryRow[],
  dataset: string,
  spec: LegSpec
): HistoryRow | undefined =>
  [...history]
    .filter(row => isFusableRow(row, dataset) && matchesSpec(row, spec))
    .sort((left, right) => left.ts.localeCompare(right.ts))
    .at(-1);

export const requireLegRow = (
  history: readonly HistoryRow[],
  dataset: string,
  spec: LegSpec
): HistoryRow => {
  const row = selectLegRow(history, dataset, spec);
  if (row === undefined) {
    throw new Error(
      `dp-gnosis-bench: no recorded "${spec.label}" leg for "${dataset}" — ` +
        `needs adapter ${spec.adapter}, prf ${spec.prf}, depth ${FUSE_DEPTH}, rerank off, runPath present`
    );
  }
  return row;
};

const legOf = (resultsDir: string, spec: LegSpec, row: HistoryRow): Leg => {
  const path = runFilePath(resultsDir, row);
  if (path === undefined) {
    throw new Error(`dp-gnosis-bench: the "${spec.label}" leg names no TREC run file`);
  }
  return { label: spec.label, row, rankings: readRunFile(path) };
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

const qrelsOf = async (dataset: string): Promise<ReadonlyMap<string, Qrel>> => {
  const entry = entryFor(dataset);
  return readQrels(await ensureDataset(entry), splitOf(entry));
};

export const forecastInput = async (
  resultsDir: string,
  history: readonly HistoryRow[],
  dataset: string
): Promise<ForecastInput> => ({
  dataset,
  legs: FUSE_LEG_SPECS.map(spec => legOf(resultsDir, spec, requireLegRow(history, dataset, spec))),
  qrels: await qrelsOf(dataset),
});

const reportFor = async (
  resultsDir: string,
  history: readonly HistoryRow[],
  dataset: string
): Promise<readonly string[]> =>
  forecastReport(await forecastInput(resultsDir, history, dataset));

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const reportAll = async (
  resultsDir: string,
  args: FuseForecastArgs
): Promise<readonly string[]> => {
  const history = readHistory(resolve(resultsDir, HISTORY_FILE));
  const sections = await Promise.all(
    args.datasets.map(dataset => reportFor(resultsDir, history, dataset))
  );
  return sections.flatMap(lines => [...lines, '']);
};

export const main = async (argv: readonly string[], resultsDir: string): Promise<number> => {
  if (argv.includes('--help')) {
    process.stdout.write(FUSE_FORECAST_HELP);
    return FUSE_FORECAST_EXIT_OK;
  }
  try {
    const lines = await reportAll(resultsDir, parseFuseForecastArgs(argv));
    process.stdout.write(`${lines.join('\n')}\n`);
    return FUSE_FORECAST_EXIT_OK;
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return FUSE_FORECAST_EXIT_USAGE;
  }
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), resolve(SUITE_ROOT, 'results'));
}
