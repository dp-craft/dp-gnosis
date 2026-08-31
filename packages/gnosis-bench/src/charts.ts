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
 * | 2 | the spec, a selector, or a refused paired test stopped it — nothing was drawn |
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildCharts, type Chart } from './chartData.js';
import { readChartsSpec } from './chartSpec.js';
import { renderChartSvg } from './chartSvg.js';
import { assertKnownFlags, type FlagSpec } from './flags.js';
import { HISTORY_FILE, readHistory } from './report.js';
import { SUITE_ROOT } from './run.js';

export const CHARTS_EXIT_OK = 0;

/** The spec, a selector, or a statistic refused — no figure was written. */
export const CHARTS_EXIT_USAGE = 2;

/** The committed figure declaration, next to the suite it draws. */
export const CHARTS_SPEC_FILE = 'charts.json';

/** Where the figures land, relative to the repository root. */
export const CHARTS_OUT_DIR = 'docs/analysis';

export interface ChartsOptions {
  readonly specPath: string;
  readonly resultsDir: string;
  readonly outDir: string;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
    return CHARTS_EXIT_USAGE;
  }
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
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
