import { describe, expect, it, vi } from 'vitest';

import { ATOM_MAX_CHARS, RERANK_K_INIT } from '../../dp-gnosis/src/config.js';
import { type DatasetEntry, loadManifest } from './manifest.js';
import {
  BENCH_DEFAULT_ADAPTER,
  effectiveAtomMaxChars,
  firstPassDepth,
  main,
  MANIFEST_PATH,
  parseArgs,
  percentileMs,
  selectDatasets,
  selectionError
} from './run.js';

describe('parseArgs', () => {
  it('defaults to every enabled dataset at depth 100 with no rerank', () => {
    expect(parseArgs([])).toEqual({
      only: [],
      depth: 100,
      rerank: false,
      compare: false,
      adapter: BENCH_DEFAULT_ADAPTER,
    });
  });

  it('reads --only as a csv list and the remaining flags as switches', () => {
    expect(parseArgs(['--only', 'scifact, nfcorpus', '--depth', '20', '--rerank', '--compare']))
      .toEqual({
        only: ['scifact', 'nfcorpus'],
        depth: 20,
        rerank: true,
        compare: true,
        adapter: BENCH_DEFAULT_ADAPTER,
      });
  });

  it('reads --adapter as the registered adapter to measure', () => {
    expect(parseArgs(['--adapter', 'linear']).adapter).toBe('linear');
    expect(parseArgs(['--adapter', 'minisearch']).adapter).toBe('minisearch');
  });

  it('FAILS LOUDLY on an unknown adapter rather than falling back', () => {
    expect(() => parseArgs(['--adapter', 'faiss'])).toThrow(/faiss/);
    expect(() => parseArgs(['--adapter', 'faiss'])).toThrow(/fts5/);
  });
});

describe('percentileMs', () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('takes the nearest rank over the ascending samples', () => {
    expect(percentileMs(samples, 0.5)).toBe(50);
    expect(percentileMs(samples, 0.95)).toBe(100);
  });

  it('sorts before ranking, so arrival order cannot change the answer', () => {
    expect(percentileMs([90, 10, 50], 0.5)).toBe(50);
  });

  it('is 0 when no query was timed', () => {
    expect(percentileMs([], 0.95)).toBe(0);
  });
});

describe('effectiveAtomMaxChars', () => {
  const entry = (atomMaxChars?: number): DatasetEntry => ({
    id: 'scifact',
    format: 'beir-local',
    source: './data/scifact',
    qrels: 'test',
    domain: 'scientific-claims',
    docShape: 'abstract',
    atomMaxChars,
    enabled: true,
  });

  it('resolves the ENGINE default when the manifest is silent, never null', () => {
    // Recording null would make two runs straddling a change to the engine
    // default look like one scale, and compare.ts would subtract across them.
    expect(effectiveAtomMaxChars(entry())).toBe(ATOM_MAX_CHARS);
  });

  it('uses the manifest value when the entry sets one', () => {
    expect(effectiveAtomMaxChars(entry(1234))).toBe(1234);
  });
});

describe('firstPassDepth', () => {
  it('widens the first pass to the engine RERANK_K_INIT when reranking below it', () => {
    expect(firstPassDepth(5, true)).toBe(RERANK_K_INIT);
  });

  it('leaves a depth above RERANK_K_INIT alone, reranking and BM25 alike', () => {
    expect(firstPassDepth(100, true)).toBe(100);
    expect(firstPassDepth(5, false)).toBe(5);
  });
});

describe('selectDatasets', () => {
  const manifest = loadManifest(MANIFEST_PATH);

  it('selects exactly the enabled entries when --only is silent', () => {
    const selection = selectDatasets(manifest, []);
    expect(selection.entries.map(entry => entry.id)).toEqual(
      manifest.filter(entry => entry.enabled).map(entry => entry.id)
    );
    expect(selection.unknown).toEqual([]);
  });

  it('honours an --only id that names a disabled entry', () => {
    const selection = selectDatasets(manifest, ['vault-hu-rephrased']);
    expect(selection.entries.map(entry => entry.id)).toEqual(['vault-hu-rephrased']);
    expect(selection.entries[0]?.enabled).toBe(false);
    expect(selection.unknown).toEqual([]);
  });

  it('reports an --only id that matches no manifest entry', () => {
    const selection = selectDatasets(manifest, ['vault', 'vault-typo']);
    expect(selection.entries.map(entry => entry.id)).toEqual(['vault']);
    expect(selection.unknown).toEqual(['vault-typo']);
  });
});

describe('selectionError', () => {
  it('names every unmatched id', () => {
    const message = selectionError({ entries: [], unknown: ['nope', 'also-nope'] });
    expect(message).toContain('nope');
    expect(message).toContain('also-nope');
  });

  it('refuses an empty selection', () => {
    expect(selectionError({ entries: [], unknown: [] })).toMatch(/no dataset/i);
  });

  it('passes a non-empty fully matched selection', () => {
    const selection = selectDatasets(loadManifest(MANIFEST_PATH), ['vault-hu-rephrased']);
    expect(selectionError(selection)).toBeUndefined();
  });
});

describe('main dataset selection', () => {
  it('exits non-zero and names the unknown id on stderr, measuring nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await main(['--only', 'vault-hu-typo'], 'sha');
    const written = stderr.mock.calls.map(call => String(call[0])).join('');
    stderr.mockRestore();
    stdout.mockRestore();
    expect(code).not.toBe(0);
    expect(written).toContain('vault-hu-typo');
  });
});
