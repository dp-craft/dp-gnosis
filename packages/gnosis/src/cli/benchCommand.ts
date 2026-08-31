/**
 * `bench` — measure every adapter over the golden set and persist the report.
 *
 * The command is composition only: corpora, candidates, measurement and
 * rendering all live under `src/bench*`. It picks NO winner and prints none —
 * it reports where the two files landed and the headline provenance, and a
 * human reads the report.
 *
 * `--adapter` is deliberately NOT honoured here: a benchmark of one adapter is
 * not a comparison, and the whole point is measuring them side by side.
 */
import type { BenchOptions, BenchReport } from '../bench.js';
import {
  DEFAULT_BENCH_K,
  DEFAULT_TIMING,
  runBenchmark,
  SYNTHETIC_RUNGS,
  SYNTHETIC_SEED
} from '../bench.js';
import { defaultCandidates } from '../bench/candidates.js';
import type { BenchCorpus } from '../bench/corpora.js';
import { materializeRealCorpus, materializeSyntheticCorpus } from '../bench/corpora.js';
import { readGoldenSetSource } from '../bench/goldenSetSource.js';
import { writeBenchReport } from '../bench/report.js';
import { mapSequential } from '../bench/sequential.js';
import type { GoldenSet } from '../goldenSet.js';
import { benchWorkDir, DOCS_TEST_DIR, GOLDEN_SET_PATH } from '../paths.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

const REAL_CORPUS_LABEL = 'seed';

/** The seed vault plus the synthetic ceiling rungs, all as working copies. */
const prepareCorpora = async (atomsDir: string): Promise<readonly BenchCorpus[]> => [
  await materializeRealCorpus(atomsDir, benchWorkDir(), REAL_CORPUS_LABEL),
  ...(await mapSequential(SYNTHETIC_RUNGS, rung =>
    materializeSyntheticCorpus(benchWorkDir(), rung, SYNTHETIC_SEED)
  )),
];

interface LoadedGoldenSet {
  readonly path: string;
  readonly set: GoldenSet;
  readonly hash: string;
}

const optionsFor = async (
  context: CommandContext,
  golden: LoadedGoldenSet
): Promise<BenchOptions> => ({
  goldenSet: golden.set,
  goldenSetPath: golden.path,
  goldenSetHash: golden.hash,
  candidates: await defaultCandidates(),
  corpora: await prepareCorpora(context.atomsDir),
  workDir: benchWorkDir(),
  k: DEFAULT_BENCH_K,
  timing: DEFAULT_TIMING,
  now: new Date(),
});

const payload = (
  report: BenchReport,
  markdownPath: string,
  jsonPath: string
): Readonly<Record<string, unknown>> => ({
  command: 'bench',
  markdownPath,
  jsonPath,
  adapters: report.adapters,
  skippedAdapters: report.skippedAdapters,
  corpora: report.corpora.map(corpus => corpus.label),
  goldenSet: report.goldenSet,
});

const benchText = (report: BenchReport, markdownPath: string): string =>
  [
    `bench: ${report.adapters.length} adapter(s) over ${report.corpora.length} corpora, ${report.goldenSet.queryCount} queries`,
    `bench: skipped ${report.skippedAdapters.length} adapter(s)`,
    'bench: two regimes reported side by side — no winner is picked here',
    `bench: report written to ${markdownPath}`,
  ].join('\n');

/** A skipped adapter is a PARTIAL result: some of what was asked did not run. */
const exitCodeFor = (report: BenchReport): number =>
  report.skippedAdapters.length === 0 ? EXIT_OK : EXIT_PARTIAL;

const measure = async (
  context: CommandContext,
  golden: LoadedGoldenSet
): Promise<CommandOutcome> => {
  const report = await runBenchmark(await optionsFor(context, golden));
  const written = await writeBenchReport(report, DOCS_TEST_DIR);
  return {
    exitCode: exitCodeFor(report),
    data: payload(report, written.markdownPath, written.jsonPath),
    text: benchText(report, written.markdownPath),
  };
};

/** The frozen query set to measure over: `bench` alone reads it. */
export const GOLDEN_SET_FLAG = '--golden-set';

export const runBenchCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const path = stringFlag(context.flags, GOLDEN_SET_FLAG) ?? GOLDEN_SET_PATH;
  const loaded = await readGoldenSetSource(path, context.atomsDir);
  return loaded.ok
    ? await measure(context, { path, set: loaded.set, hash: loaded.hash })
    : usageError(loaded.error);
};
