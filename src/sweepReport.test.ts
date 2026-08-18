import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Metrics } from './metrics.js';
import {
  ANALYSIS_DIR,
  bestCell,
  rateCells,
  renderHeatmapSvg,
  renderSweepMarkdown,
  significanceLabel,
  SWEEP_DIR,
  SWEEP_PER_TOPIC_DIR,
  type SweepCell,
  sweepPerTopicName,
  type SweepProvenance,
  writeSweepReport
} from './sweepReport.js';

const root = mkdtempSync(resolve(tmpdir(), 'gnosis-sweep-report-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const metrics = (ndcg10: number): Metrics => ({
  ndcg10,
  recall10: ndcg10 / 2,
  recall20: ndcg10 * 0.75,
  recall100: ndcg10,
  recall300: undefined,
  recall1000: undefined,
  precision5: 0.2,
  precision10: 0.15,
  allGoldInTop10: 1,
  map: 0.5,
  rPrecision: 0.4,
  rbpResidual: 0.3,
  mrr10: ndcg10 * 2,
});

interface CellSpec {
  readonly dataset: string;
  readonly k1: number;
  readonly b: number;
  readonly ndcg10: number;
  readonly baseline?: boolean;
}

const cell = (spec: CellSpec): SweepCell => ({
  dataset: spec.dataset,
  adapter: 'linear',
  k1: spec.k1,
  b: spec.b,
  baseline: spec.baseline ?? false,
  topics: 10,
  docCount: 20,
  atomCount: 30,
  queryMs: 1234,
  metrics: metrics(spec.ndcg10),
  perTopicPath: `${SWEEP_DIR}/${SWEEP_PER_TOPIC_DIR}/${sweepPerTopicName('2026-08-14-0930', {
    dataset: spec.dataset,
    adapter: 'linear',
    k1: spec.k1,
    b: spec.b,
  })}`,
});

const cells: readonly SweepCell[] = [
  cell({ dataset: 'nfcorpus', k1: 1.2, b: 0.6, ndcg10: 0.31 }),
  cell({ dataset: 'nfcorpus', k1: 0.8, b: 0.3, ndcg10: 0.34 }),
  cell({ dataset: 'nfcorpus', k1: 1.2, b: 0.75, ndcg10: 0.325, baseline: true }),
  cell({ dataset: 'scifact', k1: 1.2, b: 0.6, ndcg10: 0.61 }),
  cell({ dataset: 'scifact', k1: 1.2, b: 0.75, ndcg10: 0.6, baseline: true }),
];

const provenance: SweepProvenance = {
  ts: '2026-08-14T09:30:00.000Z',
  gitSha: 'abc1234',
  adapter: 'linear',
  depth: 100,
  k1s: [1.2, 0.8],
  bs: [0.6, 0.3],
};

describe('bestCell', () => {
  it('picks the highest nDCG@10', () => {
    expect(bestCell(cells.filter(c => c.dataset === 'nfcorpus'))?.k1).toBe(0.8);
  });

  it('breaks a tie on the lower b, then the lower k1', () => {
    const tied: readonly SweepCell[] = [
      cell({ dataset: 'd', k1: 1.2, b: 0.6, ndcg10: 0.5 }),
      cell({ dataset: 'd', k1: 0.8, b: 0.3, ndcg10: 0.5 }),
    ];

    expect(bestCell(tied)?.b).toBe(0.3);
  });

  it('yields undefined for no cells', () => {
    expect(bestCell([])).toBeUndefined();
  });
});

describe('renderSweepMarkdown', () => {
  const markdown = renderSweepMarkdown(provenance, cells, 'figure.svg');

  it('states that the numbers are linear-adapter numbers FTS5 cannot consume', () => {
    expect(markdown).toContain('LINEAR-adapter numbers');
    expect(markdown).toMatch(/FTS5 .*CANNOT consume|CANNOT consume/);
  });

  it('reports the best cell and its delta against the baseline', () => {
    expect(markdown).toContain('| nfcorpus | k1=0.8, b=0.3 | 0.3400 | 0.3250 | +0.0150 |');
    expect(markdown).toContain('| scifact | k1=1.2, b=0.6 | 0.6100 | 0.6000 | +0.0100 |');
  });

  it('never prints a delta without the verdict beside it', () => {
    // An unrated cell reads as an em dash, not as "not significant": absent is
    // not the same statement as tested-and-noise.
    const best = markdown.split('\n').filter(line => line.startsWith('| nfcorpus | k1='));

    expect(best).toHaveLength(1);
    expect(best[0]?.endsWith('| — |')).toBe(true);
  });

  it('carries one row per measured cell, with every tabled metric incl. R@20', () => {
    expect(markdown).toContain(
      '| nfcorpus | 1.2 | 0.75 | baseline | 0.3250 | 0.1625 | 0.2438 | 0.3250 |'
    );
    expect(markdown.split('\n').filter(line => line.startsWith('| nfcorpus | 1'))).toHaveLength(2);
  });

  it('references the svg beside it', () => {
    expect(markdown).toContain('![nDCG@10 by k1 and b](./figure.svg)');
  });
});

describe('renderHeatmapSvg', () => {
  const svg = renderHeatmapSvg(cells);

  it('is a well-formed standalone svg element', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('draws one panel per dataset, labelled', () => {
    expect(svg).toContain('>nfcorpus<');
    expect(svg).toContain('>scifact<');
  });

  it('puts b on the x axis and k1 on the y axis', () => {
    expect(svg).toContain('>b=0.6<');
    expect(svg).toContain('>b=0.75<');
    expect(svg).toContain('>k1=1.2<');
    expect(svg).toContain('>k1=0.8<');
  });

  it('prints each cell value and shades it', () => {
    expect(svg).toContain('>0.340<');
    expect(svg).toContain('>0.325<');
    expect(svg).toContain('>0.310<');
    expect(svg).toMatch(/fill="hsl\(210 62% [\d.]+%\)"/);
  });

  it('shades the best cell of a panel darker than the worst', () => {
    const lightness = [...svg.matchAll(/hsl\(210 62% ([\d.]+)%\)/g)].map(m => Number(m[1]));

    expect(Math.min(...lightness)).toBeLessThan(Math.max(...lightness));
  });

  it('does not divide by zero when every cell in a panel scores alike', () => {
    const flat = renderHeatmapSvg([
      cell({ dataset: 'd', k1: 1.2, b: 0.6, ndcg10: 0.5 }),
      cell({ dataset: 'd', k1: 0.8, b: 0.3, ndcg10: 0.5 }),
    ]);

    expect(flat).not.toContain('NaN');
  });
});

describe('rateCells', () => {
  const ratedResults = resolve(root, 'rated-results');
  const TOPICS = 24;

  const perTopicTsv = (score: (index: number) => number): string =>
    [
      'query_id\tndcg10\trecall10\trecall100\tmrr10',
      ...Array.from({ length: TOPICS }, (_unused, index) => `q${index}\t${score(index)}\t0\t0\t0`),
    ].join('\n');

  const writePerTopic = (target: SweepCell, score: (index: number) => number): void => {
    const path = resolve(ratedResults, target.perTopicPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${perTopicTsv(score)}\n`, 'utf8');
  };

  const base = cell({ dataset: 'nfcorpus', k1: 1.2, b: 0.75, ndcg10: 0.325, baseline: true });
  const better = cell({ dataset: 'nfcorpus', k1: 0.8, b: 0.3, ndcg10: 0.34 });
  const noise = cell({ dataset: 'nfcorpus', k1: 1.0, b: 0.4, ndcg10: 0.326 });
  const unreadable = cell({ dataset: 'nfcorpus', k1: 1.2, b: 0.6, ndcg10: 0.31 });

  writePerTopic(base, () => 0.1);
  writePerTopic(better, () => 0.6);
  writePerTopic(noise, index => (index % 2 === 0 ? 0.2 : 0));

  const rated = rateCells(ratedResults, [base, better, noise, unreadable]);
  const at = (k1: number): SweepCell | undefined => rated.find(c => c.k1 === k1 && c.b !== 0.6);

  it('gives a cell that really differs from the baseline a verdict', () => {
    const verdict = at(0.8)?.significance;

    expect(verdict?.kind).toBe('verdict');
    expect(verdict).toMatchObject({ metric: 'ndcg10', topics: TOPICS, significant: true });
    expect(verdict?.kind === 'verdict' && verdict.pValue).toBeLessThan(0.05);
    expect(verdict?.kind === 'verdict' && verdict.ciLow).toBeGreaterThan(0);
  });

  it('calls a delta indistinguishable from noise not significant', () => {
    const verdict = at(1.0)?.significance;

    expect(verdict).toMatchObject({ kind: 'verdict', significant: false });
    expect(significanceLabel(verdict)).toContain('not significant');
  });

  it('leaves the baseline cell without a verdict against itself', () => {
    expect(at(1.2)?.baseline).toBe(true);
    expect(at(1.2)?.significance).toBeUndefined();
  });

  it('reports a refusal as not tested, with its reason, never as not significant', () => {
    const refused = rated.find(c => c.b === 0.6)?.significance;

    expect(refused).toMatchObject({ kind: 'missing-per-topic' });
    expect(significanceLabel(refused)).toBe('not tested (per-topic scores missing)');
    expect(significanceLabel(refused)).not.toContain('not significant');
  });

  it('names only the unreadable side of the pair', () => {
    const refused = rated.find(c => c.b === 0.6)?.significance;

    expect(refused?.kind === 'missing-per-topic' && refused.paths).toHaveLength(1);
    expect(refused?.kind === 'missing-per-topic' && refused.paths[0]).toContain('k1-1.20-b-0.60');
  });

  it('carries every verdict into the human document', () => {
    const markdown = renderSweepMarkdown(provenance, rated, 'figure.svg');

    expect(markdown).toContain('not tested (per-topic scores missing)');
    expect(markdown).toContain('95% CI');
  });
});

describe('writeSweepReport', () => {
  it('writes the json under results/sweep and the md + svg under docs/analysis', () => {
    const written = writeSweepReport({
      resultsDir: resolve(root, 'results'),
      repoRoot: resolve(root, 'repo'),
      provenance,
      cells,
    });

    expect(written.jsonPath).toBe(
      resolve(root, 'results', SWEEP_DIR, '2026-08-14-093000000-abc1234.json')
    );
    expect(written.markdownPath).toBe(
      resolve(root, 'repo', ANALYSIS_DIR, '2026-08-14-093000000-bm25-k1-b-sweep.md')
    );
    expect(written.svgPath).toBe(
      resolve(root, 'repo', ANALYSIS_DIR, '2026-08-14-093000000-bm25-k1-b-sweep.svg')
    );
  });

  it('gives two sweeps started in the same minute distinct json, md and svg paths', () => {
    const call = (ts: string): ReturnType<typeof writeSweepReport> =>
      writeSweepReport({
        resultsDir: resolve(root, 'results'),
        repoRoot: resolve(root, 'repo'),
        provenance: { ...provenance, ts },
        cells,
      });

    const first = call('2026-08-14T09:30:12.345Z');
    const second = call('2026-08-14T09:30:47.891Z');

    expect(first.jsonPath).not.toBe(second.jsonPath);
    expect(first.markdownPath).not.toBe(second.markdownPath);
    expect(first.svgPath).not.toBe(second.svgPath);
    const paths = [
      first.jsonPath,
      first.markdownPath,
      first.svgPath,
      second.jsonPath,
      second.markdownPath,
      second.svgPath,
    ];
    expect(paths.filter(path => existsSync(path))).toEqual(paths);
  });

  it('records k1, b and adapter on every cell of the machine record', () => {
    const written = writeSweepReport({
      resultsDir: resolve(root, 'results'),
      repoRoot: resolve(root, 'repo'),
      provenance,
      cells,
    });
    const parsed: unknown = JSON.parse(readFileSync(written.jsonPath, 'utf8'));
    const record = parsed as { readonly cells: readonly SweepCell[] };

    expect(record.cells).toHaveLength(cells.length);
    expect(record.cells.every(c => c.adapter === 'linear')).toBe(true);
    expect(record.cells.map(c => c.k1)).toEqual([1.2, 0.8, 1.2, 1.2, 1.2]);
    expect(record.cells.map(c => c.b)).toEqual([0.6, 0.3, 0.75, 0.6, 0.75]);
  });
});
