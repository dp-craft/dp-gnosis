import { describe, expect, it } from 'vitest';

import type { DatasetEntry } from './manifest.js';
import { buildGrid, numberCsv, parseSweepArgs, selectDatasets } from './sweep.js';

const DEFAULT_CELLS = 12;
const BASELINE_CELLS = 1;

describe('parseSweepArgs', () => {
  it('defaults to the specified grid and the four default datasets', () => {
    const options = parseSweepArgs([]);

    expect(options.k1s).toEqual([1.2, 1.0, 0.8]);
    expect(options.bs).toEqual([0.6, 0.5, 0.4, 0.3]);
    expect(options.depth).toBe(100);
  });

  it('leads with the most-informative dataset, so an early stop keeps it', () => {
    // A default sweep is hours long and expected to be cut short; the split
    // carrying the BM25 deficit must be measured before the cheap ones.
    expect(parseSweepArgs([]).only).toEqual([
      'bright-biology-passages',
      'bright-biology',
      'nfcorpus',
      'scifact',
    ]);
  });

  it('reads --only, --k1, --b and --depth', () => {
    const options = parseSweepArgs([
      '--only',
      'nfcorpus, scifact',
      '--k1',
      '0.9,1.4',
      '--b',
      '0.2',
      '--depth',
      '20',
    ]);

    expect(options.only).toEqual(['nfcorpus', 'scifact']);
    expect(options.k1s).toEqual([0.9, 1.4]);
    expect(options.bs).toEqual([0.2]);
    expect(options.depth).toBe(20);
  });
});

describe('numberCsv', () => {
  it('falls back when the flag is absent or empty', () => {
    expect(numberCsv(undefined, [1.2])).toEqual([1.2]);
    expect(numberCsv(' , ', [1.2])).toEqual([1.2]);
  });

  it('refuses a non-numeric part rather than yielding NaN', () => {
    // A NaN k1 scores every document 0, which reads as a real, catastrophic result.
    expect(() => numberCsv('0.8,high', [1.2])).toThrow(/not a number/);
  });
});

describe('selectDatasets', () => {
  const entry = (id: string): DatasetEntry => ({
    id,
    domain: 'test',
    docShape: 'short',
    enabled: true,
    format: 'beir-local',
    source: `./${id}`,
    qrels: 'test',
  });

  const entries: readonly DatasetEntry[] = [entry('nfcorpus'), entry('scifact'), entry('bright')];

  it('runs in the REQUESTED order, not the manifest order', () => {
    // The order a caller states is which cells get measured before a long run
    // is stopped, so the manifest must not silently reorder it.
    expect(selectDatasets(['bright', 'nfcorpus'], entries).map(e => e.id)).toEqual([
      'bright',
      'nfcorpus',
    ]);
  });

  it('drops an id that is unknown or disabled', () => {
    expect(selectDatasets(['scifact', 'nope'], entries).map(e => e.id)).toEqual(['scifact']);
  });
});

describe('buildGrid', () => {
  it('produces the cartesian product plus the shipped baseline cell', () => {
    const grid = buildGrid([1.2, 1.0, 0.8], [0.6, 0.5, 0.4, 0.3]);

    expect(grid).toHaveLength(DEFAULT_CELLS + BASELINE_CELLS);
    expect(grid.filter(point => point.baseline)).toEqual([{ k1: 1.2, b: 0.75, baseline: true }]);
    expect(grid.slice(0, 4).map(point => point.b)).toEqual([0.6, 0.5, 0.4, 0.3]);
    expect(grid.slice(0, 4).every(point => point.k1 === 1.2)).toBe(true);
  });

  it('measures the baseline once when the grid already contains it', () => {
    const grid = buildGrid([1.2], [0.75, 0.5]);

    expect(grid).toHaveLength(2);
    expect(grid.filter(point => point.baseline)).toHaveLength(1);
  });
});
