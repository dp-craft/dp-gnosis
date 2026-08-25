import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureBeirDataset } from '../../src/fetch/beirZip.js';
import type { BeirDataset } from '../../src/manifest.js';

// `unzip` is a real subprocess; the fake stands in for it and materialises the
// tree the archive would have contained, so the fetcher's post-unzip contract
// (a corpus.jsonl at data/<id>/) is what the test actually exercises.
const unzipCalls: string[][] = [];
let unzipProducesCorpus = true;

vi.mock('node:child_process', () => {
  const execFile = (
    _bin: string,
    args: string[],
    done: (error: Error | null) => void
  ): void => {
    unzipCalls.push(args);
    const targetDir = args[args.indexOf('-d') + 1] ?? '';
    const zipName = (args[args.length - 3] ?? '').split('/').at(-1) ?? '';
    const dir = resolve(targetDir, zipName.replace('.zip', ''));
    mkdirSync(dir, { recursive: true });
    if (unzipProducesCorpus) writeFileSync(resolve(dir, 'corpus.jsonl'), '{"_id":"a"}\n', 'utf8');
    done(null);
  };
  return { default: { execFile }, execFile };
});

const entry: BeirDataset = {
  id: 'nfcorpus',
  format: 'beir-zip',
  source: 'https://example.invalid/nfcorpus.zip',
  qrels: 'test',
  domain: 'biomedical',
  docShape: 'short-abstract',
  enabled: true,
  layers: [],
};

const tempDataDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-zip-'));

const okFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }));

afterEach(() => {
  unzipCalls.length = 0;
  unzipProducesCorpus = true;
  vi.unstubAllGlobals();
});

describe('ensureBeirDataset', () => {
  it('downloads, unzips into the data dir and returns data/<id>', async () => {
    const dataDir = tempDataDir();
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const dir = await ensureBeirDataset(entry, dataDir);

    expect(dir).toBe(resolve(dataDir, 'nfcorpus'));
    expect(fetchSpy).toHaveBeenCalledWith(entry.source);
    expect(unzipCalls).toHaveLength(1);
    expect(unzipCalls[0]).toContain(resolve(dataDir, 'nfcorpus.zip'));
    expect(unzipCalls[0]?.slice(-2)).toEqual(['-d', dataDir]);
  });

  it('is IDEMPOTENT: an existing corpus.jsonl re-downloads nothing', async () => {
    const dataDir = tempDataDir();
    mkdirSync(resolve(dataDir, 'nfcorpus'), { recursive: true });
    writeFileSync(resolve(dataDir, 'nfcorpus', 'corpus.jsonl'), '{"_id":"a"}\n', 'utf8');
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const dir = await ensureBeirDataset(entry, dataDir);

    expect(dir).toBe(resolve(dataDir, 'nfcorpus'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(unzipCalls).toHaveLength(0);
  });

  it('fails naming the URL when the download is not 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));

    await expect(ensureBeirDataset(entry, tempDataDir())).rejects.toThrow(/HTTP 404/);
  });

  it('fails when the archive produced no corpus.jsonl, naming the BEIR layout', async () => {
    unzipProducesCorpus = false;
    vi.stubGlobal('fetch', okFetch());

    await expect(ensureBeirDataset(entry, tempDataDir())).rejects.toThrow(/corpus\.jsonl/);
  });
});
