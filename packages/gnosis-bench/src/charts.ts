/**
 * `npm run gnosis:charts` — the campaign's figures, regenerated from recorded
 * artefacts alone.
 *
 * Every number drawn is read from `results/history.jsonl` or the per-topic TSVs
 * those rows name; nothing is typed into this script, so a re-run after a new
 * measurement redraws the set without an edit. The figures to draw are declared
 * in `charts.json`, which is committed next to them.
 *
 * It REFUSES loudly. A selector that resolves to nothing or to more than one run
 * aborts the whole regeneration with the selector named — a half-written figure
 * set that looks complete is exactly the failure the suite's other refusals
 * exist to prevent.
 *
 * | Exit | Meaning |
 * |---|---|
 * | 0 | every declared chart was written |
 * | 2 | unusable invocation — an unknown flag, an unreadable or malformed spec |
 * | 3 | refused — the data is not what the spec claims; nothing was drawn |
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildCharts,
  type Chart,
  CHART_NO_METRICS_CAUSE,
  CHART_TEST_REFUSED_CAUSE
} from './chartData.js';
import { readChartsSpec } from './chartSpec.js';
import { renderChartSvg } from './chartSvg.js';
import {
  exitCodeOf,
  invokedDirectly,
  messageOf,
  TOOL_EXIT_OK,
  TOOL_EXIT_REFUSED,
  TOOL_EXIT_USAGE
} from './cli/shared.js';
import { assertKnownFlags, type FlagSpec } from './flags.js';
import { HISTORY_FILE, readHistory } from './report.js';
import { SUITE_ROOT } from './run.js';

export const CHARTS_EXIT_OK = TOOL_EXIT_OK;

/** An unknown flag, or a spec that could not be read — no figure was written. */
export const CHARTS_EXIT_USAGE = TOOL_EXIT_USAGE;

/** A drawing guard refused: the runs are readable but not what the spec claims. */
export const CHARTS_EXIT_REFUSED = TOOL_EXIT_REFUSED;

/** The `error.cause` values THIS tool answers with a refusal rather than a usage code. */
const CHARTS_REFUSAL_CAUSES: readonly string[] = [
  CHART_NO_METRICS_CAUSE,
  CHART_TEST_REFUSED_CAUSE,
];

/** The committed figure declaration, next to the suite it draws. */
export const CHARTS_SPEC_FILE = 'charts.json';

/** Where the figures land, relative to the repository root. */
export const CHARTS_OUT_DIR = 'docs/analysis';

export interface ChartsOptions {
  readonly specPath: string;
  readonly resultsDir: string;
  readonly outDir: string;
}

const writeChart = (outDir: string, chart: Chart): string => {
  const path = resolve(outDir, `${chart.id}.svg`);
  writeFileSync(path, `${renderChartSvg(chart)}\n`, 'utf8');
  return path;
};

/**
 * Build EVERY chart before writing ANY: a spec entry that cannot resolve must
 * not leave a directory half-regenerated, where a stale figure sits beside a
 * fresh one with nothing to tell them apart.
 */
const regenerate = (options: ChartsOptions): readonly string[] => {
  const spec = readChartsSpec(options.specPath);
  const history = readHistory(resolve(options.resultsDir, HISTORY_FILE));
  const charts = buildCharts(
    { resultsDir: options.resultsDir, history, corpusDocuments: spec.corpusDocuments },
    spec
  );
  mkdirSync(options.outDir, { recursive: true });
  return charts.map(chart => writeChart(options.outDir, chart));
};

/**
 * EMPTY on purpose: every figure is declared in `charts.json`, so this script
 * reads no flag at all and a `--only` handed to it would have redrawn the whole
 * set while reading as a selection.
 */
export const CHARTS_FLAGS: FlagSpec = { value: [], boolean: [] };

export const main = (options: ChartsOptions, argv: readonly string[] = []): number => {
  try {
    assertKnownFlags(argv, CHARTS_FLAGS);
    const written = regenerate(options);
    process.stdout.write(`${written.join('\n')}\n`);
    return CHARTS_EXIT_OK;
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return exitCodeOf(error, CHARTS_REFUSAL_CAUSES);
  }
};

if (invokedDirectly(import.meta.url)) {
  const repoRoot = resolve(SUITE_ROOT, '../..');
  process.exitCode = main(
    {
      specPath: resolve(SUITE_ROOT, CHARTS_SPEC_FILE),
      resultsDir: resolve(SUITE_ROOT, 'results'),
      outDir: resolve(repoRoot, CHARTS_OUT_DIR),
    },
    process.argv.slice(2)
  );
}
