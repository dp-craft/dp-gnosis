/**
 * `bright` — one BRIGHT split, converted into the BEIR layout on disk.
 *
 * BRIGHT ships as parquet on the Hub. It is read here through the datasets-
 * server ROWS API instead, which serves the same rows as JSON over plain HTTP:
 * a parquet reader would be a new dependency for a one-way conversion that runs
 * once per dataset, ever. Two configs are read per split — `long_documents`
 * (`id`, `content`) becomes the corpus, `examples` (`id`, `query`,
 * `gold_ids_long`, `excluded_ids`) becomes the queries, the qrels and the
 * exclusions. Both field sets were probed against the live API before this
 * parser was written, not assumed.
 *
 * THE SURROGATE ID IS THE POINT OF THIS FILE. A BRIGHT document id is a path —
 * `insects_attracted_to_light/Proximate_and_ultimate_causation.txt` — and
 * `corpus.ts:fileNameFor` REJECTS it by design, because the corpus filename is
 * how `score.ts` maps a retrieved atom back to a qrels key. Sanitising it there
 * would break that mapping silently, so it is mapped HERE, once, and the
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrightDataset } from '../manifest.js';

const CORPUS_FILE = 'corpus.jsonl';
const QUERIES_FILE = 'queries.jsonl';
const QRELS_DIR = 'qrels';

/** `run.ts` scores BRIGHT under the `test` split name, so it is written as one. */
const QRELS_SPLIT = 'test';
const ID_MAP_FILE = 'id-map.json';
const EXCLUDED_FILE = 'excluded.json';

const ROWS_ENDPOINT = 'https://datasets-server.huggingface.co/rows';
const DATASET_PARAM = 'xlangai%2FBRIGHT';
const LONG_CONFIG = 'long_documents';
const EXAMPLES_CONFIG = 'examples';

/** The API's own page cap for this dataset; larger pages are rejected upstream. */
const PAGE_SIZE = 100;

/** BRIGHT judgments are binary — a gold document is relevant, everything else is not. */
const QRELS_GRADE = 1;

/** What `excluded_ids` carries when a query excludes nothing. */
const EXCLUDED_SENTINEL = 'N/A';

const QRELS_HEADER = 'query-id\tcorpus-id\tscore';
const PATH_SEPARATOR = '/';
const TXT_SUFFIX = '.txt';

/** Everything outside the filename-safe set `corpus.ts` accepts becomes `_`. */
const UNSAFE_CHARS = /[^A-Za-z0-9_-]/g;

type Row = Readonly<Record<string, unknown>>;

/** One page of the rows API: the rows themselves plus the split's total size. */
interface RowsPage {
  readonly rows: readonly Row[];
  readonly total: number;
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
 * A published BRIGHT id → the filename-safe id this suite uses everywhere.
 * Deterministic and total, so the corpus, the qrels and the exclusions can each
 * map independently and still agree.
 */
export const surrogateId = (rawId: string): string => rawId.replace(UNSAFE_CHARS, '_');

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

const qrelLines = (row: Row): readonly string[] =>
  strings(row, 'gold_ids_long').map(
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
 * conversion — surrogate ids, qrels derived from `gold_ids_long`, exclusions —
 * is testable without a network stub.
 */
export const buildBrightFiles = (
  docRows: readonly Row[],
  exampleRows: readonly Row[]
): BrightFiles => ({
  corpus: docRows.map(corpusLine).join('\n').concat('\n'),
  queries: exampleRows.map(queryLine).join('\n').concat('\n'),
  qrels: [QRELS_HEADER, ...exampleRows.flatMap(qrelLines)].join('\n').concat('\n'),
  idMap: Object.fromEntries(docRows.map(idMapEntry)),
  excluded: Object.fromEntries(exampleRows.map(excludedOf)),
});

const pageUrl = (config: string, split: string, offset: number): string =>
  `${ROWS_ENDPOINT}?dataset=${DATASET_PARAM}&config=${config}` +
  `&split=${split}&offset=${offset}&length=${PAGE_SIZE}`;

const parsePage = (body: unknown): RowsPage => {
  const record = isRecord(body) ? body : {};
  const rows = record['rows'];
  const total = record['num_rows_total'];
  return {
    rows: Array.isArray(rows)
      ? rows.map(entry => (isRecord(entry) && isRecord(entry['row']) ? entry['row'] : {}))
      : [],
    total: typeof total === 'number' ? total : 0,
  };
};

const requestFailed = (url: string, status: number): string =>
  `dp-gnosis-bench: BRIGHT rows request failed with HTTP ${status} for ${url} — ` +
  'the datasets-server is rate-limited and occasionally cold; retry, or fetch the ' +
  'split by hand into data/<id>/ in BEIR layout and switch the entry to "beir-local"';

const fetchPage = async (config: string, split: string, offset: number): Promise<RowsPage> => {
  const url = pageUrl(config, split, offset);
  const response = await fetch(url);
  if (!response.ok) throw new Error(requestFailed(url, response.status));
  return parsePage((await response.json()) as unknown);
};

/** A paging cursor, kept as one value so the recursion stays a single argument. */
interface Cursor {
  readonly config: string;
  readonly split: string;
  readonly rows: readonly Row[];
}

/** Page until `num_rows_total` is reached; an empty page also ends the walk. */
const pageFrom = async (cursor: Cursor): Promise<readonly Row[]> => {
  const page = await fetchPage(cursor.config, cursor.split, cursor.rows.length);
  const rows = [...cursor.rows, ...page.rows];
  return page.rows.length === 0 || rows.length >= page.total
    ? rows
    : pageFrom({ ...cursor, rows });
};

/** Every row of one config/split, oldest offset first. */
export const fetchAllRows = async (config: string, split: string): Promise<readonly Row[]> =>
  pageFrom({ config, split, rows: [] });

const writeFiles = (dir: string, files: BrightFiles): void => {
  mkdirSync(resolve(dir, QRELS_DIR), { recursive: true });
  writeFileSync(resolve(dir, CORPUS_FILE), files.corpus, 'utf8');
  writeFileSync(resolve(dir, QUERIES_FILE), files.queries, 'utf8');
  writeFileSync(resolve(dir, QRELS_DIR, `${QRELS_SPLIT}.tsv`), files.qrels, 'utf8');
  writeFileSync(resolve(dir, ID_MAP_FILE), `${JSON.stringify(files.idMap, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(dir, EXCLUDED_FILE), `${JSON.stringify(files.excluded, null, 2)}\n`, 'utf8');
};

/**
 * The dataset's directory, materialising the split into BEIR layout only when
 * its `corpus.jsonl` is absent. Returns `<dataDir>/<entry.id>`.
 */
export const ensureBrightDataset = async (
  entry: BrightDataset,
  dataDir: string
): Promise<string> => {
  const dir = resolve(dataDir, entry.id);
  if (existsSync(resolve(dir, CORPUS_FILE))) return dir;
  const docRows = await fetchAllRows(LONG_CONFIG, entry.split);
  const exampleRows = await fetchAllRows(EXAMPLES_CONFIG, entry.split);
  writeFiles(dir, buildBrightFiles(docRows, exampleRows));
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
