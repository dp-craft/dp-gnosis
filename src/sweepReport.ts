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
 * `report.runStamp` — millisecond resolution, because two sweeps fanned out in
 * the same minute at the same sha would otherwise write the same three paths
 * and the last writer would silently win.
 *
 * The SVG is hand-written. A charting dependency for one static figure would be
 * a dependency the suite has to keep alive forever, and the figure is a grid of
 * rectangles.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Metrics } from './metrics.js';
import { renderPerTopicTsv, runStamp } from './report.js';
import type { TopicScore } from './score.js';
import {
  CI_LEVEL,
  type MetricName,
  pairedScores,
  readPerTopic,
  type Significance,
  type SignificanceVerdict,
  type TopicScores
} from './significance.js';

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
  /**
   * This cell's per-topic TSV, RELATIVE to the suite's `results/` directory, so
   * a consumer pairs two cells by reading the recorded path instead of
   * rebuilding the filename — and a moved checkout still resolves.
   */
  readonly perTopicPath: string;
  /**
   * The paired test of THIS cell against its dataset's baseline cell on
   * `SIGNIFICANCE_METRIC` — `pValue`, `ciLow`, `ciHigh` and `significant` when it
   * ran, the named refusal when it could not. Absent on the baseline cell, which
   * has nothing to be compared with, and on a cell rated before its dataset's
   * baseline was measured.
   */
  readonly significance?: Significance;
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
  /** The cells AS WRITTEN — each non-baseline one carrying its verdict. */
  readonly cells: readonly SweepCell[];
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

// ------------------------------------------------------------ significance

/**
 * Is a cell's win over the baseline distinguishable from noise?
 *
 * A grid's best cell beat eleven others by construction, so its delta is a
 * maximum of a sample and reads high even when nothing moved: a measured scifact
 * sweep called `k1=1.2, b=0.6` the winner at +0.0019, which is p=0.46 with an
 * interval straddling zero. A delta printed without that qualifier is the exact
 * error the paired test exists to prevent, so every non-baseline cell is rated
 * against its OWN dataset's baseline before any artefact is written.
 *
 * The statistic is `significance.pairedScores`, unchanged and un-retuned — the
 * cells' per-topic TSVs are written in the run report's format precisely so this
 * is a read, not a second implementation. Rating is paid on every checkpoint
 * write, which costs one paired test per measured cell: cheap beside a cell's own
 * ranking pass, and it keeps an early-stopped sweep's artefacts complete.
 */
const SIGNIFICANCE_METRIC: MetricName = 'ndcg10';

interface LoadedCell {
  readonly path: string;
  readonly scores: TopicScores | undefined;
}

const loadCell = (resultsDir: string, cell: SweepCell): LoadedCell => {
  const path = resolve(resultsDir, cell.perTopicPath);
  return { path, scores: readPerTopic(path) };
};

/** Which side could not be read — a refusal names the file, never the verdict. */
const unreadable = (dataset: string, loaded: readonly LoadedCell[]): Significance => ({
  kind: 'missing-per-topic',
  dataset,
  paths: loaded.filter(one => one.scores === undefined).map(one => one.path),
});

const ratedAgainst = (resultsDir: string, base: SweepCell, cell: SweepCell): Significance => {
  const before = loadCell(resultsDir, base);
  const after = loadCell(resultsDir, cell);
  return before.scores === undefined || after.scores === undefined
    ? unreadable(cell.dataset, [before, after])
    : pairedScores(cell.dataset, SIGNIFICANCE_METRIC, before.scores, after.scores);
};

const rateCell = (
  resultsDir: string,
  cells: readonly SweepCell[],
  cell: SweepCell
): SweepCell => {
  const base = baselineCell(cellsFor(cells, cell.dataset));
  return cell.baseline || base === undefined
    ? cell
    : { ...cell, significance: ratedAgainst(resultsDir, base, cell) };
};

/** Every cell with its verdict against its dataset's baseline attached. */
export const rateCells = (
  resultsDir: string,
  cells: readonly SweepCell[]
): readonly SweepCell[] => cells.map(cell => rateCell(resultsDir, cells, cell));

const REFUSAL_REASONS: Readonly<Record<Exclude<Significance['kind'], 'verdict'>, string>> = {
  'topics-differ': 'topic sets differ',
  'missing-per-topic': 'per-topic scores missing',
  'provenance-changed': 'provenance changed',
  'unattributable-run': 'run records no per-topic path',
  'metric-unavailable': 'metric not recorded on both sides',
};

const verdictLabel = (verdict: SignificanceVerdict): string =>
  `${verdict.significant ? 'significant' : 'not significant'} ` +
  `(p=${metric(verdict.pValue)}, ${CI_LEVEL * 100}% CI ` +
  `[${signed(verdict.ciLow)}, ${signed(verdict.ciHigh)}])`;

/**
 * The verdict in prose. A refusal reads as NOT TESTED with its reason: rendering
 * it as "not significant" would claim a test that never ran. An unrated cell is
 * an em dash — absent, which is again not the same statement.
 */
export const significanceLabel = (significance: Significance | undefined): string => {
  if (significance === undefined) return '—';
  return significance.kind === 'verdict'
    ? verdictLabel(significance)
    : `not tested (${REFUSAL_REASONS[significance.kind]})`;
};

// --------------------------------------------------------------- per-topic

/**
 * The sweep's per-topic TSVs, under `results/sweep/`. Deliberately NOT the run
 * report's `results/per-topic/`: a sweep writes one file per CELL, and mixing
 * dozens of them into the directory a recorded run names by stem alone invites a
 * collision between a run and a cell measured in the same minute.
 */
export const SWEEP_PER_TOPIC_DIR = 'per-topic';

/** Fixed width, so `k1-0.80` sorts before `k1-1.20` as a string as well as a number. */
const PARAM_DIGITS = 2;

/** The part of a cell that identifies it — the file name has to carry all of it. */
export type SweepCellIdentity = Pick<SweepCell, 'dataset' | 'adapter' | 'k1' | 'b'>;

/**
 * `<stem>-<dataset>-<adapter>-k1-<k1>-b-<b>.tsv`, e.g.
 * `2026-08-14-0930-nfcorpus-linear-k1-1.20-b-0.60.tsv`.
 *
 * The stem leads so a sweep's files group and sort by run, exactly as the run
 * report's `<stem>-<dataset>.tsv` does. The two BM25 parameters are printed to a
 * FIXED two decimals and trail the name, which makes the tail unambiguous to
 * read back — a dataset id contains hyphens, the four trailing fields never do.
 */
export const sweepPerTopicName = (stem: string, cell: SweepCellIdentity): string =>
  `${stem}-${cell.dataset}-${cell.adapter}-` +
  `k1-${cell.k1.toFixed(PARAM_DIGITS)}-b-${cell.b.toFixed(PARAM_DIGITS)}.tsv`;

export interface SweepPerTopicOptions {
  /** The suite's `results/` directory — the TSV lands in `results/sweep/per-topic/`. */
  readonly resultsDir: string;
  /** The run's report stem, fixed once, so every cell of one sweep shares it. */
  readonly stem: string;
  readonly cell: SweepCellIdentity;
  readonly perTopic: readonly TopicScore[];
}

/**
 * Persist one cell's per-topic vector and return its path relative to
 * `resultsDir` — the value the cell records. Written in `report.ts`'s format by
 * `report.ts`'s own serializer, so `significance.readPerTopic` consumes a sweep
 * cell with no change at all.
 */
export const writeSweepPerTopic = (options: SweepPerTopicOptions): string => {
  const name = sweepPerTopicName(options.stem, options.cell);
  const dir = resolve(options.resultsDir, SWEEP_DIR, SWEEP_PER_TOPIC_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), renderPerTopicTsv(options.perTopic), 'utf8');
  return `${SWEEP_DIR}/${SWEEP_PER_TOPIC_DIR}/${name}`;
};

// ---------------------------------------------------------------- markdown

/** Any cutoff the sweep's depth did not reach, for `report.ts`'s reason. */
const optionalMetric = (value: number | undefined): string =>
  value === undefined ? '—' : metric(value);

const gridRow = (cell: SweepCell): string =>
  `| ${cell.dataset} | ${cell.k1} | ${cell.b} | ${cell.baseline ? 'baseline' : ''} | ` +
  `${metric(cell.metrics.ndcg10)} | ${optionalMetric(cell.metrics.recall10)} | ` +
  `${optionalMetric(cell.metrics.recall20)} | ${optionalMetric(cell.metrics.recall100)} | ` +
  `${metric(cell.metrics.mrr10)} | ${cell.queryMs} | ` +
  `${significanceLabel(cell.significance)} |`;

const GRID_HEADER: readonly string[] = [
  '| dataset | k1 | b | | nDCG@10 | R@10 | R@20 | R@100 | MRR@10 | query ms | vs baseline |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];

const bestRow = (cells: readonly SweepCell[], dataset: string): string => {
  const scoped = cellsFor(cells, dataset);
  const best = bestCell(scoped);
  const base = baselineCell(scoped);
  if (best === undefined || base === undefined) return `| ${dataset} | — | — | — | — | — |`;
  const delta = best.metrics.ndcg10 - base.metrics.ndcg10;
  return (
    `| ${dataset} | k1=${best.k1}, b=${best.b} | ${metric(best.metrics.ndcg10)} | ` +
    `${metric(base.metrics.ndcg10)} | ${signed(delta)} | ` +
    `${significanceLabel(best.significance)} |`
  );
};

const BEST_HEADER: readonly string[] = [
  '| dataset | best cell | best nDCG@10 | baseline (k1=1.2, b=0.75) | delta | vs baseline |',
  '|---|---|---|---|---|---|',
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
  const stem = runStamp(options.provenance.ts);
  const svgName = `${stem}-${ANALYSIS_SUFFIX}.svg`;
  const analysisDir = resolve(options.repoRoot, ANALYSIS_DIR);
  const sweepDir = resolve(options.resultsDir, SWEEP_DIR);
  mkdirSync(analysisDir, { recursive: true });
  mkdirSync(sweepDir, { recursive: true });
  const jsonPath = resolve(sweepDir, `${stem}-${options.provenance.gitSha}.json`);
  const markdownPath = resolve(analysisDir, `${stem}-${ANALYSIS_SUFFIX}.md`);
  const svgPath = resolve(analysisDir, svgName);
  const cells = rateCells(options.resultsDir, options.cells);
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ provenance: options.provenance, cells }, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(markdownPath, renderSweepMarkdown(options.provenance, cells, svgName), 'utf8');
  writeFileSync(svgPath, `${renderHeatmapSvg(cells)}\n`, 'utf8');
  return { jsonPath, markdownPath, svgPath, cells };
};
