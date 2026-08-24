/**
 * `bright` — one BRIGHT split, converted into the BEIR layout on disk.
 *
 * BRIGHT ships as parquet on the Hub, and that is how it is read here. The
 * datasets-server ROWS API serves the same rows as JSON, but 100 at a time: the
 * `documents` config is 574 pages for one split and answers HTTP 429 long
 * before the end, so paging it is not a fetch that finishes. One parquet shard
 * per split makes it one download. The shard list comes from the datasets-server
 * `/parquet` index rather than a hardcoded `0000.parquet`, so a config that is
 * ever sharded still reads whole. Shards are cached under
 * `<dataDir>/_parquet/<config>/<split>/`, and a cached file whose byte size
 * matches the index is not requested again.
 *
 * Two configs are read per split — the corpus config (`id`, `content`) becomes
 * the corpus, `examples` (`id`, `query`, the gold-id list, `excluded_ids`)
 * becomes the queries, the qrels and the exclusions. The parquet decode hands
 * back the SAME shapes the rows API did — those fields are all `string` or
 * `string[]`, with no integer column in any of the three configs read here
 * (verified by decoding `long_documents/pony` and `examples/pony`, not
 * assumed) — so nothing is normalised on the way in and `buildBrightFiles` is
 * untouched by the switch.
 *
 * The entry's `granularity` picks WHICH pair: `long` reads `long_documents` +
 * `gold_ids_long` (whole pages), `passage` reads `documents` + `gold_ids` (the
 * gold passages inside those pages, ~387 chars, i.e. one atom each). The
 * queries are the same 103 either way, so the two variants are one benchmark at
 * two document sizes and the score gap between them is the chunker's cost.
 *
 * THE SURROGATE ID IS THE POINT OF THIS FILE. A BRIGHT document id is a path —
 * `insects_attracted_to_light/Proximate_and_ultimate_causation.txt` — and
 * `corpus.ts:fileNameFor` REJECTS it by design, because the corpus filename is
 * how `score.ts` maps a retrieved atom back to a qrels key. Sanitising it there
 * would break that mapping silently, so it is mapped at fetch time, once —
 * through the suite's single `docId.ts:safeDocId` — and the
 * surrogate is what lands in `corpus.jsonl`, in `qrels/test.tsv` and in
 * `excluded.json` alike. The mapping is written to `id-map.json` so any number
 * this suite reports can be traced back to the published ids.
 *
 * Two smaller decisions, both derived from the data rather than invented:
 *
 * - The document TITLE is the id's final segment (`Protein_folding`), which is
 *   the source page's title as BRIGHT itself records it. It is carried because
 *   the BEIR corpus shape has a title field; nothing else is synthesised.
 * - `excluded_ids` carries a literal `"N/A"` sentinel on queries with no
 *   exclusions. It is dropped — recording it as an excluded document id would
 *   put a value in `excluded.json` that names no document.
 *
 * IDEMPOTENT like every fetcher here: a `corpus.jsonl` already on disk means
 * the split is present, and nothing is requested.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type AsyncBuffer, parquetReadObjects } from 'hyparquet';

import { safeDocId } from '../docId.js';
import type { BrightDataset, BrightGranularity } from '../manifest.js';

const CORPUS_FILE = 'corpus.jsonl';
const QUERIES_FILE = 'queries.jsonl';
const QRELS_DIR = 'qrels';

/** `run.ts` scores BRIGHT under the `test` split name, so it is written as one. */
const QRELS_SPLIT = 'test';
const ID_MAP_FILE = 'id-map.json';
const EXCLUDED_FILE = 'excluded.json';

const PARQUET_ENDPOINT = 'https://datasets-server.huggingface.co/parquet';
const DATASET_PARAM = 'xlangai%2FBRIGHT';

/** Where downloaded shards live, relative to the bench data dir. */
const PARQUET_CACHE_DIR = '_parquet';

const LONG_CONFIG = 'long_documents';
const PASSAGE_CONFIG = 'documents';
const EXAMPLES_CONFIG = 'examples';
const LONG_GOLD_FIELD = 'gold_ids_long';
const PASSAGE_GOLD_FIELD = 'gold_ids';

/** BRIGHT judgments are binary — a gold document is relevant, everything else is not. */
const QRELS_GRADE = 1;

/** What `excluded_ids` carries when a query excludes nothing. */
const EXCLUDED_SENTINEL = 'N/A';

const QRELS_HEADER = 'query-id\tcorpus-id\tscore';
const PATH_SEPARATOR = '/';
const TXT_SUFFIX = '.txt';

type Row = Readonly<Record<string, unknown>>;

/** One parquet file of one config/split, as the `/parquet` index describes it. */
interface Shard {
  readonly filename: string;
  readonly url: string;
  /** The published byte size — the cache-hit test, so a truncated file re-downloads. */
  readonly size: number;
}

/** The four BEIR artefacts plus the two traceability files, as file bodies. */
export interface BrightFiles {
  readonly corpus: string;
  readonly queries: string;
  readonly qrels: string;
  /** Surrogate id → the published BRIGHT id it stands for. */
  readonly idMap: Readonly<Record<string, string>>;
  /** Query id → the surrogate ids that query excludes from scoring. */
  readonly excluded: Readonly<Record<string, readonly string[]>>;
}

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const str = (row: Row, key: string): string => {
  const value = row[key];
  return isString(value) ? value : '';
};

const strings = (row: Row, key: string): readonly string[] => {
  const value = row[key];
  return Array.isArray(value) ? value.filter(isString) : [];
};

/**
 * A published BRIGHT id → the filename-safe id this suite uses everywhere. It IS
 * `docId.ts:safeDocId`, not a BRIGHT-local copy: `beir.ts` maps `webis-touche2020`
 * with the same function, and a second, subtly different sanitiser would give the
 * suite two id spaces that disagree and mis-join qrels silently. Named here for
 * the BRIGHT vocabulary (`id-map.json` calls these surrogates).
 */
export const surrogateId = safeDocId;

/** `a/Protein_folding.txt` → `Protein_folding` — the page title BRIGHT records. */
export const titleOf = (rawId: string): string => {
  const segment = rawId.split(PATH_SEPARATOR).at(-1) ?? rawId;
  return segment.endsWith(TXT_SUFFIX) ? segment.slice(0, -TXT_SUFFIX.length) : segment;
};

const corpusLine = (row: Row): string => {
  const rawId = str(row, 'id');
  return JSON.stringify({ _id: surrogateId(rawId), title: titleOf(rawId), text: str(row, 'content') });
};

const queryLine = (row: Row): string =>
  JSON.stringify({ _id: str(row, 'id'), text: str(row, 'query') });

/** The examples field naming the gold ids AT that granularity. */
const goldFieldFor = (granularity: BrightGranularity): string =>
  granularity === 'passage' ? PASSAGE_GOLD_FIELD : LONG_GOLD_FIELD;

/** The rows config holding the documents AT that granularity. */
const corpusConfigFor = (granularity: BrightGranularity): string =>
  granularity === 'passage' ? PASSAGE_CONFIG : LONG_CONFIG;

const qrelLines = (goldField: string) => (row: Row): readonly string[] =>
  strings(row, goldField).map(
    goldId => `${str(row, 'id')}\t${surrogateId(goldId)}\t${QRELS_GRADE}`
  );

const excludedOf = (row: Row): readonly [string, readonly string[]] => [
  str(row, 'id'),
  strings(row, 'excluded_ids')
    .filter(rawId => rawId !== EXCLUDED_SENTINEL)
    .map(surrogateId),
];

const idMapEntry = (row: Row): readonly [string, string] => {
  const rawId = str(row, 'id');
  return [surrogateId(rawId), rawId];
};

/**
 * The BEIR bodies for one split, from the two configs' rows. Pure, so the
 * conversion — surrogate ids, qrels derived from the granularity's gold field,
 * exclusions — is testable without a network stub. Only the gold field changes
 * with `granularity`; queries, exclusions and the id mapping are identical, by
 * design: the two variants MUST differ in nothing but document size.
 */
export const buildBrightFiles = (
  docRows: readonly Row[],
  exampleRows: readonly Row[],
  granularity: BrightGranularity = 'long'
): BrightFiles => ({
  corpus: docRows.map(corpusLine).join('\n').concat('\n'),
  queries: exampleRows.map(queryLine).join('\n').concat('\n'),
  qrels: [QRELS_HEADER, ...exampleRows.flatMap(qrelLines(goldFieldFor(granularity)))]
    .join('\n')
    .concat('\n'),
  idMap: Object.fromEntries(docRows.map(idMapEntry)),
  excluded: Object.fromEntries(exampleRows.map(excludedOf)),
});

const SHARD_LIST_URL = `${PARQUET_ENDPOINT}?dataset=${DATASET_PARAM}`;

const BY_HAND_HINT =
  'fetch the split by hand into data/<id>/ in BEIR layout and switch the entry to "beir-local"';

const indexFailed = (status: number): string =>
  `dp-gnosis-bench: BRIGHT parquet index request failed with HTTP ${status} for ` +
  `${SHARD_LIST_URL} — the datasets-server is occasionally cold; retry, or ${BY_HAND_HINT}`;

const noShards = (config: string, split: string): string =>
  `dp-gnosis-bench: the BRIGHT parquet index lists no shard for config "${config}" ` +
  `split "${split}" — check the split name in datasets.json against ${SHARD_LIST_URL}, ` +
  `or ${BY_HAND_HINT}`;

const shardFailed = (url: string, status: number): string =>
  `dp-gnosis-bench: BRIGHT parquet shard download failed with HTTP ${status} for ${url} — ` +
  `retry, or ${BY_HAND_HINT}`;

const hasShardShape = (row: Row): boolean =>
  isString(row['filename']) && isString(row['url']) && typeof row['size'] === 'number';

const asShard = (row: Row): Shard => ({
  filename: String(row['filename']),
  url: String(row['url']),
  size: Number(row['size']),
});

/** The index lists every config of the dataset at once; this picks one pair's shards. */
const shardsFor = (body: unknown, config: string, split: string): readonly Shard[] => {
  const files = isRecord(body) ? body['parquet_files'] : undefined;
  return (Array.isArray(files) ? files : [])
    .filter(isRecord)
    .filter(row => row['config'] === config && row['split'] === split)
    .filter(hasShardShape)
    .map(asShard);
};

const fetchShards = async (config: string, split: string): Promise<readonly Shard[]> => {
  const response = await fetch(SHARD_LIST_URL);
  if (!response.ok) throw new Error(indexFailed(response.status));
  const shards = shardsFor((await response.json()) as unknown, config, split);
  if (shards.length === 0) throw new Error(noShards(config, split));
  return shards;
};

/** A cached shard counts only at its published size — a truncated file is not one. */
const isCached = (path: string, size: number): boolean =>
  existsSync(path) && statSync(path).size === size;

const download = async (shard: Shard, path: string): Promise<void> => {
  const response = await fetch(shard.url);
  if (!response.ok) throw new Error(shardFailed(shard.url, response.status));
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
};

/** The cached shard path, downloading it first when it is absent or the wrong size. */
const ensureShard = async (shard: Shard, path: string): Promise<string> => {
  if (isCached(path, shard.size)) return path;
  console.log(`dp-gnosis-bench: downloading ${shard.url} (${shard.size} bytes)`);
  await download(shard, path);
  return path;
};

/**
 * The whole shard as one `AsyncBuffer`. The largest split read here is 43 MB,
 * so it is read into memory once rather than served range by range.
 */
const bufferOf = (path: string): AsyncBuffer => {
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { byteLength: buffer.byteLength, slice: (start, end) => buffer.slice(start, end) };
};

/** All columns, so the row shape stays what `buildBrightFiles` reads. */
const readShard = async (path: string): Promise<readonly Row[]> => {
  const rows: unknown = await parquetReadObjects({ file: bufferOf(path) });
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
};

/** Every row of one config/split, in shard order, from the cached parquet files. */
export const fetchAllRows = async (
  config: string,
  split: string,
  cacheDir: string
): Promise<readonly Row[]> => {
  const dir = resolve(cacheDir, config, split);
  mkdirSync(dir, { recursive: true });
  const shards = await fetchShards(config, split);
  const paths = await Promise.all(
    shards.map(shard => ensureShard(shard, resolve(dir, shard.filename)))
  );
  return (await Promise.all(paths.map(readShard))).flat();
};

const writeFiles = (dir: string, files: BrightFiles): void => {
  mkdirSync(resolve(dir, QRELS_DIR), { recursive: true });
  writeFileSync(resolve(dir, CORPUS_FILE), files.corpus, 'utf8');
  writeFileSync(resolve(dir, QUERIES_FILE), files.queries, 'utf8');
  writeFileSync(resolve(dir, QRELS_DIR, `${QRELS_SPLIT}.tsv`), files.qrels, 'utf8');
  writeFileSync(resolve(dir, ID_MAP_FILE), `${JSON.stringify(files.idMap, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(dir, EXCLUDED_FILE), `${JSON.stringify(files.excluded, null, 2)}\n`, 'utf8');
};

/**
 * Where one entry's BEIR layout is cached. Keyed on the manifest id, which the
 * long and passage variants of a split MUST NOT share — same split at two
 * granularities means two corpora, and one overwriting the other would score a
 * dataset that is not the one named.
 */
export const brightDataDir = (entry: BrightDataset, dataDir: string): string =>
  resolve(dataDir, entry.id);

/**
 * The dataset's directory, materialising the split into BEIR layout only when
 * its `corpus.jsonl` is absent. Returns `<dataDir>/<entry.id>`.
 */
export const ensureBrightDataset = async (
  entry: BrightDataset,
  dataDir: string
): Promise<string> => {
  const dir = brightDataDir(entry, dataDir);
  if (existsSync(resolve(dir, CORPUS_FILE))) return dir;
  const cacheDir = resolve(dataDir, PARQUET_CACHE_DIR);
  const docRows = await fetchAllRows(corpusConfigFor(entry.granularity), entry.split, cacheDir);
  const exampleRows = await fetchAllRows(EXAMPLES_CONFIG, entry.split, cacheDir);
  writeFiles(dir, buildBrightFiles(docRows, exampleRows, entry.granularity));
  return dir;
};

const asIdList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter(isString) : [];

/**
 * Query id → excluded surrogate document ids, as `excluded.json` stores them.
 * A dataset without the file excludes nothing, which is the BEIR default.
 */
export const readExcluded = (dir: string): ReadonlyMap<string, readonly string[]> => {
  const path = resolve(dir, EXCLUDED_FILE);
  if (!existsSync(path)) return new Map();
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return isRecord(parsed)
    ? new Map(Object.entries(parsed).map(([queryId, ids]) => [queryId, asIdList(ids)]))
    : new Map();
};
