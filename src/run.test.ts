import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ATOM_MAX_CHARS,
  DEFAULT_RERANK_PRESET,
  RERANK_FUSION_PRESETS,
  RERANK_K_INIT,
  RERANK_RRF_K
} from '../../dp-gnosis/src/config.js';
import { type DatasetEntry, loadManifest } from './manifest.js';
import {
  type DatasetResult,
  HISTORY_FILE,
  readHistory,
  recordDataset,
  type RunProvenance
} from './report.js';
import {
  BENCH_DEFAULT_ADAPTER,
  effectiveAtomMaxChars,
  firstPassDepth,
  main,
  MANIFEST_PATH,
  measureAndRecordAll,
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
      rerankProfile: DEFAULT_RERANK_PRESET,
      rerankWeight: undefined,
      rerankFusion: RERANK_FUSION_PRESETS[DEFAULT_RERANK_PRESET],
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
        rerankProfile: DEFAULT_RERANK_PRESET,
        rerankWeight: undefined,
        rerankFusion: RERANK_FUSION_PRESETS[DEFAULT_RERANK_PRESET],
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

  it('reads --rerank-profile as a NAME the engine resolves into its fusion rule', () => {
    const options = parseArgs(['--rerank', '--rerank-profile', 'beir-ce']);
    expect(options.rerankProfile).toBe('beir-ce');
    expect(options.rerankFusion).toEqual({ kind: 'replace' });
  });

  it('FAILS LOUDLY on an unknown rerank profile, naming it and the known ones', () => {
    expect(() => parseArgs(['--rerank-profile', 'monot5'])).toThrow(/monot5/);
    expect(() => parseArgs(['--rerank-profile', 'monot5'])).toThrow(/shipped/);
    expect(() => parseArgs(['--rerank-profile', 'monot5'])).toThrow(/beir-ce/);
  });

  it('applies --rerank-weight as a raw override on the named preset', () => {
    const options = parseArgs(['--rerank', '--rerank-weight', '0.8']);
    expect(options.rerankWeight).toBe(0.8);
    expect(options.rerankFusion).toEqual({ kind: 'rrf', rrfK: RERANK_RRF_K, rerankWeight: 0.8 });
  });

  it('FAILS LOUDLY on a non-numeric --rerank-weight rather than measuring NaN', () => {
    expect(() => parseArgs(['--rerank-weight', 'half'])).toThrow(/half/);
  });

  it('FAILS LOUDLY when a weight is overridden on a preset that has no weight term', () => {
    expect(() => parseArgs(['--rerank-profile', 'beir-ce', '--rerank-weight', '0.8'])).toThrow(
      /beir-ce/
    );
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

const FLAT_METRICS = {
  ndcg10: 0.5,
  recall10: 0.5,
  recall20: 0.5,
  recall100: 0.5,
  recall300: undefined,
  recall1000: undefined,
  mrr10: 0.5,
};

const resultFor = (dataset: string): DatasetResult => ({
  dataset,
  domain: 'test-domain',
  docShape: 'abstract',
  corpusBytes: 10,
  corpusLines: 2,
  atomMaxChars: 4000,
  topics: 1,
  docCount: 2,
  atomCount: 2,
  ingestMs: 1,
  queryMs: 1,
  queryP50Ms: 1,
  queryP95Ms: 1,
  metrics: FLAT_METRICS,
  metricsSd: FLAT_METRICS,
  perTopic: [{ queryId: 'q1', metrics: FLAT_METRICS }],
  rankings: new Map([['q1', ['doc-a']]]),
});

const testProvenance: RunProvenance = {
  ts: '2026-08-15T10:00:00.000Z',
  gitSha: 'sha1234',
  adapter: 'fts5',
  depth: 100,
  rerank: false,
};

/**
 * The 2026-08-15 failure: a 67.5-minute run completed six datasets, died of an
 * OOM on the seventh, and wrote ZERO history rows because every artefact was
 * buffered to the end. The property that has to hold is per-dataset, not
 * per-run: when dataset N fails, 1…N−1 are already on disk.
 */
describe('measureAndRecordAll', () => {
  it('has already recorded datasets 1…N−1 when dataset N throws', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-run-'));
    const entries = loadManifest(MANIFEST_PATH).slice(0, 3);
    const failing = entries[2]?.id ?? '';
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const results = await measureAndRecordAll(entries, {
      measure: async entry => {
        if (entry.id === failing) throw new Error('Reached heap limit Allocation failed');
        return resultFor(entry.id);
      },
      record: result => {
        recordDataset({ resultsDir: dir, provenance: testProvenance, result });
      },
    });
    stdout.mockRestore();
    stderr.mockRestore();
    const rows = readHistory(resolve(dir, HISTORY_FILE));
    expect(rows.map(row => row.dataset)).toEqual([entries[0]?.id, entries[1]?.id]);
    expect(results.map(result => result.dataset)).toEqual([entries[0]?.id, entries[1]?.id]);
    expect(rows.every(row => existsSync(resolve(dir, row.perTopicPath ?? '')))).toBe(true);
    expect(rows.every(row => existsSync(resolve(dir, row.runPath ?? '')))).toBe(true);
  });
});
