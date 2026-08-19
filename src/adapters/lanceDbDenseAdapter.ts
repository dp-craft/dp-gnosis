/**
 * The DENSE LanceDB routes, as a `KnowledgePort` each:
 *
 * - `lancedb-vec` — dense ONLY, the control. Cosine similarity over the vector
 *   column and nothing else.
 * - `lancedb-hybrid` — the dense leg fused with the LEXICAL (BM25) leg of the
 *   same table, cut to `k`.
 * - `lancedb-hybrid-full` — the same fusion, offering the union of the two legs'
 *   TOP-`k` as a reranking pool instead of cutting that union back to `k`.
 *   Merging two legs raises recall, and the cut hands most of that gain straight
 *   back (measured on `vault`: union recall +0.0161, +0.0042 once capped at 100;
 *   on `vault-hu` the capped gain is exactly 0.0000). It still ANSWERS with at
 *   most `k` atoms — the pool is a second reading of the same call, never a
 *   wider answer to it.
 *
 * Two NAMES rather than one adapter with a sub-flag: `adapter` is already a
 * recorded provenance field, so separate names make the treatment travel with
 * every recorded row for free, while a sub-flag would need a new field before a
 * single number could be compared.
 *
 * EMBED THE RAW BODY, AND THE RAW QUERY. The vector column holds embeddings of
 * `atom.body` verbatim and the query is embedded verbatim — never `stemText`.
 * Stemming is correct for BM25 and WRONG for a transformer: a vector column
 * built from stemmed text embeds without any error and simply underperforms,
 * which is the failure class this project keeps getting burned by. The LEXICAL
 * leg keeps stemming exactly as `lanceDbAdapter.ts` does, index-side and
 * query-side, so the two legs analyse their own input and neither is confounded
 * by the other.
 *
 * THE FROZEN ROUTE IS NOT TOUCHED. `lancedb` stays FTS-only, in its own file, at
 * its own index path, so its recorded row stays reproducible. This module is
 * additive in every direction: new names, new paths, new table schema.
 *
 * FUSION HAPPENS IN `fuseLegs` (`rerank.ts`), the two-leg form of the ONE fusion
 * this package owns. LanceDB's own `RRFReranker` is deliberately NOT used — a
 * second fusion implementation would make a hybrid number incomparable with
 * every reranked number already recorded.
 *
 * NO ANN INDEX. `bypassVectorIndex()` on every search: an exhaustive cosine scan
 * over a corpus this size is EXACT and cheap, and an IVF/HNSW index would trade
 * that exactness for a recall parameter nothing here has measured.
 *
 * REFUSAL, not fallback — a build or a retrieve whose embedding call fails
 * THROWS with the embedding client's own named cause. Falling back to the
 * lexical leg would record a lexical number under a dense label, and nothing
 * downstream could tell the two apart.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import type * as Lance from '@lancedb/lancedb';

import { type Atom, parseAtom } from '../atom.js';
import {
  ATOM_DOMAINS,
  ATOM_TYPES,
  type AtomDomain,
  type AtomType,
  DEFAULT_ATOM_TYPE,
  EMBED_BATCH_SIZE,
  EMBED_MODEL_ID,
  HYBRID_FUSION,
  type RerankFusion
} from '../config.js';
import { embedTexts } from '../embed.js';
import { createEmbeddingCache, type EmbeddingCache } from '../embedCache.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';
import { assertTypeFilter, atomOrigin } from '../port.js';
import { stemText } from '../query.js';
import { fuseLegs } from '../rerank.js';
import { isRetrievable } from '../retrievability.js';

/**
 * Which legs a route reads, and what it does with their union. It names the
 * TREATMENT, and it is the port's name.
 *
 * `hybrid-full` differs from `hybrid` in EXACTLY one step: the fused union is
 * not cut to `k` before it is offered as a reranking pool. Same table, same
 * legs, same fetch depth, same fusion — so the two are a clean pair.
 */
export type DenseRoute = 'vec' | 'hybrid' | 'hybrid-full';

/** `mode`/`name` reported per route — the adapter name, so a row carries the leg. */
const ROUTE_MODES: Readonly<Record<DenseRoute, string>> = {
  vec: 'lancedb-vec',
  hybrid: 'lancedb-hybrid',
  'hybrid-full': 'lancedb-hybrid-full',
};

/**
 * Whether a route fuses two legs — every route but `vec`, which reads the dense
 * leg alone. Exported because it decides where a leg-fusion PARAMETER may be
 * applied at all, and a caller deriving that from a name list of its own is how
 * a weight ends up recorded on an arm that fused nothing.
 */
export const fusesLegs = (route: DenseRoute): boolean => route !== 'vec';

/** The route that reports its whole pool — the un-truncated arm, and only it. */
const reportsPool = (route: DenseRoute): boolean => route === 'hybrid-full';

const MARKDOWN_EXT = '.md';

/** The single table, its columns, and the two engine-supplied score columns. */
const TABLE_NAME = 'atoms';
const BODY_FIELD = 'body';
const ID_FIELD = 'id';
const PATH_FIELD = 'path';
/** LanceDB infers a FixedSizeList<Float32> for a column with THIS name. */
const VECTOR_FIELD = 'vector';
/** LanceDB's BM25 relevance column; larger is better. */
const SCORE_FIELD = '_score';
/** LanceDB's vector-search distance column; SMALLER is better. */
const DISTANCE_FIELD = '_distance';

/** Exhaustive cosine, so the ranking is exact rather than an ANN approximation. */
const DISTANCE_TYPE = 'cosine';

/**
 * A table cannot be created from zero rows — LanceDB has no schema to infer —
 * yet an empty corpus MUST still produce a real index so `empty` is never
 * reported as `unavailable`. The placeholder's vector is one dimension wide and
 * is deleted immediately; no real vector ever joins it, because a search over a
 * zero-row table is short-circuited before it reaches the engine.
 */
const PLACEHOLDER_ROW: Readonly<Record<string, unknown>> = {
  [ID_FIELD]: '',
  [PATH_FIELD]: '',
  [BODY_FIELD]: '',
  [VECTOR_FIELD]: [0],
};
const PLACEHOLDER_PREDICATE = `${ID_FIELD} = ''`;

/** Identical to the frozen route's options: the lexical leg must not diverge. */
const FTS_MAX_TOKEN_LENGTH = 1024;

const FTS_INDEX_OPTIONS = {
  baseTokenizer: 'simple',
  lowercase: true,
  stem: false,
  removeStopWords: false,
  asciiFolding: false,
  withPosition: true,
  maxTokenLength: FTS_MAX_TOKEN_LENGTH,
} as const;

/** How many candidates each leg is asked for per requested result. */
const OVERFETCH_FACTOR = 8;

/** Options for a full index rebuild. */
export interface BuildLanceDbDenseIndexOptions {
  /** Curated atoms root. MUST NOT be pointed at the proposals root. */
  readonly atomsDir: string;
  /** Destination dataset DIRECTORY, replaced wholesale on every build. */
  readonly indexDir: string;
  /** A fused route additionally builds the BM25 index its lexical leg reads. */
  readonly route: DenseRoute;
}

/** Options for one adapter instance. */
export interface LanceDbDenseAdapterOptions extends BuildLanceDbDenseIndexOptions {
  /** Injected clock for `isRetrievable`; never read from inside. */
  readonly now: Date;
  /**
   * The DENSE leg's weight in the leg fusion, `0` = pure lexical and `1` = pure
   * dense; the lexical leg carries `1 - weight`. Absent means `HYBRID_FUSION`
   * itself, which is what every recorded hybrid run was measured under.
   *
   * The RANGE is the caller's to enforce, at the flag that names it: this is the
   * one place a value arrives, and a second refusal here would report the defect
   * without naming the flag that carries it.
   */
  readonly hybridWeight?: number | undefined;
}

type LanceModule = typeof Lance;
type Connection = Lance.Connection;
type Table = Lance.Table;

type LoadResult =
  | { readonly ok: true; readonly lance: LanceModule }
  | { readonly ok: false; readonly reason: string };

interface IndexEntry {
  readonly id: string;
  readonly path: string;
  readonly body: string;
}

interface SearchHit {
  readonly id: string;
  readonly path: string;
  readonly score: number;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The ONLY place `@lancedb/lancedb` is loaded; every import failure is reportable. */
const loadLance = (): Promise<LoadResult> =>
  import('@lancedb/lancedb').then(
    (module): LoadResult => ({ ok: true, lance: module }),
    (error: unknown): LoadResult => ({ ok: false, reason: describeError(error) })
  );

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const asDomain = (value: string): AtomDomain | undefined =>
  ATOM_DOMAINS.find(domain => domain === value);

const asType = (value: string): AtomType =>
  ATOM_TYPES.find(type => type === value) ?? DEFAULT_ATOM_TYPE;

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const markdownPaths = (atomsDir: string): readonly string[] =>
  existsSync(atomsDir)
    ? readdirSync(atomsDir, { recursive: true, encoding: 'utf8' })
        .filter(rel => rel.endsWith(MARKDOWN_EXT))
        .filter(rel => statSync(resolve(atomsDir, rel)).isFile())
        .sort(compareStrings)
    : [];

/** A file outside the closed frontmatter subset or domain vocabulary is SKIPPED. */
const toEntry = (atomsDir: string, rel: string): IndexEntry | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, rel), 'utf8'));
  return parsed.ok && asDomain(parsed.atom.frontmatter.x_domain) !== undefined
    ? { id: parsed.atom.frontmatter.id, path: rel, body: parsed.atom.body }
    : undefined;
};

/** Sorted by relative path, so INSERTION order — and therefore ranking — is reproducible. */
const collectEntries = (atomsDir: string): readonly IndexEntry[] =>
  markdownPaths(atomsDir)
    .map(rel => toEntry(atomsDir, rel))
    .filter(isDefined);

/** A refused embedding call is a THROW: no zero vector, no skipped document. */
const vectorsOrThrow = async (
  texts: readonly string[],
  cache: EmbeddingCache
): Promise<readonly (readonly number[])[]> => {
  const outcome = await embedTexts(texts, { cache });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.vectors;
};

/**
 * Embeds every body in `EMBED_BATCH_SIZE` batches. One request per corpus is
 * refused on the wire at any real corpus size, and a refusal costs the build.
 */
const embedAll = async (
  texts: readonly string[],
  cache: EmbeddingCache
): Promise<readonly (readonly number[])[]> => {
  if (texts.length === 0) return [];
  const head = await vectorsOrThrow(texts.slice(0, EMBED_BATCH_SIZE), cache);
  return [...head, ...(await embedAll(texts.slice(EMBED_BATCH_SIZE), cache))];
};

/**
 * `body` holds STEMS for the lexical leg; `vector` holds the embedding of the
 * RAW body. The two columns analyse their own input, and neither is derived
 * from the other.
 */
const toRow = (
  entry: IndexEntry,
  vector: readonly number[]
): Readonly<Record<string, unknown>> => ({
  [ID_FIELD]: entry.id,
  [PATH_FIELD]: entry.path,
  [BODY_FIELD]: stemText(entry.body),
  [VECTOR_FIELD]: [...vector],
});

const rowsFor = async (
  entries: readonly IndexEntry[],
  cache: EmbeddingCache
): Promise<readonly Readonly<Record<string, unknown>>[]> => {
  if (entries.length === 0) return [PLACEHOLDER_ROW];
  const vectors = await embedAll(
    entries.map(entry => entry.body),
    cache
  );
  return entries.map((entry, index) => toRow(entry, vectors[index] ?? []));
};

const purgePlaceholder = async (table: Table, count: number): Promise<void> => {
  await (count === 0 ? table.delete(PLACEHOLDER_PREDICATE) : Promise.resolve());
};

/** Only a fused route reads the BM25 column, so only a fused route pays to index it. */
const indexLexical = async (
  lance: LanceModule,
  table: Table,
  route: DenseRoute
): Promise<void> => {
  if (!fusesLegs(route)) return;
  await table.createIndex(BODY_FIELD, { config: lance.Index.fts(FTS_INDEX_OPTIONS) });
};

const writeIndex = async (
  lance: LanceModule,
  options: BuildLanceDbDenseIndexOptions
): Promise<true> => {
  const entries = collectEntries(options.atomsDir);
  const rows = await rowsFor(entries, createEmbeddingCache(options.indexDir, EMBED_MODEL_ID));
  rmSync(options.indexDir, { recursive: true, force: true });
  mkdirSync(dirname(options.indexDir), { recursive: true });
  const db = await lance.connect(options.indexDir);
  const table = await db.createTable(TABLE_NAME, [...rows], { mode: 'overwrite' });
  await purgePlaceholder(table, entries.length);
  await indexLexical(lance, table, options.route);
  db.close();
  return true;
};

/**
 * Rebuild the dataset wholesale from `atomsDir` and persist it.
 *
 * Returns `false` — never throws — when the optional LanceDB dependency is
 * unavailable, so a caller skips this leg exactly as it does for the frozen
 * route. An embedding failure is the OPPOSITE case and THROWS: the dependency
 * being absent means this leg cannot be measured, while a refused embedding
 * means the leg would be measured WRONG.
 */
export const buildLanceDbDenseIndex = async (
  options: BuildLanceDbDenseIndexOptions
): Promise<boolean> => {
  const loaded = await loadLance();
  return loaded.ok ? await writeIndex(loaded.lance, options) : false;
};

/**
 * The leg fusion this instance runs. An absent weight yields `HYBRID_FUSION`
 * ITSELF — the same object every recorded hybrid run fused with, so the default
 * is bit-identical rather than merely equal.
 */
const fusionOf = (options: LanceDbDenseAdapterOptions): RerankFusion =>
  options.hybridWeight === undefined
    ? HYBRID_FUSION
    : { ...HYBRID_FUSION, rerankWeight: options.hybridWeight };

/** QUERY SIDE of the shared stemmer, for the LEXICAL leg only. */
const toMatchExpression = (query: string): string | undefined => {
  const stemmed = stemText(query);
  return stemmed.length === 0 ? undefined : stemmed;
};

/** QUERY SIDE of the dense leg: the RAW query text, refusing rather than degrading. */
const embedQuery = async (query: string): Promise<readonly number[]> => {
  const outcome = await embedTexts([query]);
  if (!outcome.ok) throw new Error(outcome.error);
  const vector = outcome.vectors[0];
  if (vector === undefined) throw new Error('embed: the query was not embedded');
  return vector;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? { ...value } : undefined;

const stringField = (
  record: Readonly<Record<string, unknown>>,
  key: string
): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const numberField = (
  record: Readonly<Record<string, unknown>>,
  key: string
): number | undefined => {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
};

/** A LanceDB row arrives untyped, so every field is GUARDED, never cast. */
const composeHit = (
  record: Readonly<Record<string, unknown>>,
  score: number | undefined
): SearchHit | undefined => {
  const id = stringField(record, ID_FIELD);
  const path = stringField(record, PATH_FIELD);
  return id !== undefined && path !== undefined && score !== undefined
    ? { id, path, score }
    : undefined;
};

/** Cosine DISTANCE inverted into a similarity, so larger is better on both legs. */
const similarityOf = (record: Readonly<Record<string, unknown>>): number | undefined => {
  const distance = numberField(record, DISTANCE_FIELD);
  return distance === undefined ? undefined : 1 - distance;
};

const toDenseHit = (value: unknown): SearchHit | undefined => {
  const record = asRecord(value);
  return record === undefined ? undefined : composeHit(record, similarityOf(record));
};

const toLexicalHit = (value: unknown): SearchHit | undefined => {
  const record = asRecord(value);
  return record === undefined ? undefined : composeHit(record, numberField(record, SCORE_FIELD));
};

const fromAtom = (atom: Atom, hit: SearchHit, sourcePath: string): RetrievedAtom | undefined => {
  const domain = asDomain(atom.frontmatter.x_domain);
  return domain === undefined
    ? undefined
    : {
        id: hit.id,
        title: atom.frontmatter.title,
        domain,
        type: asType(atom.frontmatter.type),
        ...atomOrigin(atom.frontmatter),
        body: atom.body,
        score: hit.score,
        sourcePath,
        originPaths: atom.frontmatter.sources,
      };
};

/** Body, title and retrievability come from DISK, so an edit lands immediately. */
const readHit = (
  options: LanceDbDenseAdapterOptions,
  hit: SearchHit
): RetrievedAtom | undefined => {
  const sourcePath = resolve(options.atomsDir, hit.path);
  const parsed = existsSync(sourcePath)
    ? parseAtom(readFileSync(sourcePath, 'utf8'))
    : { ok: false as const, error: 'missing' };
  return parsed.ok && isRetrievable(parsed.atom.frontmatter, options.now)
    ? fromAtom(parsed.atom, hit, sourcePath)
    : undefined;
};

const byScoreThenId = (a: RetrievedAtom, b: RetrievedAtom): number =>
  b.score - a.score || compareStrings(a.id, b.id);

const matchDomain = (atom: RetrievedAtom, domain: AtomDomain | undefined): boolean =>
  domain === undefined || atom.domain === domain;

const matchType = (atom: RetrievedAtom, types: readonly AtomType[] | undefined): boolean =>
  types === undefined || types.includes(atom.type);

/**
 * Every candidate that survived retrievability and the request's filters, in
 * fused order and NOT cut to `k` — the pool `selectAtoms` takes its head from,
 * so the two can never disagree about the order they report.
 */
const selectCandidates = (
  options: LanceDbDenseAdapterOptions,
  hits: readonly SearchHit[],
  opts: RetrieveOptions
): readonly RetrievedAtom[] =>
  hits
    .map(hit => readHit(options, hit))
    .filter(isDefined)
    .filter(atom => matchDomain(atom, opts.domain))
    .filter(atom => matchType(atom, opts.types))
    .sort(byScoreThenId);

/** What one retrieval produced: the whole pool, and the `k` the port answers with. */
interface Candidates {
  readonly pool: readonly RetrievedAtom[];
  readonly atoms: readonly RetrievedAtom[];
}

/** The cut, in ONE place: `atoms` is always the pool's head, never a second order. */
const cutToK = (pool: readonly RetrievedAtom[], opts: RetrieveOptions): Candidates => ({
  pool,
  atoms: pool.slice(0, opts.k),
});

/** One open dataset: the connection, the table, and which tree they came from. */
interface OpenIndex {
  readonly identity: string;
  readonly db: Connection;
  readonly table: Table;
}

/**
 * The newest mtime anywhere under a directory TREE — LanceDB writes a tree, and
 * a directory's own mtime tracks only its DIRECT children.
 */
const newestTreeMs = (dir: string): number =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(rel => statSync(resolve(dir, rel)).mtimeMs)
    .reduce((max, ms) => Math.max(max, ms), statSync(dir).mtimeMs);

const newestCorpusMs = (atomsDir: string): number =>
  existsSync(atomsDir)
    ? markdownPaths(atomsDir)
        .map(rel => statSync(resolve(atomsDir, rel)).mtimeMs)
        .reduce((max, ms) => Math.max(max, ms), statSync(atomsDir).mtimeMs)
    : 0;

/** The corpus sweep, sampled AT MOST ONCE per instance — see the frozen route. */
interface CorpusCell {
  newestMs: number | undefined;
}

const sampleCorpusMs = (cell: CorpusCell, atomsDir: string): number => {
  const sampled = newestCorpusMs(atomsDir);
  cell.newestMs = sampled;
  return sampled;
};

const acquireCorpusMs = (cell: CorpusCell, atomsDir: string): number =>
  cell.newestMs ?? sampleCorpusMs(cell, atomsDir);

const isStale = (self: DenseInstance): boolean =>
  acquireCorpusMs(self.corpus, self.options.atomsDir) > newestTreeMs(self.options.indexDir);

/** `stale` outranks `empty`: an index that lags the corpus is lagging, not empty. */
const resolveState = (self: DenseInstance, count: number): IndexState =>
  isStale(self) ? 'stale' : count === 0 ? 'empty' : 'ready';

/** Which TREE the cached handle holds — inode and newest mtime together. */
const identityOf = (indexDir: string): string =>
  `${statSync(indexDir).ino}:${newestTreeMs(indexDir)}`;

const openIndex = async (lance: LanceModule, indexDir: string): Promise<OpenIndex> => {
  const db = await lance.connect(indexDir);
  const table = await db.openTable(TABLE_NAME);
  return { identity: identityOf(indexDir), db, table };
};

/** The open dataset amortized across calls, with a single-flight guard. */
interface HandleCell {
  open: OpenIndex | undefined;
  opening: Promise<OpenIndex> | undefined;
}

const release = (cell: HandleCell): void => {
  cell.open?.db.close();
  cell.open = undefined;
};

const settle = (cell: HandleCell, opened: OpenIndex): OpenIndex => {
  cell.open = opened;
  cell.opening = undefined;
  return opened;
};

/** A failed open MUST NOT stay in flight, or every later caller inherits its failure. */
const forget = (cell: HandleCell, error: unknown): never => {
  cell.opening = undefined;
  throw error;
};

const reopen = (cell: HandleCell, lance: LanceModule, indexDir: string): Promise<OpenIndex> => {
  release(cell);
  const opening = openIndex(lance, indexDir).then(
    opened => settle(cell, opened),
    (error: unknown) => forget(cell, error)
  );
  cell.opening = opening;
  return opening;
};

const acquire = (cell: HandleCell, lance: LanceModule, indexDir: string): Promise<OpenIndex> => {
  const current = cell.open;
  return current !== undefined && current.identity === identityOf(indexDir)
    ? Promise.resolve(current)
    : cell.opening ?? reopen(cell, lance, indexDir);
};

/**
 * A directory holding no `atoms` table means no search can run — `undefined`
 * here becomes `unavailable`, never `empty`. Narrowed to the OPEN step: a
 * failure inside the search itself is a real defect and MUST still surface.
 */
const openOrSkip = (
  cell: HandleCell,
  lance: LanceModule,
  indexDir: string
): Promise<OpenIndex | undefined> =>
  acquire(cell, lance, indexDir).then(
    open => open,
    () => undefined
  );

/** One retrieval call's inputs, resolved once: the query vector is embedded once. */
interface Probe {
  readonly table: Table;
  readonly route: DenseRoute;
  readonly query: string;
  readonly vector: readonly number[];
  readonly opts: RetrieveOptions;
  /** The leg fusion this instance runs — `HYBRID_FUSION` unless a weight was named. */
  readonly fusion: RerankFusion;
}

/** Exhaustive cosine — `bypassVectorIndex` is what makes the ranking EXACT. */
const denseRows = (probe: Probe, limit: number): Promise<readonly unknown[]> =>
  probe.table
    .query()
    .nearestTo([...probe.vector])
    .distanceType(DISTANCE_TYPE)
    .bypassVectorIndex()
    .limit(limit)
    .toArray();

const lexicalRows = (probe: Probe, limit: number): Promise<readonly unknown[]> => {
  const match = toMatchExpression(probe.query);
  return match === undefined
    ? Promise.resolve([])
    : probe.table.query().fullTextSearch(match).limit(limit).toArray();
};

/** One pool of candidates, and whether the engine had more to give. */
interface Pool {
  readonly hits: readonly SearchHit[];
  readonly exhausted: boolean;
}

/**
 * The UNION of the two legs, scored by `fuseLegs`. A candidate only one leg
 * returned is kept and scored from that leg alone — dropping it would make the
 * hybrid strictly worse than either leg it is built from.
 */
const fuseHits = (
  lexical: readonly SearchHit[],
  dense: readonly SearchHit[],
  fusion: RerankFusion
): readonly SearchHit[] => {
  const lexicalIds = new Set(lexical.map(hit => hit.id));
  const items = [...lexical, ...dense.filter(hit => !lexicalIds.has(hit.id))];
  const position = new Map(items.map((hit, index) => [hit.id, index]));
  const orderOf = (leg: readonly SearchHit[]): readonly number[] =>
    leg.map(hit => position.get(hit.id)).filter(isDefined);
  const fused = fuseLegs({ items, primary: orderOf(lexical), secondary: orderOf(dense) }, fusion);
  return fused.map(entry => ({ ...entry.item, score: entry.score }));
};

const densePool = async (probe: Probe, limit: number): Promise<Pool> => {
  const rows = await denseRows(probe, limit);
  return { hits: rows.map(toDenseHit).filter(isDefined), exhausted: rows.length < limit };
};

/**
 * How many candidates each leg CONTRIBUTES to a fused union — its own top-`k`,
 * recovered from the fetch limit the overfetch was derived from.
 *
 * The legs still FETCH `limit`: the overfetch exists so that `k` candidates
 * SURVIVE retrievability and the request's filters, and that is unchanged. What
 * a leg OFFERS is its head, so the union is the union of two top-`k` result
 * lists — near 1.55×`k` unique on the real corpora and never above 2×`k`. The
 * union of the two overfetched SCANS would be up to 2×`k`×`OVERFETCH_FACTOR`
 * (~1600 documents at `k`=100), which is not the treatment the offline
 * `.trec`-file analysis measured AND is a reranking cost nothing can pay
 * (~15 s/query at ~100 documents on qwen3-4b, so ~4 h for one `vault` arm).
 *
 * It scales WITH the widening: a filtered request that starved doubles `limit`,
 * and each leg then offers twice as much, or the escalation could not converge.
 */
const legContribution = (limit: number): number => Math.ceil(limit / OVERFETCH_FACTOR);

/** `hybrid-full` offers each leg's head; `hybrid` cuts the fused order instead. */
const offered = (
  probe: Probe,
  leg: readonly SearchHit[],
  limit: number
): readonly SearchHit[] =>
  reportsPool(probe.route) ? leg.slice(0, legContribution(limit)) : leg;

const hybridPool = async (probe: Probe, limit: number): Promise<Pool> => {
  const [dense, lexicalRaw] = await Promise.all([
    densePool(probe, limit),
    lexicalRows(probe, limit),
  ]);
  const lexical = lexicalRaw.map(toLexicalHit).filter(isDefined);
  return {
    hits: fuseHits(
      offered(probe, lexical, limit),
      offered(probe, dense.hits, limit),
      probe.fusion
    ),
    exhausted: dense.exhausted && lexicalRaw.length < limit,
  };
};

const poolFor = async (probe: Probe, limit: number): Promise<Pool> =>
  fusesLegs(probe.route) ? await hybridPool(probe, limit) : await densePool(probe, limit);

/** The candidate pool ONE fetch asks each leg for. */
const poolSize = (opts: RetrieveOptions): number => opts.k * OVERFETCH_FACTOR;

/**
 * Whether the request narrows the pool AFTER the engine truncated it — the only
 * shape that can starve, and therefore the only one that escalates.
 */
const isFiltered = (opts: RetrieveOptions): boolean =>
  opts.domain !== undefined || opts.types !== undefined;

/** Widen the pool until `k` survivors are held or the engine is exhausted. */
const readUntilSettled = async (
  options: LanceDbDenseAdapterOptions,
  probe: Probe,
  limit: number
): Promise<Candidates> => {
  const found = await poolFor(probe, limit);
  const candidates = cutToK(selectCandidates(options, found.hits, probe.opts), probe.opts);
  return candidates.atoms.length >= probe.opts.k || found.exhausted
    ? candidates
    : await readUntilSettled(options, probe, limit * 2);
};

const readOnce = async (
  options: LanceDbDenseAdapterOptions,
  probe: Probe
): Promise<Candidates> => {
  const found = await poolFor(probe, poolSize(probe.opts));
  return cutToK(selectCandidates(options, found.hits, probe.opts), probe.opts);
};

const selectFromIndex = async (
  options: LanceDbDenseAdapterOptions,
  probe: Probe
): Promise<Candidates> =>
  isFiltered(probe.opts)
    ? await readUntilSettled(options, probe, poolSize(probe.opts))
    : await readOnce(options, probe);

interface IndexSnapshot {
  readonly count: number;
  readonly candidates: Candidates;
}

/** One retrieval call's inputs, kept together so no helper takes four arguments. */
interface SearchRequest {
  readonly query: string;
  readonly opts: RetrieveOptions;
}

/**
 * A zero-row table is answered WITHOUT a search: its placeholder schema carries
 * a one-dimensional vector, so a real query vector would be a dimension
 * mismatch rather than an empty result. The query is not embedded either — an
 * empty index has nothing to compare against, and a network call to prove it
 * would be a cost with no answer attached.
 */
const snapshotOf = async (
  options: LanceDbDenseAdapterOptions,
  index: OpenIndex,
  request: SearchRequest
): Promise<IndexSnapshot> => {
  const count = await index.table.countRows();
  if (count === 0) return { count, candidates: { pool: [], atoms: [] } };
  const vector = await embedQuery(request.query);
  const probe: Probe = {
    ...request,
    table: index.table,
    route: options.route,
    vector,
    fusion: fusionOf(options),
  };
  return { count, candidates: await selectFromIndex(options, probe) };
};

/**
 * No index directory, no corpus root, no `atoms` table, or no dependency — all
 * of them mean NO search happened, so all of them report `unavailable`, never
 * `empty`. An embedding refusal is NOT one of them: it throws.
 */
const unavailableResult = (route: DenseRoute): RetrievalResult => ({
  atoms: [],
  mode: ROUTE_MODES[route],
  indexState: 'unavailable',
});

/** One adapter instance: its immutable options and the handles it amortizes. */
interface DenseInstance {
  readonly options: LanceDbDenseAdapterOptions;
  readonly cell: HandleCell;
  readonly corpus: CorpusCell;
}

/**
 * The pool is reported ONLY by the route that exists to report it, so every
 * other route's result is the object it has always been — a caller reading
 * `poolAtoms` on `lancedb-hybrid` still gets nothing, by construction.
 */
const describeResult = (self: DenseInstance, snapshot: IndexSnapshot): RetrievalResult => ({
  atoms: snapshot.candidates.atoms,
  mode: ROUTE_MODES[self.options.route],
  indexState: resolveState(self, snapshot.count),
  ...(reportsPool(self.options.route) ? { poolAtoms: snapshot.candidates.pool } : {}),
});

const search = async (
  self: DenseInstance,
  lance: LanceModule,
  request: SearchRequest
): Promise<RetrievalResult> => {
  const index = await openOrSkip(self.cell, lance, self.options.indexDir);
  return index === undefined
    ? unavailableResult(self.options.route)
    : describeResult(self, await snapshotOf(self.options, index, request));
};

const canSearch = (options: LanceDbDenseAdapterOptions): boolean =>
  existsSync(options.indexDir) && existsSync(options.atomsDir);

const retrieveFrom = async (
  self: DenseInstance,
  request: SearchRequest
): Promise<RetrievalResult> => {
  const loaded = await loadLance();
  return loaded.ok && canSearch(self.options)
    ? await search(self, loaded.lance, request)
    : unavailableResult(self.options.route);
};

/**
 * Build a port over `options.indexDir`, reading `options.atomsDir`, on the leg
 * `options.route` names. The dataset is opened LAZILY and reused for the life of
 * the instance; a rebuild is picked up on the very next retrieve.
 */
export const createLanceDbDenseAdapter = (
  options: LanceDbDenseAdapterOptions
): KnowledgePort => {
  const self: DenseInstance = {
    options,
    cell: { open: undefined, opening: undefined },
    corpus: { newestMs: undefined },
  };
  return {
    name: ROUTE_MODES[options.route],
    retrieve: async (query: string, opts: RetrieveOptions): Promise<RetrievalResult> => {
      assertTypeFilter(opts.types);
      return await retrieveFrom(self, { query, opts });
    },
    close: (): void => release(self.cell),
  };
};
