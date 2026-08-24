import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCharts,
  type Chart,
  type ChartContext,
  type DeltaChart,
  type RecallDepthChart,
  RERANK_WINDOW
} from './chartData.js';
import { CHARTS_EXIT_OK, CHARTS_EXIT_USAGE, main } from './charts.js';
import { parseChartsSpec } from './chartSpec.js';
import { renderChartSvg } from './chartSvg.js';
import { HISTORY_FILE, type HistoryRow, PER_TOPIC_DIR } from './report.js';
import { SUITE_ROOT } from './run.js';

const BASE_ROW: HistoryRow = {
  ts: '2026-08-15T01:00:00.000Z',
  gitSha: 'aaa1111',
  dataset: 'vault',
  corpusBytes: 4096,
  corpusLines: 500,
  adapter: 'fts5',
  atomMaxChars: 2000,
  depth: 100,
  rerank: false,
  topics: 4,
  docCount: 500,
  atomCount: 500,
  ingestMs: 10,
  queryMs: 20,
  ndcg10: 0.4,
  recall10: 0.3,
  recall20: 0.45,
  recall100: 0.6,
  recall300: undefined,
  recall1000: undefined,
  mrr10: 0.35,
};

const HEADER = [
  'query_id',
  'ndcg10',
  'recall10',
  'recall20',
  'recall100',
  'recall300',
  'recall1000',
  'mrr10',
].join('\t');

const TOPIC_IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];

const tsvLine = (id: string, ndcg: number): string =>
  [id, ndcg.toFixed(4), '0.1000', '0.2000', '0.3000', '', '', '0.4000'].join('\t');

interface Fixture {
  readonly resultsDir: string;
  readonly rows: readonly HistoryRow[];
}

/** Two runs whose per-topic vectors differ by `deltas`, cycled over the topics. */
const fixture = (
  runs: ReadonlyArray<readonly [string, Partial<HistoryRow>, readonly number[]]>
): Fixture => {
  const resultsDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-charts-'));
  mkdirSync(resolve(resultsDir, PER_TOPIC_DIR), { recursive: true });
  const rows = runs.map(([name, overrides, scores]) => {
    const relative = `${PER_TOPIC_DIR}/${name}.tsv`;
    const body = [HEADER, ...TOPIC_IDS.map((id, i) => tsvLine(id, scores[i] ?? 0)), ''].join('\n');
    writeFileSync(resolve(resultsDir, relative), body, 'utf8');
    return { ...BASE_ROW, ...overrides, perTopicPath: relative };
  });
  writeFileSync(
    resolve(resultsDir, HISTORY_FILE),
    rows.map(row => `${JSON.stringify(row)}\n`).join(''),
    'utf8'
  );
  return { resultsDir, rows };
};

const FLAT = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
const LIFTED = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
const NOISY = [0.5, -0.1, 0.5, -0.1, 0.5, -0.1, 0.5, -0.1];

const deltaFixture = (): Fixture =>
  fixture([
    ['base-fts5-vault', { dataset: 'vault' }, FLAT],
    ['lifted-fts5-vault', { dataset: 'vault-rephrased', gitSha: 'bbb2222' }, LIFTED],
    ['noisy-fts5-vault', { dataset: 'vault-noisy' }, NOISY],
  ]);

const contextOf = (found: Fixture): ChartContext => ({
  resultsDir: found.resultsDir,
  history: found.rows,
  corpusDocuments: { vault: 500, 'vault-rephrased': 500, 'vault-noisy': 500 },
});

const DELTA_SPEC = {
  corpusDocuments: { vault: 500, 'vault-rephrased': 500, 'vault-noisy': 500 },
  charts: [
    {
      kind: 'delta',
      id: 'deltas',
      title: 'Deltas',
      comparisons: [
        { label: 'lifted', a: 'base-fts5-vault', b: 'lifted-fts5-vault', metric: 'ndcg10' },
        { label: 'noisy', a: 'base-fts5-vault', b: 'noisy-fts5-vault', metric: 'ndcg10' },
      ],
    },
  ],
};

const RECALL_SPEC = {
  corpusDocuments: { vault: 500 },
  charts: [
    {
      kind: 'recall-depth',
      id: 'depth',
      title: 'Recall vs depth',
      runs: [{ label: 'shallow', selector: 'base-fts5-vault' }],
    },
  ],
};

const ARMS_SPEC = {
  corpusDocuments: { vault: 500 },
  charts: [
    {
      kind: 'arms',
      id: 'arms',
      title: 'Arms',
      metrics: ['ndcg10', 'recall20'],
      runs: [
        { label: 'fts5', selector: 'base-fts5-vault' },
        { label: 'lifted', selector: 'lifted-fts5-vault' },
      ],
    },
  ],
};

/** Opens minus closes minus self-closes: a well-formed document nets to zero. */
const tagBalance = (svg: string): number => {
  const tags = svg.match(/<\/?[a-zA-Z]+/g) ?? [];
  const selfClosing = (svg.match(/\/>/g) ?? []).length;
  const opens = tags.filter(tag => !tag.startsWith('</')).length;
  return opens - (tags.length - opens) - selfClosing;
};

const expectWellFormed = (svg: string): void => {
  expect(svg.startsWith('<svg ')).toBe(true);
  expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  expect(tagBalance(svg)).toBe(0);
  expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|#)/);
};

/** The one chart a single-entry spec declared; absence is a test-setup error. */
const only = (charts: readonly Chart[]): Chart => {
  const chart = charts[0];
  if (chart === undefined) throw new Error('the spec declared no chart');
  return chart;
};

const isDelta = (chart: { readonly kind: string }): chart is DeltaChart => chart.kind === 'delta';
const isRecall = (chart: { readonly kind: string }): chart is RecallDepthChart =>
  chart.kind === 'recall-depth';

describe('chart spec', () => {
  it('parses the committed campaign spec', () => {
    const raw: unknown = JSON.parse(readFileSync(resolve(SUITE_ROOT, 'charts.json'), 'utf8'));
    const spec = parseChartsSpec(raw);
    expect(spec.corpusDocuments['vault']).toBe(11345);
    expect(spec.corpusDocuments['vault-hu']).toBe(454);
    expect([...new Set(spec.charts.map(chart => chart.kind))].sort()).toEqual([
      'arms',
      'delta',
      'recall-depth',
    ]);
  });

  it('refuses an unknown chart kind by name', () => {
    expect(() => parseChartsSpec({ corpusDocuments: { vault: 1 }, charts: [{ kind: 'pie' }] }))
      .toThrow(/"pie"/);
  });
});

describe('chart data', () => {
  it('fails loudly when a selector matches no recorded run', () => {
    const found = deltaFixture();
    const spec = parseChartsSpec({
      ...DELTA_SPEC,
      charts: [
        {
          ...DELTA_SPEC.charts[0],
          comparisons: [{ label: 'x', a: 'nothing-here', b: 'base-fts5-vault', metric: 'ndcg10' }],
        },
      ],
    });
    expect(() => buildCharts(contextOf(found), spec)).toThrow(/nothing-here/);
  });

  it('fails loudly when a selector is ambiguous', () => {
    const found = fixture([
      ['dup-a-fts5-vault', {}, FLAT],
      ['dup-b-fts5-vault', {}, FLAT],
    ]);
    const spec = parseChartsSpec({
      corpusDocuments: { vault: 500 },
      charts: [
        {
          kind: 'delta',
          id: 'd',
          title: 'D',
          comparisons: [{ label: 'x', a: 'fts5-vault', b: 'dup-a-fts5-vault', metric: 'ndcg10' }],
        },
      ],
    });
    expect(() => buildCharts(contextOf(found), spec)).toThrow(/ambiguous/);
  });

  it('marks a CI that crosses zero as indistinguishable, and one that does not as distinct', () => {
    const charts = buildCharts(contextOf(deltaFixture()), parseChartsSpec(DELTA_SPEC));
    const chart = charts.filter(isDelta)[0];
    expect(chart?.bars.map(bar => bar.crossesZero)).toEqual([false, true]);
    expect(chart?.bars[0]?.delta).toBeCloseTo(0.3, 6);
  });

  it('omits a cutoff the run never measured instead of plotting zero', () => {
    const charts = buildCharts(contextOf(deltaFixture()), parseChartsSpec(RECALL_SPEC));
    const chart = charts.filter(isRecall)[0];
    expect(chart?.lines[0]?.points.map(point => point.cutoff)).toEqual([10, 20, 100]);
    expect(chart?.lines[0]?.points.every(point => point.recall > 0)).toBe(true);
  });

  it('draws a random-ranking floor of k/N from the spec', () => {
    const charts = buildCharts(contextOf(deltaFixture()), parseChartsSpec(RECALL_SPEC));
    const floor = charts.filter(isRecall)[0]?.floors[0];
    expect(floor?.documents).toBe(500);
    expect(floor?.points.map(point => point.recall)).toEqual([0.02, 0.04, 0.2, 0.6, 1]);
  });

  it('captions every chart with the dataset, adapter, depth and sha it drew', () => {
    const charts = buildCharts(contextOf(deltaFixture()), parseChartsSpec(DELTA_SPEC));
    expect(charts[0]?.caption).toContain('vault');
    expect(charts[0]?.caption).toContain('fts5');
    expect(charts[0]?.caption).toContain('depth 100');
    expect(charts[0]?.caption).toContain('bbb2222');
  });
});

describe('chart svg', () => {
  it('renders a distinct style for a bar whose CI crosses zero', () => {
    const charts = buildCharts(contextOf(deltaFixture()), parseChartsSpec(DELTA_SPEC));
    const svg = renderChartSvg(only(charts));
    expect(svg).toContain('delta-sig');
    expect(svg).toContain('delta-null');
    expectWellFormed(svg);
  });

  it('renders well-formed, self-contained svg for every chart kind', () => {
    const context = contextOf(deltaFixture());
    const specs = [DELTA_SPEC, RECALL_SPEC, ARMS_SPEC];
    const svgs = specs.flatMap(spec =>
      buildCharts(context, parseChartsSpec(spec)).map(renderChartSvg)
    );
    expect(svgs).toHaveLength(3);
    svgs.forEach(expectWellFormed);
    const withoutNamespace = svgs.map(svg =>
      svg.replace('xmlns="http://www.w3.org/2000/svg"', '')
    );
    withoutNamespace.forEach(svg => expect(svg).not.toMatch(/https?:|<script|href=|@import/));
  });

  it('marks the reranker input window at the engine\'s own cutoff', () => {
    const charts = buildCharts(contextOf(deltaFixture()), parseChartsSpec(RECALL_SPEC));
    const svg = renderChartSvg(only(charts));
    expect(svg).toContain(`RERANK_K_INIT = ${RERANK_WINDOW}`);
    expect(svg).toContain('recall@k');
  });

  it('escapes label text rather than emitting raw markup', () => {
    const context = contextOf(deltaFixture());
    const spec = parseChartsSpec({
      ...DELTA_SPEC,
      charts: [
        {
          ...DELTA_SPEC.charts[0],
          comparisons: [
            { label: 'a & b <x>', a: 'base-fts5-vault', b: 'lifted-fts5-vault', metric: 'ndcg10' },
          ],
        },
      ],
    });
    const svg = renderChartSvg(only(buildCharts(context, spec)));
    expect(svg).toContain('a &amp; b &lt;x&gt;');
    expectWellFormed(svg);
  });
});

describe('charts cli', () => {
  const specFile = (body: unknown): string => {
    const dir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-charts-spec-'));
    const path = resolve(dir, 'charts.json');
    writeFileSync(path, JSON.stringify(body), 'utf8');
    return path;
  };

  it('writes one svg per chart and exits 0', () => {
    const found = deltaFixture();
    const outDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-charts-out-'));
    const code = main({
      specPath: specFile(DELTA_SPEC),
      resultsDir: found.resultsDir,
      outDir,
    });
    expect(code).toBe(CHARTS_EXIT_OK);
    expect(readFileSync(resolve(outDir, 'deltas.svg'), 'utf8')).toContain('<svg ');
  });

  it('exits non-zero and names the selector it could not resolve', () => {
    const found = deltaFixture();
    const outDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-charts-out-'));
    const code = main({
      specPath: specFile({
        ...DELTA_SPEC,
        charts: [
          {
            ...DELTA_SPEC.charts[0],
            comparisons: [{ label: 'x', a: 'ghost-run', b: 'base-fts5-vault', metric: 'ndcg10' }],
          },
        ],
      }),
      resultsDir: found.resultsDir,
      outDir,
    });
    expect(code).toBe(CHARTS_EXIT_USAGE);
  });
});
