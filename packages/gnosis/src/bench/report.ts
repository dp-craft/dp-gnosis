/**
 * Rendering and persistence of a benchmark report.
 *
 * Markdown for a human, a JSON sidecar for a later diff — the SAME `BenchReport`
 * object, so the prose can never disagree with the machine-readable numbers.
 *
 * The header of every report repeats the two-regime warning and the fact that
 * no winner is picked here. A report read six months later has none of this
 * conversation's context, and the one way to over-read these numbers is to
 * quote a single latency without the regime it was measured in.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AdapterCorpusResult, BenchReport, RegimeResult } from '../bench.js';
import type { SkippedAdapter } from './candidates.js';
import type { QueryAggregate } from './metrics.js';

const MS_DIGITS = 3;
const RATIO_DIGITS = 4;
const BYTES_PER_KIB = 1024;
const DATE_CHARS = 10;
const TIME_CHARS = 5;

/** Both files share this stem so a report and its sidecar cannot be separated. */
export const reportStem = (generatedAt: string): string => {
  const date = generatedAt.slice(0, DATE_CHARS);
  const time = generatedAt.slice(DATE_CHARS + 1, DATE_CHARS + 1 + TIME_CHARS).replace(':', '');
  return `${date}-${time}-dp-gnosis-retrieval-bench`;
};

const ms = (value: number): string => value.toFixed(MS_DIGITS);

const ratio = (value: number | undefined): string =>
  value === undefined ? 'n/a' : value.toFixed(RATIO_DIGITS);

const kib = (bytes: number): string => (bytes / BYTES_PER_KIB).toFixed(1);

const HEADER: readonly string[] = [
  '# dp-gnosis retrieval benchmark',
  '',
  '> **No winner is picked here.** This harness reports numbers; the choice of adapter',
  '> is a human judgement made from them, and it depends on which regime the caller runs in.',
  '',
  '> **Two regimes, never one headline number.** `cold-per-query` opens the index for every',
  '> query; `warm-shared-index` loads it once and then queries it, and also reports the cost of',
  '> serving an already-cached answer. Regime (b) largely neutralizes the main handicap of a',
  '> load-heavy adapter, so **which regime you measure can change which adapter wins.** The two',
  '> MUST NOT be merged or averaged.',
  '',
];

const provenanceLines = (report: BenchReport): readonly string[] => [
  '## Provenance',
  '',
  `- generated at: \`${report.generatedAt}\``,
  `- golden set: \`${report.goldenSet.path}\``,
  `- golden set sha256: \`${report.goldenSet.sha256}\``,
  `- golden set frozen at: \`${report.goldenSet.frozenAt}\`, ${report.goldenSet.queryCount} queries`,
  `- k: ${report.k}`,
  '',
];

const mmdLines = (report: BenchReport): readonly string[] => [
  '## Pre-registered minimum meaningful difference',
  '',
  `- queries: ${report.goldenSet.minimumMeaningfulDifference.queries}`,
  `- recall resolution: ${report.goldenSet.minimumMeaningfulDifference.recallResolution}`,
  `- ${report.goldenSet.minimumMeaningfulDifference.statement}`,
  '',
];

const methodologyLines = (report: BenchReport): readonly string[] => [
  '## Measurement methodology',
  '',
  `- warmup passes (discarded): ${report.timing.warmupIterations}`,
  `- measured passes: ${report.timing.measuredIterations}; one pass runs every golden query once`,
  '- p50/p95 are nearest-rank percentiles over EVERY measured call, not over pass averages',
  '- peak heap is `process.memoryUsage().heapUsed` sampled immediately after each measured call',
  '  — a peak over discrete samples, not a continuous profile, and not GC-controlled',
  '- cold start is one open + first query IN PROCESS: module load and V8 warmup are already',
  '  paid, so it bounds the index-load component from below, not whole-process startup',
  '- the warm regime reuses the PORT. An adapter that reopens its index inside `retrieve`',
  '  rather than at open time shows no gap between the two regimes — read equal p50s as a',
  '  statement about that adapter, not as evidence that the regime distinction does not matter',
  '',
];

const skippedLines = (skipped: readonly SkippedAdapter[]): readonly string[] => [
  '## Skipped adapters',
  '',
  ...(skipped.length === 0
    ? ['None — every declared adapter ran.']
    : skipped.map(entry => `- **${entry.name}** — ${entry.reason}`)),
  '',
];

const corpusLines = (report: BenchReport): readonly string[] => [
  '## Corpora',
  '',
  '| corpus | atoms | recall/MRR scored |',
  '|---|---|---|',
  ...report.corpora.map(
    corpus =>
      `| ${corpus.label} | ${corpus.atomCount} | ${corpus.scoresMetrics ? 'yes' : 'no — synthetic, latency/size ceiling only'} |`
  ),
  '',
];

/** Only called for results that HAVE metrics, so the aggregate is passed in. */
const qualityRow = (result: AdapterCorpusResult, metrics: QueryAggregate): string =>
  `| ${result.adapter} | ${result.corpus} | ${ratio(metrics.recallAtK)} | ${ratio(metrics.mrr)} | ${metrics.scoredQueries} | ${metrics.unscorableQueries} |`;

const qualityRows = (report: BenchReport): readonly string[] =>
  report.results.flatMap(result =>
    result.metrics === undefined ? [] : [qualityRow(result, result.metrics)]
  );

const qualityLines = (report: BenchReport): readonly string[] => [
  `## Quality (recall@${report.k}, MRR)`,
  '',
  '| adapter | corpus | recall@k | MRR | scored queries | unscorable queries |',
  '|---|---|---|---|---|---|',
  ...qualityRows(report),
  '',
];

const costRow = (result: AdapterCorpusResult): string =>
  `| ${result.adapter} | ${result.corpus} | ${ms(result.coldStartMs)} | ${ms(result.indexBuildMs)} | ${kib(result.indexSizeBytes)} | ${ms(result.singleAtomUpdateMs)} |`;

const costLines = (report: BenchReport): readonly string[] => [
  '## Cost',
  '',
  '| adapter | corpus | cold start ms | index build ms | index KiB | single-atom update ms |',
  '|---|---|---|---|---|---|',
  ...report.results.map(costRow),
  '',
];

const regimeRow = (result: AdapterCorpusResult, regime: RegimeResult): string =>
  `| ${regime.regime} | ${result.adapter} | ${result.corpus} | ${ms(regime.latency.p50Ms)} | ${ms(regime.latency.p95Ms)} | ${regime.latency.samples} | ${kib(regime.latency.peakHeapBytes)} | ${regime.cacheHitP50Ms === undefined ? 'n/a' : ms(regime.cacheHitP50Ms)} |`;

const regimeRows = (report: BenchReport): readonly string[] =>
  report.results.flatMap(result => result.regimes.map(regime => regimeRow(result, regime)));

/** One line per DISTINCT regime, in first-seen order. */
const regimeDescriptions = (report: BenchReport): readonly string[] =>
  [
    ...new Map(
      report.results.flatMap(result => result.regimes).map(regime => [regime.regime, regime.description])
    ),
  ].map(([name, description]) => `- \`${name}\` — ${description}`);

const regimeLines = (report: BenchReport): readonly string[] => [
  '## Latency by regime (reported side by side — never merged)',
  '',
  ...regimeDescriptions(report),
  '',
  '| regime | adapter | corpus | p50 ms | p95 ms | samples | peak heap KiB | cache hit p50 ms |',
  '|---|---|---|---|---|---|---|---|',
  ...regimeRows(report),
  '',
];

/** The human-readable rendering. */
export const renderReportMarkdown = (report: BenchReport): string =>
  [
    ...HEADER,
    ...provenanceLines(report),
    ...mmdLines(report),
    `## Adapters measured\n\n${report.adapters.map(name => `- ${name}`).join('\n')}\n`,
    ...skippedLines(report.skippedAdapters),
    ...corpusLines(report),
    ...methodologyLines(report),
    ...qualityLines(report),
    ...costLines(report),
    ...regimeLines(report),
  ].join('\n');

/** Where a persisted report and its sidecar landed. */
export interface WrittenReport {
  readonly markdownPath: string;
  readonly jsonPath: string;
}

/** Persist both files under `dir`, creating it if needed. */
export const writeBenchReport = async (
  report: BenchReport,
  dir: string
): Promise<WrittenReport> => {
  const stem = reportStem(report.generatedAt);
  const markdownPath = join(dir, `${stem}.md`);
  const jsonPath = join(dir, `${stem}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(markdownPath, renderReportMarkdown(report), 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { markdownPath, jsonPath };
};
