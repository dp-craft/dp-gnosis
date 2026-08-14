/**
 * The sweep's artefacts: one machine record, one human document, one heatmap.
 *
 * | File | For |
 * |---|---|
 * | `results/sweep/<stem>-<sha>.json` | every cell, machine-readable |
 * | `docs/analysis/<stem>-bm25-k1-b-sweep.md` | the decision: best cell per dataset, delta vs baseline |
 * | `docs/analysis/<stem>-bm25-k1-b-sweep.svg` | the same nDCG@10 surface, one panel per dataset |
 *
 * Every cell carries `adapter`, `k1` and `b` next to its metrics, for the reason
 * `report.ts` carries `adapter`/`depth`/`atomMaxChars`: a number whose operating
 * point was not recorded cannot be compared with a later one. The stem is
 * `report.reportStem`, so a sweep and a run taken at the same minute sort
 * together.
 *
 * The SVG is hand-written. A charting dependency for one static figure would be
 * a dependency the suite has to keep alive forever, and the figure is a grid of
 * rectangles.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Metrics } from './metrics.js';
import { reportStem } from './report.js';

const METRIC_DIGITS = 4;
const CELL_DIGITS = 3;

/** Where the sweep's machine record goes, relative to the suite's `results/`. */
export const SWEEP_DIR = 'sweep';

/** The human artefact's directory, relative to the repository root. */
export const ANALYSIS_DIR = 'docs/analysis';

/** The document's name after the stem — the md and the svg share it. */
export const ANALYSIS_SUFFIX = 'bm25-k1-b-sweep';

/** The BM25 operating point the engine ships, and the sweep's reference cell. */
export const BASELINE_K1 = 1.2;
export const BASELINE_B = 0.75;

/** One measured (dataset, k1, b) point. */
export interface SweepCell {
  readonly dataset: string;
  /** Always `linear`: FTS5 hardcodes its own k1/b, so it cannot be swept. */
  readonly adapter: string;
  readonly k1: number;
  readonly b: number;
  /** True for the shipped `1.2`/`0.75` reference point. */
  readonly baseline: boolean;
  readonly topics: number;
  readonly docCount: number;
  readonly atomCount: number;
  readonly queryMs: number;
  readonly metrics: Metrics;
}

/** Facts true of the whole sweep. */
export interface SweepProvenance {
  readonly ts: string;
  readonly gitSha: string;
  readonly adapter: string;
  readonly depth: number;
  readonly k1s: readonly number[];
  readonly bs: readonly number[];
}

export interface SweepReportOptions {
  /** The suite's `results/` directory — the JSON lands in `results/sweep/`. */
  readonly resultsDir: string;
  /** The repository root — the md and the svg land in `<repoRoot>/docs/analysis/`. */
  readonly repoRoot: string;
  readonly provenance: SweepProvenance;
  readonly cells: readonly SweepCell[];
}

export interface WrittenSweep {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly svgPath: string;
}

const metric = (value: number): string => value.toFixed(METRIC_DIGITS);

const signed = (value: number): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(METRIC_DIGITS)}`;

/** Ascending, de-duplicated — the axis values a heatmap panel actually holds. */
const axisValues = (cells: readonly SweepCell[], of: (cell: SweepCell) => number): readonly number[] =>
  [...new Set(cells.map(of))].sort((a, b) => a - b);

export const datasetsOf = (cells: readonly SweepCell[]): readonly string[] => [
  ...new Set(cells.map(cell => cell.dataset)),
];

const cellsFor = (cells: readonly SweepCell[], dataset: string): readonly SweepCell[] =>
  cells.filter(cell => cell.dataset === dataset);

/** The best cell by nDCG@10; ties break on the lower `b`, then the lower `k1`. */
export const bestCell = (cells: readonly SweepCell[]): SweepCell | undefined =>
  [...cells].sort(
    (a, b) => b.metrics.ndcg10 - a.metrics.ndcg10 || a.b - b.b || a.k1 - b.k1
  )[0];

export const baselineCell = (cells: readonly SweepCell[]): SweepCell | undefined =>
  cells.find(cell => cell.baseline);

// ---------------------------------------------------------------- markdown

const gridRow = (cell: SweepCell): string =>
  `| ${cell.dataset} | ${cell.k1} | ${cell.b} | ${cell.baseline ? 'baseline' : ''} | ` +
  `${metric(cell.metrics.ndcg10)} | ${metric(cell.metrics.recall10)} | ` +
  `${metric(cell.metrics.recall100)} | ${metric(cell.metrics.mrr10)} | ${cell.queryMs} |`;

const GRID_HEADER: readonly string[] = [
  '| dataset | k1 | b | | nDCG@10 | R@10 | R@100 | MRR@10 | query ms |',
  '|---|---|---|---|---|---|---|---|---|',
];

const bestRow = (cells: readonly SweepCell[], dataset: string): string => {
  const scoped = cellsFor(cells, dataset);
  const best = bestCell(scoped);
  const base = baselineCell(scoped);
  if (best === undefined || base === undefined) return `| ${dataset} | — | — | — | — |`;
  const delta = best.metrics.ndcg10 - base.metrics.ndcg10;
  return (
    `| ${dataset} | k1=${best.k1}, b=${best.b} | ${metric(best.metrics.ndcg10)} | ` +
    `${metric(base.metrics.ndcg10)} | ${signed(delta)} |`
  );
};

const BEST_HEADER: readonly string[] = [
  '| dataset | best cell | best nDCG@10 | baseline (k1=1.2, b=0.75) | delta |',
  '|---|---|---|---|---|',
];

const CAVEAT: readonly string[] = [
  '> **These are LINEAR-adapter numbers.** The sweep drives',
  '> `createLinearScanAdapter` with `k1`/`b` injected, so every cell is the real',
  '> engine scoring the real corpus — but the `fts5` adapter CANNOT consume a',
  '> winning pair. SQLite FTS5 computes `bm25()` with k1 and b compiled in and',
  '> exposes no way to set them, so adopting a cell here means either running the',
  '> linear adapter in production or writing a custom scoring function over FTS5',
  '> term statistics. Treat the numbers as evidence about BM25\'s shape on this',
  '> material, not as a setting that can be switched on.',
];

const header = (provenance: SweepProvenance, svgName: string): readonly string[] => [
  '# BM25 k1 × b sweep',
  '',
  `- generated at: \`${provenance.ts}\``,
  `- git sha: \`${provenance.gitSha}\``,
  `- adapter: \`${provenance.adapter}\`, depth: ${provenance.depth}`,
  `- grid: k1 ∈ {${provenance.k1s.join(', ')}} × b ∈ {${provenance.bs.join(', ')}}`,
  '',
  ...CAVEAT,
  '',
  '## nDCG@10 surface',
  '',
  `![nDCG@10 by k1 and b](./${svgName})`,
  '',
  '## Best cell per dataset',
  '',
  ...BEST_HEADER,
];

export const renderSweepMarkdown = (
  provenance: SweepProvenance,
  cells: readonly SweepCell[],
  svgName: string
): string =>
  [
    ...header(provenance, svgName),
    ...datasetsOf(cells).map(dataset => bestRow(cells, dataset)),
    '',
    '## Every cell',
    '',
    ...GRID_HEADER,
    ...cells.map(gridRow),
    '',
  ].join('\n');

// -------------------------------------------------------------------- svg

const CELL_W = 86;
const CELL_H = 46;
const LEFT_PAD = 66;
const TOP_PAD = 52;
const PANEL_GAP = 34;
const FOOT = 16;
/** Lightness range of the single-hue ramp: pale at the worst cell, deep at the best. */
const LIGHT_MAX = 94;
const LIGHT_MIN = 46;
const HUE = 210;
/** Below this lightness the printed value needs light ink to stay legible. */
const INK_SWITCH = 62;

interface Panel {
  readonly dataset: string;
  readonly k1s: readonly number[];
  readonly bs: readonly number[];
  readonly cells: readonly SweepCell[];
}

const panelOf = (cells: readonly SweepCell[], dataset: string): Panel => {
  const scoped = cellsFor(cells, dataset);
  return {
    dataset,
    k1s: axisValues(scoped, cell => cell.k1),
    bs: axisValues(scoped, cell => cell.b),
    cells: scoped,
  };
};

const panelHeight = (panel: Panel): number => TOP_PAD + panel.k1s.length * CELL_H + PANEL_GAP;

/** `0` when every cell scores alike — a flat panel must not divide by zero. */
const shareOf = (value: number, low: number, high: number): number =>
  high === low ? 0 : (value - low) / (high - low);

const lightness = (share: number): number => LIGHT_MAX - share * (LIGHT_MAX - LIGHT_MIN);

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = (x: number, y: number, body: string, cls: string): string =>
  `<text x="${x}" y="${y}" class="${cls}">${escapeText(body)}</text>`;

interface CellBox {
  readonly x: number;
  readonly y: number;
  readonly share: number;
  readonly label: string;
}

const rect = (box: CellBox): string => {
  const fill = `hsl(${HUE} 62% ${lightness(box.share).toFixed(1)}%)`;
  const ink = lightness(box.share) < INK_SWITCH ? 'val light' : 'val';
  return (
    `<rect x="${box.x}" y="${box.y}" width="${CELL_W - 4}" height="${CELL_H - 4}" rx="4" ` +
    `fill="${fill}" stroke="#d5dae1"/>` +
    text(box.x + (CELL_W - 4) / 2, box.y + (CELL_H - 4) / 2 + 4, box.label, ink)
  );
};

interface PanelRange {
  readonly low: number;
  readonly high: number;
}

const rangeOf = (panel: Panel): PanelRange => {
  const scores = panel.cells.map(cell => cell.metrics.ndcg10);
  return { low: Math.min(...scores), high: Math.max(...scores) };
};

const cellAt = (panel: Panel, k1: number, b: number): SweepCell | undefined =>
  panel.cells.find(cell => cell.k1 === k1 && cell.b === b);

interface RowContext {
  readonly panel: Panel;
  readonly range: PanelRange;
  readonly top: number;
}

const drawCell = (context: RowContext, k1: number, b: number): string => {
  const cell = cellAt(context.panel, k1, b);
  if (cell === undefined) return '';
  const column = context.panel.bs.indexOf(b);
  const row = context.panel.k1s.indexOf(k1);
  return rect({
    x: LEFT_PAD + column * CELL_W,
    y: context.top + TOP_PAD + row * CELL_H,
    share: shareOf(cell.metrics.ndcg10, context.range.low, context.range.high),
    label: cell.metrics.ndcg10.toFixed(CELL_DIGITS),
  });
};

const drawRow = (context: RowContext, k1: number): readonly string[] => [
  text(
    LEFT_PAD - 10,
    context.top + TOP_PAD + context.panel.k1s.indexOf(k1) * CELL_H + CELL_H / 2,
    `k1=${k1}`,
    'axis end'
  ),
  ...context.panel.bs.map(b => drawCell(context, k1, b)),
];

const drawAxis = (panel: Panel, top: number): readonly string[] => [
  text(LEFT_PAD, top + 22, panel.dataset, 'title'),
  ...panel.bs.map((b, index) =>
    text(LEFT_PAD + index * CELL_W + (CELL_W - 4) / 2, top + TOP_PAD - 10, `b=${b}`, 'axis mid')
  ),
];

const drawPanel = (panel: Panel, top: number): readonly string[] => {
  const context: RowContext = { panel, range: rangeOf(panel), top };
  return [...drawAxis(panel, top), ...panel.k1s.flatMap(k1 => drawRow(context, k1))];
};

const STYLE =
  '<style>text{font-family:ui-sans-serif,system-ui,sans-serif}' +
  '.title{font-size:15px;font-weight:600;fill:#1b2530}' +
  '.axis{font-size:11px;fill:#5a6673}.mid{text-anchor:middle}.end{text-anchor:end}' +
  '.val{font-size:13px;text-anchor:middle;fill:#12202e}.light{fill:#f4f8fc}</style>';

/** Stacked panels, one per dataset: x is `b`, y is `k1`, shade is nDCG@10. */
export const renderHeatmapSvg = (cells: readonly SweepCell[]): string => {
  const panels = datasetsOf(cells).map(dataset => panelOf(cells, dataset));
  const tops = panels.reduce<readonly number[]>(
    (acc, panel) => [...acc, (acc.at(-1) ?? 0) + panelHeight(panel)],
    [0]
  );
  const width = LEFT_PAD + Math.max(1, ...panels.map(p => p.bs.length)) * CELL_W + 16;
  const height = (tops.at(-1) ?? 0) + FOOT;
  const body = panels.flatMap((panel, index) => drawPanel(panel, tops[index] ?? 0)).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="BM25 nDCG@10 by k1 and b">` +
    `${STYLE}<rect width="${width}" height="${height}" fill="#ffffff"/>${body}</svg>`
  );
};

// ------------------------------------------------------------------ write

export const writeSweepReport = (options: SweepReportOptions): WrittenSweep => {
  const stem = reportStem(options.provenance.ts);
  const svgName = `${stem}-${ANALYSIS_SUFFIX}.svg`;
  const analysisDir = resolve(options.repoRoot, ANALYSIS_DIR);
  const sweepDir = resolve(options.resultsDir, SWEEP_DIR);
  mkdirSync(analysisDir, { recursive: true });
  mkdirSync(sweepDir, { recursive: true });
  const jsonPath = resolve(sweepDir, `${stem}-${options.provenance.gitSha}.json`);
  const markdownPath = resolve(analysisDir, `${stem}-${ANALYSIS_SUFFIX}.md`);
  const svgPath = resolve(analysisDir, svgName);
  const record = { provenance: options.provenance, cells: options.cells };
  writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  writeFileSync(
    markdownPath,
    renderSweepMarkdown(options.provenance, options.cells, svgName),
    'utf8'
  );
  writeFileSync(svgPath, `${renderHeatmapSvg(options.cells)}\n`, 'utf8');
  return { jsonPath, markdownPath, svgPath };
};
