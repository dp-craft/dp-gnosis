import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Metrics } from './metrics.js';
import {
  ANALYSIS_DIR,
  bestCell,
  renderHeatmapSvg,
  renderSweepMarkdown,
  SWEEP_DIR,
  type SweepCell,
  type SweepProvenance,
  writeSweepReport
} from './sweepReport.js';

const root = mkdtempSync(resolve(tmpdir(), 'gnosis-sweep-report-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const metrics = (ndcg10: number): Metrics => ({
  ndcg10,
  recall10: ndcg10 / 2,
  recall100: ndcg10,
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

  it('carries one row per measured cell, with all four metrics', () => {
    expect(markdown).toContain('| nfcorpus | 1.2 | 0.75 | baseline | 0.3250 | 0.1625 | 0.3250 |');
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

describe('writeSweepReport', () => {
  it('writes the json under results/sweep and the md + svg under docs/analysis', () => {
    const written = writeSweepReport({
      resultsDir: resolve(root, 'results'),
      repoRoot: resolve(root, 'repo'),
      provenance,
      cells,
    });

    expect(written.jsonPath).toBe(
      resolve(root, 'results', SWEEP_DIR, '2026-08-14-0930-abc1234.json')
    );
    expect(written.markdownPath).toBe(
      resolve(root, 'repo', ANALYSIS_DIR, '2026-08-14-0930-bm25-k1-b-sweep.md')
    );
    expect(written.svgPath).toBe(
      resolve(root, 'repo', ANALYSIS_DIR, '2026-08-14-0930-bm25-k1-b-sweep.svg')
    );
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
