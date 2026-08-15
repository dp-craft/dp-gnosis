/**
 * The figures themselves — hand-written SVG, for the reason `sweepReport.ts`
 * writes its heatmap by hand: a charting dependency for a handful of static
 * figures is a dependency the suite has to keep alive forever, and these are
 * rectangles, lines and text.
 *
 * The visual language is `sweepReport.ts`'s, deliberately: same font stack, same
 * ink, same single-hue ramp, so the campaign's figures read as one set. Nothing
 * is fetched — no external font, no CDN, no script — so a committed SVG renders
 * identically in a browser, in a viewer, and in five years.
 *
 * One rule the styling exists to serve: a delta bar whose 95% interval crosses
 * zero is drawn PALE and DASHED, and a bar whose interval clears zero is drawn
 * SOLID. The distinction is the entire content of the figure — and it says
 * distinguishable from noise, never better.
 */
import type {
  ArmChart,
  ArmGroup,
  Chart,
  DeltaBar,
  DeltaChart,
  RecallDepthChart,
  RecallPoint
} from './chartData.js';
import { CUTOFFS, METRIC_LABELS, RERANK_WINDOW } from './chartData.js';
import { CI_LEVEL } from './significance.js';

const DIGITS = 4;
const AXIS_DIGITS = 2;
const PERCENT = 100;

/** Ordered so adjacent series stay distinguishable in grayscale print too. */
const SERIES_COLORS: readonly string[] = [
  'hsl(210 62% 46%)',
  'hsl(24 74% 44%)',
  'hsl(150 46% 34%)',
  'hsl(280 40% 48%)',
  'hsl(200 20% 40%)',
];

const STYLE =
  '<style>text{font-family:ui-sans-serif,system-ui,sans-serif}' +
  '.title{font-size:16px;font-weight:600;fill:#1b2530}' +
  '.note{font-size:11px;fill:#5a6673}' +
  '.axis{font-size:11px;fill:#5a6673}.mid{text-anchor:middle}.end{text-anchor:end}' +
  '.caption{font-size:10px;fill:#6b7684}' +
  '.grid{stroke:#e3e7ec}.zero{stroke:#8c98a5}' +
  '.whisker{stroke:#39424d;stroke-width:1.5}' +
  '.delta-sig{fill:hsl(210 62% 46%)}' +
  '.delta-null{fill:hsl(210 14% 88%);stroke:#8c98a5;stroke-dasharray:3 2}' +
  '.floor{fill:none;stroke:#aeb6c0;stroke-width:1.5;stroke-dasharray:5 4}' +
  '.rerank{stroke:#c2410c;stroke-width:1.5;stroke-dasharray:4 3}' +
  '.rerank-label{font-size:11px;fill:#c2410c}' +
  '.curve{fill:none;stroke-width:2}</style>';

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = (x: number, y: number, body: string, cls: string): string =>
  `<text x="${x}" y="${y}" class="${cls}">${escapeText(body)}</text>`;

const line = (x1: number, y1: number, x2: number, y2: number, cls: string): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;

const box = (x: number, y: number, w: number, h: number, cls: string): string =>
  `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" class="${cls}"/>`;

const filledBox = (x: number, y: number, w: number, h: number, fill: string): string =>
  `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}"/>`;

const polyline = (points: readonly string[], cls: string, stroke: string): string =>
  `<polyline points="${points.join(' ')}" class="${cls}" stroke="${stroke}"/>`;

const colorAt = (index: number): string =>
  SERIES_COLORS[index % SERIES_COLORS.length] ?? 'hsl(210 62% 46%)';

const number = (value: number): string => value.toFixed(DIGITS);

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${number(value)}`;

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly body: readonly string[];
}

const svgDocument = (frame: Frame): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" ` +
  `viewBox="0 0 ${frame.width} ${frame.height}" role="img" ` +
  `aria-label="${escapeText(frame.label)}">${STYLE}` +
  `<rect width="${frame.width}" height="${frame.height}" fill="#ffffff"/>` +
  `${frame.body.join('')}</svg>`;

// ------------------------------------------------------------- delta bars

const DELTA_LABEL_W = 250;
const DELTA_X0 = 262;
const DELTA_W = 500;
const DELTA_STAT_X = DELTA_X0 + DELTA_W + 16;
const DELTA_WIDTH = 1100;
const DELTA_TOP = 74;
const DELTA_ROW_H = 30;
const BAR_H = 12;
const CAP_H = 8;
const PAD_SHARE = 0.08;

interface Scale {
  readonly low: number;
  readonly high: number;
}

const deltaScale = (bars: readonly DeltaBar[]): Scale => {
  const values = bars.flatMap(bar => [bar.ciLow, bar.ciHigh, bar.delta, 0]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max(high - low, Number.EPSILON) * PAD_SHARE;
  return { low: low - pad, high: high + pad };
};

const atValue = (scale: Scale, value: number): number =>
  DELTA_X0 + ((value - scale.low) / (scale.high - scale.low)) * DELTA_W;

const barRect = (bar: DeltaBar, scale: Scale, center: number): string => {
  const zero = atValue(scale, 0);
  const end = atValue(scale, bar.delta);
  const cls = bar.crossesZero ? 'delta-null' : 'delta-sig';
  return box(Math.min(zero, end), center - BAR_H / 2, Math.abs(end - zero), BAR_H, cls);
};

const whisker = (bar: DeltaBar, scale: Scale, center: number): readonly string[] => {
  const low = atValue(scale, bar.ciLow);
  const high = atValue(scale, bar.ciHigh);
  return [
    line(low, center, high, center, 'whisker'),
    line(low, center - CAP_H / 2, low, center + CAP_H / 2, 'whisker'),
    line(high, center - CAP_H / 2, high, center + CAP_H / 2, 'whisker'),
  ];
};

const statText = (bar: DeltaBar): string =>
  `${signed(bar.delta)}  p=${number(bar.pValue)}  ${CI_LEVEL * PERCENT}% CI ` +
  `[${signed(bar.ciLow)}, ${signed(bar.ciHigh)}]  n=${bar.topics}` +
  `${bar.crossesZero ? '  — indistinguishable' : ''}`;

const deltaRow = (bar: DeltaBar, index: number, scale: Scale): readonly string[] => {
  const center = DELTA_TOP + index * DELTA_ROW_H + DELTA_ROW_H / 2;
  return [
    text(DELTA_LABEL_W, center + 4, `${bar.label} · ${METRIC_LABELS[bar.metric]}`, 'axis end'),
    ...whisker(bar, scale, center),
    barRect(bar, scale, center),
    text(DELTA_STAT_X, center + 4, statText(bar), 'axis'),
  ];
};

const deltaAxis = (scale: Scale, bottom: number): readonly string[] => [
  line(atValue(scale, 0), DELTA_TOP - 8, atValue(scale, 0), bottom, 'zero'),
  text(DELTA_X0, bottom + 18, scale.low.toFixed(AXIS_DIGITS), 'axis mid'),
  text(DELTA_X0 + DELTA_W, bottom + 18, scale.high.toFixed(AXIS_DIGITS), 'axis mid'),
  text(atValue(scale, 0), bottom + 18, '0', 'axis mid'),
];

const DELTA_NOTE =
  'bar solid = 95% CI clears zero (distinguishable from noise); ' +
  'pale + dashed = CI crosses zero. Significant means distinguishable, never better.';

const renderDelta = (chart: DeltaChart): string => {
  const scale = deltaScale(chart.bars);
  const bottom = DELTA_TOP + chart.bars.length * DELTA_ROW_H;
  return svgDocument({
    width: DELTA_WIDTH,
    height: bottom + 74,
    label: chart.title,
    body: [
      text(20, 28, chart.title, 'title'),
      text(20, 48, DELTA_NOTE, 'note'),
      ...deltaAxis(scale, bottom),
      ...chart.bars.flatMap((bar, index) => deltaRow(bar, index, scale)),
      text(
        DELTA_X0 + DELTA_W / 2,
        bottom + 40,
        `mean paired difference in ${chart.metricLabel} (B − A)`,
        'axis mid'
      ),
      text(20, bottom + 62, chart.caption, 'caption'),
    ],
  });
};

// -------------------------------------------------------- recall vs depth

const CURVE_X0 = 88;
const CURVE_X1 = 700;
const CURVE_TOP = 78;
const CURVE_BOTTOM = 390;
const CURVE_WIDTH = 920;
const Y_TICKS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];
const LEGEND_ROW_H = 16;

const logAt = (cutoff: number): number => {
  const span = Math.log10(1000) - Math.log10(10);
  return CURVE_X0 + ((Math.log10(cutoff) - Math.log10(10)) / span) * (CURVE_X1 - CURVE_X0);
};

const recallAt = (recall: number): number =>
  CURVE_BOTTOM - recall * (CURVE_BOTTOM - CURVE_TOP);

const pointsOf = (points: readonly RecallPoint[]): readonly string[] =>
  points.map(point => `${logAt(point.cutoff).toFixed(1)},${recallAt(point.recall).toFixed(1)}`);

const dots = (points: readonly RecallPoint[], color: string): readonly string[] =>
  points.map(
    point =>
      `<circle cx="${logAt(point.cutoff).toFixed(1)}" cy="${recallAt(point.recall).toFixed(1)}" ` +
      `r="3" fill="${color}"/>`
  );

const curveGrid = (): readonly string[] => [
  ...Y_TICKS.flatMap(tick => [
    line(CURVE_X0, recallAt(tick), CURVE_X1, recallAt(tick), 'grid'),
    text(CURVE_X0 - 8, recallAt(tick) + 4, tick.toFixed(AXIS_DIGITS), 'axis end'),
  ]),
  ...CUTOFFS.map(cutoff => text(logAt(cutoff), CURVE_BOTTOM + 18, `${cutoff}`, 'axis mid')),
];

const rerankMark = (): readonly string[] => [
  line(logAt(RERANK_WINDOW), CURVE_TOP - 10, logAt(RERANK_WINDOW), CURVE_BOTTOM, 'rerank'),
  text(
    logAt(RERANK_WINDOW) + 6,
    CURVE_TOP - 14,
    `RERANK_K_INIT = ${RERANK_WINDOW} — the reranker's input window`,
    'rerank-label'
  ),
];

const legendRow = (index: number, label: string, color: string): readonly string[] => {
  const y = CURVE_BOTTOM + 48 + index * LEGEND_ROW_H;
  return [filledBox(CURVE_X0, y - 8, 10, 10, color), text(CURVE_X0 + 16, y, label, 'axis')];
};

const curveLegend = (chart: RecallDepthChart): readonly string[] => [
  ...chart.lines.flatMap((one, index) => legendRow(index, one.label, colorAt(index))),
  ...chart.floors.map(
    (floor, index) =>
      text(
        CURVE_X0,
        CURVE_BOTTOM + 48 + (chart.lines.length + index) * LEGEND_ROW_H,
        `— — random-ranking floor, ${floor.dataset}: E[recall@k] = k/${floor.documents}`,
        'axis'
      )
  ),
];

const renderRecallDepth = (chart: RecallDepthChart): string => {
  const rows = chart.lines.length + chart.floors.length;
  const height = CURVE_BOTTOM + 74 + rows * LEGEND_ROW_H;
  return svgDocument({
    width: CURVE_WIDTH,
    height,
    label: chart.title,
    body: [
      text(20, 28, chart.title, 'title'),
      text(20, 48, 'recall@k against retrieval cutoff k, log x-axis', 'note'),
      ...curveGrid(),
      ...chart.floors.map(floor => polyline(pointsOf(floor.points), 'floor', '#aeb6c0')),
      ...rerankMark(),
      ...chart.lines.flatMap((one, index) => [
        polyline(pointsOf(one.points), 'curve', colorAt(index)),
        ...dots(one.points, colorAt(index)),
      ]),
      text((CURVE_X0 + CURVE_X1) / 2, CURVE_BOTTOM + 36, 'retrieval cutoff k (log)', 'axis mid'),
      text(CURVE_X0 - 60, CURVE_TOP - 14, 'recall@k', 'axis'),
      ...curveLegend(chart),
      text(20, height - 14, chart.caption, 'caption'),
    ],
  });
};

// ------------------------------------------------------------ arm groups

const ARM_X0 = 78;
const ARM_X1 = 860;
const ARM_TOP = 78;
const ARM_BOTTOM = 380;
const ARM_WIDTH = 900;
const ARM_GAP = 0.25;

const armY = (value: number): number => ARM_BOTTOM - value * (ARM_BOTTOM - ARM_TOP);

interface ArmLayout {
  readonly groupW: number;
  readonly barW: number;
}

const layoutOf = (chart: ArmChart): ArmLayout => {
  const groupW = (ARM_X1 - ARM_X0) / Math.max(1, chart.groups.length);
  return { groupW, barW: (groupW * (1 - ARM_GAP)) / Math.max(1, chart.metrics.length) };
};

const armBar = (
  layout: ArmLayout,
  origin: number,
  bar: { readonly value: number; readonly metric: string },
  index: number
): readonly string[] => {
  const x = origin + index * layout.barW;
  return [
    filledBox(x, armY(bar.value), layout.barW - 3, ARM_BOTTOM - armY(bar.value), colorAt(index)),
    text(x + (layout.barW - 3) / 2, armY(bar.value) - 5, number(bar.value), 'axis mid'),
  ];
};

const armGroup = (
  group: ArmGroup,
  layout: ArmLayout,
  index: number
): readonly string[] => {
  const origin = ARM_X0 + index * layout.groupW + (layout.groupW * ARM_GAP) / 2;
  return [
    ...group.bars.flatMap((bar, position) => armBar(layout, origin, bar, position)),
    text(ARM_X0 + (index + 0.5) * layout.groupW, ARM_BOTTOM + 18, group.label, 'axis mid'),
  ];
};

const armGrid = (): readonly string[] =>
  Y_TICKS.flatMap(tick => [
    line(ARM_X0, armY(tick), ARM_X1, armY(tick), 'grid'),
    text(ARM_X0 - 8, armY(tick) + 4, tick.toFixed(AXIS_DIGITS), 'axis end'),
  ]);

const armLegend = (chart: ArmChart): readonly string[] =>
  chart.metrics.flatMap((metric, index) => [
    filledBox(ARM_X0 + index * 140, ARM_BOTTOM + 36, 10, 10, colorAt(index)),
    text(ARM_X0 + index * 140 + 16, ARM_BOTTOM + 45, METRIC_LABELS[metric], 'axis'),
  ]);

const renderArms = (chart: ArmChart): string => {
  const layout = layoutOf(chart);
  const height = ARM_BOTTOM + 96;
  return svgDocument({
    width: ARM_WIDTH,
    height,
    label: chart.title,
    body: [
      text(20, 28, chart.title, 'title'),
      text(20, 48, 'one group per arm, one bar per metric', 'note'),
      ...armGrid(),
      ...chart.groups.flatMap((group, index) => armGroup(group, layout, index)),
      text(ARM_X0 - 60, ARM_TOP - 14, 'score', 'axis'),
      text((ARM_X0 + ARM_X1) / 2, ARM_BOTTOM + 36, 'arm', 'axis mid'),
      ...armLegend(chart),
      text(20, height - 14, chart.caption, 'caption'),
    ],
  });
};

/** The figure as a self-contained document — no font, no CDN, no script. */
export const renderChartSvg = (chart: Chart): string => {
  if (chart.kind === 'delta') return renderDelta(chart);
  if (chart.kind === 'recall-depth') return renderRecallDepth(chart);
  return renderArms(chart);
};
