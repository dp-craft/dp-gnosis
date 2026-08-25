import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The parquet DECODE is hyparquet's job, not this module's. The fake decodes
// the file's own bytes as JSON, so what the test still exercises is the part
// that is ours: the AsyncBuffer must expose the shard file's exact bytes.
vi.mock('hyparquet', () => ({
  parquetReadObjects: async ({ file }: { file: AsyncBufferLike }): Promise<unknown> =>
    JSON.parse(Buffer.from(await file.slice(0, file.byteLength)).toString('utf8')),
}));

interface AsyncBufferLike {
  byteLength: number;
  slice: (start: number, end?: number) => ArrayBuffer | Promise<ArrayBuffer>;
}

import type { BrightDataset } from '../../src/manifest.js';
import {
  brightDataDir,
  buildBrightFiles,
  ensureBrightDataset,
  fetchAllRows,
  readExcluded,
  surrogateId,
  titleOf
} from '../../src/fetch/bright.js';

const RAW_DOC_ID = 'insects_attracted_to_light/Proximate_and_ultimate_causation.txt';
const SAFE_DOC_ID = 'insects_attracted_to_light_Proximate_and_ultimate_causation_txt';
const RAW_PASSAGE_ID = 'insects_attracted_to_light/Proximate_and_ultimate_causation.txt_3';
const SAFE_PASSAGE_ID = 'insects_attracted_to_light_Proximate_and_ultimate_causation_txt_3';

// The filename rule corpus.ts enforces; the surrogate exists to satisfy it.
const FILENAME_SAFE = /^[A-Za-z0-9._-]{1,200}$/;

// A REAL over-length id from the sustainable_living split: BRIGHT ids are URLs,
// and this one sanitises to 261 chars, which corpus.ts:fileNameFor rejects.
const RAW_LONG_ID =
  'recycle_cloth/take-back-bag?trashie&nbtnb3Aadwords3Ax3A21096404286' +
  '3A3Anbadtypenbkwdnbtinbminbpcnbpinbppinbplacementnblims9031945nblp' +
  'ms9031945nbfiinbapnbmtgadsource1gclidCj0KCQjwmvBhDwARIsAAQ0Q7s6y2x' +
  'coPFgYYWUcAAAYedbgg8fq7XanUDPPWgNlwe7GRayWFolaQaAu8kEALwwcB.txt';

// Same tracking-parameter family: identical for far more than 200 chars, so
// truncation ALONE would merge the two documents into one corpus entry.
const RAW_LONG_ID_SIBLING = `${RAW_LONG_ID.slice(0, 230)}_a_different_tail.txt`;

const passageRows = [
  { id: RAW_PASSAGE_ID, content: 'Moths steer by the moon.' },
];

const docRows = [
  { id: RAW_DOC_ID, content: 'Moths steer by the moon.' },
  { id: 'other_topic/Phototaxis.txt', content: 'Phototaxis is movement toward light.' },
];

// The SAME query at two granularities: gold_ids_long names the page,
// gold_ids names the passage inside it. They differ here so a fetcher reading
// the wrong field cannot pass.
const exampleRows = [
  {
    id: '0',
    query: 'why are insects attracted to light',
    gold_ids_long: [RAW_DOC_ID],
    gold_ids: [RAW_PASSAGE_ID],
    excluded_ids: ['other_topic/Phototaxis.txt'],
  },
  {
    id: '1',
    query: 'a query with no exclusions',
    gold_ids_long: [],
    gold_ids: [],
    excluded_ids: ['N/A'],
  },
];

const entry: BrightDataset = {
  id: 'bright-biology',
  format: 'bright',
  split: 'biology',
  granularity: 'long',
  domain: 'biology',
  docShape: 'long-web-page',
  atomMaxChars: 4000,
  enabled: true,
  layers: [],
};

const passageEntry: BrightDataset = {
  ...entry,
  id: 'bright-biology-passages',
  granularity: 'passage',
  docShape: 'gold-passage',
};

const tempDataDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-bright-'));

const INDEX_URL = 'https://datasets-server.huggingface.co/parquet?dataset=xlangai%2FBRIGHT';

const tempCacheDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-parquet-'));

// One parquet shard as the datasets-server index describes it, with the rows it
// would decode to. The bytes ARE the rows (see the hyparquet mock above).
interface ShardFixture {
  config: string;
  split: string;
  filename: string;
  rows: readonly object[];
}

const shardUrl = (shard: ShardFixture): string =>
  `https://hub.invalid/${shard.config}/${shard.split}/${shard.filename}`;

const shardBytes = (shard: ShardFixture): Buffer => Buffer.from(JSON.stringify(shard.rows), 'utf8');

const indexEntry = (shard: ShardFixture): object => ({
  config: shard.config,
  split: shard.split,
  filename: shard.filename,
  url: shardUrl(shard),
  size: shardBytes(shard).length,
});

const jsonResponse = (body: object): object => ({ ok: true, status: 200, json: async () => body });

const bytesResponse = (shard: ShardFixture): object => {
  const bytes = shardBytes(shard);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
};

// The whole Hub surface this module touches: the /parquet index, then the shard
// files it names. Anything else is a 404, so a hardcoded URL cannot pass.
const hubFetch = (shards: readonly ShardFixture[]): ReturnType<typeof vi.fn> =>
  vi.fn(async (url: string) => {
    if (url === INDEX_URL) return jsonResponse({ parquet_files: shards.map(indexEntry) });
    const shard = shards.find(candidate => shardUrl(candidate) === url);
    return shard === undefined ? { ok: false, status: 404 } : bytesResponse(shard);
  });

const docShard: ShardFixture = {
  config: 'long_documents',
  split: 'biology',
  filename: '0000.parquet',
  rows: docRows,
};

const passageShard: ShardFixture = {
  config: 'documents',
  split: 'biology',
  filename: '0000.parquet',
  rows: passageRows,
};

const exampleShard: ShardFixture = {
  config: 'examples',
  split: 'biology',
  filename: '0000.parquet',
  rows: exampleRows,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('surrogateId', () => {
  it('maps a BRIGHT path id to a filename-safe id corpus.ts accepts', () => {
    expect(surrogateId(RAW_DOC_ID)).toBe(SAFE_DOC_ID);
    expect(FILENAME_SAFE.test(surrogateId(RAW_DOC_ID))).toBe(true);
  });

  it('is deterministic, so corpus, qrels and exclusions agree without a lookup', () => {
    expect(surrogateId(RAW_DOC_ID)).toBe(surrogateId(RAW_DOC_ID));
  });

  it('bounds an over-length URL id to the 200-char cap corpus.ts enforces', () => {
    expect(RAW_LONG_ID.replace(/[^A-Za-z0-9_-]/g, '_').length).toBeGreaterThan(200);
    expect(FILENAME_SAFE.test(surrogateId(RAW_LONG_ID))).toBe(true);
  });

  it('is deterministic for an over-length id, so qrels still match after a re-fetch', () => {
    expect(surrogateId(RAW_LONG_ID)).toBe(surrogateId(RAW_LONG_ID));
  });

  it('keeps two over-length ids sharing a 200-char prefix DISTINCT', () => {
    expect(surrogateId(RAW_LONG_ID_SIBLING)).not.toBe(surrogateId(RAW_LONG_ID));
    expect(FILENAME_SAFE.test(surrogateId(RAW_LONG_ID_SIBLING))).toBe(true);
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

describe('buildBrightFiles with an over-length id', () => {
  const longDocRows = [
    { id: RAW_LONG_ID, content: 'Textile take-back programmes.' },
    { id: RAW_LONG_ID_SIBLING, content: 'A different landing page.' },
  ];
  const longExampleRows = [
    {
      id: '0',
      query: 'where can I recycle clothing',
      gold_ids_long: [RAW_LONG_ID],
      excluded_ids: [RAW_LONG_ID_SIBLING],
    },
  ];

  it('uses ONE surrogate across corpus, qrels, excluded and the id map', () => {
    const files = buildBrightFiles(longDocRows, longExampleRows);
    const safe = surrogateId(RAW_LONG_ID);

    expect(JSON.parse(files.corpus.split('\n')[0] ?? '{}')._id).toBe(safe);
    expect(files.qrels.trim().split('\n').slice(1)).toEqual([`0\t${safe}\t1`]);
    expect(files.excluded['0']).toEqual([surrogateId(RAW_LONG_ID_SIBLING)]);
    expect(files.idMap[safe]).toBe(RAW_LONG_ID);
  });

  it('gives the prefix-sharing sibling its own corpus entry, never merging them', () => {
    const files = buildBrightFiles(longDocRows, longExampleRows);

    expect(Object.keys(files.idMap)).toHaveLength(2);
    expect(files.idMap[surrogateId(RAW_LONG_ID_SIBLING)]).toBe(RAW_LONG_ID_SIBLING);
  });
});

describe('buildBrightFiles at passage granularity', () => {
  it('derives qrels from gold_ids, NOT gold_ids_long', () => {
    const lines = buildBrightFiles(passageRows, exampleRows, 'passage').qrels.trim().split('\n');

    expect(lines.slice(1)).toEqual([`0\t${SAFE_PASSAGE_ID}\t1`]);
    expect(lines.slice(1)).not.toContain(`0\t${SAFE_DOC_ID}\t1`);
  });

  it('keeps queries, exclusions and the surrogate mapping identical to the long variant', () => {
    const files = buildBrightFiles(passageRows, exampleRows, 'passage');

    expect(files.queries).toBe(buildBrightFiles(docRows, exampleRows).queries);
    expect(files.excluded['0']).toEqual(['other_topic_Phototaxis_txt']);
    expect(files.idMap[SAFE_PASSAGE_ID]).toBe(RAW_PASSAGE_ID);
  });
});

describe('brightDataDir', () => {
  it('gives the long and passage variants DISTINCT dirs, so neither overwrites the other', () => {
    expect(brightDataDir(passageEntry, '/data')).not.toBe(brightDataDir(entry, '/data'));
    expect(brightDataDir(passageEntry, '/data')).toBe(resolve('/data', passageEntry.id));
  });
});

describe('fetchAllRows', () => {
  it('downloads the shard the index names and caches it under <cache>/<config>/<split>', async () => {
    const cacheDir = tempCacheDir();
    const fetchSpy = hubFetch([docShard, exampleShard]);
    vi.stubGlobal('fetch', fetchSpy);

    const rows = await fetchAllRows('long_documents', 'biology', cacheDir);

    expect(rows).toEqual(docRows);
    expect(
      existsSync(resolve(cacheDir, 'long_documents', 'biology', '0000.parquet'))
    ).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(shardUrl(docShard));
    expect(fetchSpy).not.toHaveBeenCalledWith(shardUrl(exampleShard));
  });

  it('reads EVERY shard the index lists, in order — the filename is never assumed', async () => {
    const cacheDir = tempCacheDir();
    const first = { ...docShard, filename: '0000.parquet', rows: [{ id: 'a' }] };
    const second = { ...docShard, filename: '0001.parquet', rows: [{ id: 'b' }] };
    vi.stubGlobal('fetch', hubFetch([first, second]));

    const rows = await fetchAllRows('long_documents', 'biology', cacheDir);

    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(existsSync(resolve(cacheDir, 'long_documents', 'biology', '0001.parquet'))).toBe(true);
  });

  it('is IDEMPOTENT: a cached shard at the published size is not re-downloaded', async () => {
    const cacheDir = tempCacheDir();
    mkdirSync(resolve(cacheDir, 'long_documents', 'biology'), { recursive: true });
    writeFileSync(
      resolve(cacheDir, 'long_documents', 'biology', '0000.parquet'),
      shardBytes(docShard)
    );
    const fetchSpy = hubFetch([docShard]);
    vi.stubGlobal('fetch', fetchSpy);

    const rows = await fetchAllRows('long_documents', 'biology', cacheDir);

    expect(rows).toEqual(docRows);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(INDEX_URL);
  });

  it('re-downloads a cached shard whose byte size does not match the index', async () => {
    const cacheDir = tempCacheDir();
    mkdirSync(resolve(cacheDir, 'long_documents', 'biology'), { recursive: true });
    const path = resolve(cacheDir, 'long_documents', 'biology', '0000.parquet');
    writeFileSync(path, Buffer.from('[]', 'utf8'));
    const fetchSpy = hubFetch([docShard]);
    vi.stubGlobal('fetch', fetchSpy);

    const rows = await fetchAllRows('long_documents', 'biology', cacheDir);

    expect(rows).toEqual(docRows);
    expect(fetchSpy).toHaveBeenCalledWith(shardUrl(docShard));
  });

  it('fails naming the index URL when the shard index is not 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));

    await expect(fetchAllRows('examples', 'biology', tempCacheDir())).rejects.toThrow(/HTTP 503/);
  });

  it('fails naming the config and split when the index lists no matching shard', async () => {
    vi.stubGlobal('fetch', hubFetch([exampleShard]));

    await expect(fetchAllRows('long_documents', 'chemistry', tempCacheDir())).rejects.toThrow(
      /config "long_documents" split "chemistry"/
    );
  });

  it('fails naming the shard URL when the download is not 200', async () => {
    const missing = { ...docShard, filename: 'absent.parquet' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === INDEX_URL
          ? jsonResponse({ parquet_files: [indexEntry(missing)] })
          : { ok: false, status: 404 }
      )
    );

    await expect(fetchAllRows('long_documents', 'biology', tempCacheDir())).rejects.toThrow(
      /HTTP 404/
    );
  });
});

describe('ensureBrightDataset', () => {
  it('materialises the split into BEIR layout plus the traceability files', async () => {
    const dataDir = tempDataDir();
    vi.stubGlobal('fetch', hubFetch([docShard, exampleShard]));

    const dir = await ensureBrightDataset(entry, dataDir);

    expect(dir).toBe(resolve(dataDir, entry.id));
    expect(readFileSync(resolve(dir, 'corpus.jsonl'), 'utf8')).toContain(SAFE_DOC_ID);
    expect(readFileSync(resolve(dir, 'qrels', 'test.tsv'), 'utf8')).toContain(`0\t${SAFE_DOC_ID}\t1`);
    expect(JSON.parse(readFileSync(resolve(dir, 'id-map.json'), 'utf8'))[SAFE_DOC_ID]).toBe(
      RAW_DOC_ID
    );
    expect(readExcluded(dir).get('0')).toEqual(['other_topic_Phototaxis_txt']);
  });

  it('reads the "documents" config and gold_ids for a passage entry', async () => {
    const dataDir = tempDataDir();
    const fetchSpy = hubFetch([docShard, passageShard, exampleShard]);
    vi.stubGlobal('fetch', fetchSpy);

    const dir = await ensureBrightDataset(passageEntry, dataDir);

    expect(dir).toBe(resolve(dataDir, 'bright-biology-passages'));
    expect(fetchSpy).toHaveBeenCalledWith(shardUrl(passageShard));
    expect(fetchSpy).not.toHaveBeenCalledWith(shardUrl(docShard));
    expect(readFileSync(resolve(dir, 'qrels', 'test.tsv'), 'utf8')).toContain(
      `0\t${SAFE_PASSAGE_ID}\t1`
    );
  });

  it('is IDEMPOTENT: an existing corpus.jsonl requests nothing', async () => {
    const dataDir = tempDataDir();
    mkdirSync(resolve(dataDir, entry.id), { recursive: true });
    writeFileSync(resolve(dataDir, entry.id, 'corpus.jsonl'), '{"_id":"a"}\n', 'utf8');
    const fetchSpy = hubFetch([docShard, exampleShard]);
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
