import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrightDataset } from '../manifest.js';
import {
  buildBrightFiles,
  ensureBrightDataset,
  fetchAllRows,
  readExcluded,
  surrogateId,
  titleOf
} from './bright.js';

const RAW_DOC_ID = 'insects_attracted_to_light/Proximate_and_ultimate_causation.txt';
const SAFE_DOC_ID = 'insects_attracted_to_light_Proximate_and_ultimate_causation_txt';

// The filename rule corpus.ts enforces; the surrogate exists to satisfy it.
const FILENAME_SAFE = /^[A-Za-z0-9._-]{1,200}$/;

const docRows = [
  { id: RAW_DOC_ID, content: 'Moths steer by the moon.' },
  { id: 'other_topic/Phototaxis.txt', content: 'Phototaxis is movement toward light.' },
];

const exampleRows = [
  {
    id: '0',
    query: 'why are insects attracted to light',
    gold_ids_long: [RAW_DOC_ID],
    excluded_ids: ['other_topic/Phototaxis.txt'],
  },
  { id: '1', query: 'a query with no exclusions', gold_ids_long: [], excluded_ids: ['N/A'] },
];

const entry: BrightDataset = {
  id: 'bright-biology',
  format: 'bright',
  split: 'biology',
  domain: 'biology',
  docShape: 'long-web-page',
  atomMaxChars: 4000,
  enabled: true,
};

const tempDataDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-bright-'));

const page = (rows: readonly object[], total: number): object => ({
  rows: rows.map(row => ({ row })),
  num_rows_total: total,
});

const jsonResponse = (body: object): object => ({ ok: true, status: 200, json: async () => body });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('surrogateId', () => {
  it('maps a BRIGHT path id to a filename-safe id corpus.ts accepts', () => {
    expect(surrogateId(RAW_DOC_ID)).toBe(SAFE_DOC_ID);
    expect(FILENAME_SAFE.test(surrogateId(RAW_DOC_ID))).toBe(true);
  });

  it('is deterministic, so corpus, qrels and exclusions agree without a lookup', () => {
    expect(surrogateId(RAW_DOC_ID)).toBe(surrogateId(RAW_DOC_ID));
  });
});

describe('titleOf', () => {
  it('is the id final segment without the .txt suffix', () => {
    expect(titleOf(RAW_DOC_ID)).toBe('Proximate_and_ultimate_causation');
  });
});

describe('buildBrightFiles', () => {
  it('writes SURROGATE ids into the corpus and keeps the raw id in the id map', () => {
    const files = buildBrightFiles(docRows, exampleRows);

    expect(JSON.parse(files.corpus.split('\n')[0] ?? '{}')).toEqual({
      _id: SAFE_DOC_ID,
      title: 'Proximate_and_ultimate_causation',
      text: 'Moths steer by the moon.',
    });
    expect(files.idMap[SAFE_DOC_ID]).toBe(RAW_DOC_ID);
  });

  it('derives qrels from gold_ids_long at grade 1, under the BEIR header', () => {
    const lines = buildBrightFiles(docRows, exampleRows).qrels.trim().split('\n');

    expect(lines[0]).toBe('query-id\tcorpus-id\tscore');
    expect(lines.slice(1)).toEqual([`0\t${SAFE_DOC_ID}\t1`]);
  });

  it('carries excluded_ids as surrogates and drops the "N/A" sentinel', () => {
    const files = buildBrightFiles(docRows, exampleRows);

    expect(files.excluded['0']).toEqual(['other_topic_Phototaxis_txt']);
    expect(files.excluded['1']).toEqual([]);
  });

  it('writes one queries.jsonl row per example, keyed by the example id', () => {
    const first = buildBrightFiles(docRows, exampleRows).queries.split('\n')[0] ?? '{}';

    expect(JSON.parse(first)).toEqual({ _id: '0', text: 'why are insects attracted to light' });
  });
});

describe('fetchAllRows', () => {
  it('pages with length=100 until num_rows_total is reached', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse(
          urls.length === 1 ? page([{ id: 'a' }], 2) : page([{ id: 'b' }], 2)
        );
      })
    );

    const rows = await fetchAllRows('long_documents', 'biology');

    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(urls[0]).toContain('offset=0&length=100');
    expect(urls[1]).toContain('offset=1&length=100');
  });

  it('fails naming the URL when the rows API is not 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));

    await expect(fetchAllRows('examples', 'biology')).rejects.toThrow(/HTTP 503/);
  });
});

describe('ensureBrightDataset', () => {
  it('materialises the split into BEIR layout plus the traceability files', async () => {
    const dataDir = tempDataDir();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        jsonResponse(
          url.includes('config=long_documents')
            ? page(docRows, docRows.length)
            : page(exampleRows, exampleRows.length)
        )
      )
    );

    const dir = await ensureBrightDataset(entry, dataDir);

    expect(dir).toBe(resolve(dataDir, entry.id));
    expect(readFileSync(resolve(dir, 'corpus.jsonl'), 'utf8')).toContain(SAFE_DOC_ID);
    expect(readFileSync(resolve(dir, 'qrels', 'test.tsv'), 'utf8')).toContain(`0\t${SAFE_DOC_ID}\t1`);
    expect(JSON.parse(readFileSync(resolve(dir, 'id-map.json'), 'utf8'))[SAFE_DOC_ID]).toBe(
      RAW_DOC_ID
    );
    expect(readExcluded(dir).get('0')).toEqual(['other_topic_Phototaxis_txt']);
  });

  it('is IDEMPOTENT: an existing corpus.jsonl requests nothing', async () => {
    const dataDir = tempDataDir();
    mkdirSync(resolve(dataDir, entry.id), { recursive: true });
    writeFileSync(resolve(dataDir, entry.id, 'corpus.jsonl'), '{"_id":"a"}\n', 'utf8');
    const fetchSpy = vi.fn(async () => jsonResponse(page([], 0)));
    vi.stubGlobal('fetch', fetchSpy);

    await ensureBrightDataset(entry, dataDir);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('readExcluded', () => {
  it('is empty for a dataset with no excluded.json', () => {
    expect(readExcluded(tempDataDir()).size).toBe(0);
  });
});
