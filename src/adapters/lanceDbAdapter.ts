/**
 * A LanceDB `KnowledgePort`: BM25 full-text retrieval over the atom vault,
 * persisted as an on-disk LanceDB dataset DIRECTORY.
 *
 * SCOPE, STATED HONESTLY — LanceDB is a VECTOR database, and the dense/semantic
 * leg is explicitly OUT of scope for this phase. This adapter exercises
 * LanceDB's full-text-search (BM25) path ONLY: no embeddings, no vector column,
 * no hybrid search. So it is a v2-READINESS PROBE as much as a v1 candidate —
 * the measurement it contributes cannot exercise what LanceDB is actually for.
 * Reading a poor v1 score as "LanceDB is not worth it" would be reading the
 * wrong experiment; what this leg measures is the COST of carrying a vector
 * engine that is currently only doing lexical work.
 *
 * LAZY DYNAMIC IMPORT — `@lancedb/lancedb` is an `optionalDependency`, so it may
 * be absent. It is imported inside the call path, and EVERY import error is
 * caught, not just `MODULE_NOT_FOUND`: on a platform whose prebuilt binary lags
 * the root package version this package fails at IMPORT time with a native
 * BINDING error, which is a different error class entirely, and a narrow catch
 * would hard-fail the whole suite instead of skipping this one leg.
 * `lanceDbAvailability` exposes the reason so the harness can REPORT the skip.
 *
 * STEMMING — the SHARED `stemText`/`stemTerm` from `query.ts`, applied
 * index-side (text is stemmed BEFORE insertion) and query-side (the query is
 * stemmed before it reaches `fullTextSearch`), exactly as the FTS5 adapter does.
 * LanceDB's own `<lang>_stem` FTS tokenizer is deliberately NOT used — it is a
 * different Porter implementation, and binding it here would make this adapter
 * stem by its own rules, an unnamed confound that invalidates the four-way
 * comparison. Hence `stem: false` and `removeStopWords: false` on the index.
 *
 * DETERMINISM — MEASURED, not assumed. LanceDB's BM25 ordering of equally-scored
 * rows is NOT stable: three rows with identical text came back `mmm, zzz, aaa`
 * from a sorted-order build and `zzz, mmm, aaa` from a reversed-order build of
 * the same corpus. Worse, asking for exactly `k` on a three-way tie returned a
 * DIFFERENT arbitrary subset than the top-`k` of the unlimited result. So rows
 * are inserted in sorted relative-path order, the engine is asked for
 * `k * FTS_OVERFETCH_FACTOR` candidates, and the port's own explicit
 * `(score DESC, atomId ASC)` sort is applied before truncating to `k`.
 * Over-fetching does not ELIMINATE the risk — a tie wider than `k'` can still be
 * cut arbitrarily by the engine — but it is cheap and it removes the failure at
 * every corpus size this benchmark uses.
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
  ATOM_TYPES,
  type AtomDomain,
  type AtomType,
  DEFAULT_ATOM_TYPE
} from '../config.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';
import { assertTypeFilter, atomOrigin } from '../port.js';
import { stemText } from '../query.js';
import { isRetrievable } from '../retrievability.js';

/** `mode`/`name` reported by this adapter. Names the LEG, not just the engine. */
const LANCEDB_MODE = 'lancedb-fts';

const MARKDOWN_EXT = '.md';

/** The single table, the indexed column, the join key, and the stored location. */
const TABLE_NAME = 'atoms';
const BODY_FIELD = 'body';
const ID_FIELD = 'id';
const PATH_FIELD = 'path';
/** LanceDB's own BM25 relevance column; larger is better (measured). */
const SCORE_FIELD = '_score';

/**
 * A table cannot be created from zero rows — LanceDB has no schema to infer —
 * yet an `empty` corpus MUST still produce a real, searchable index so `empty`
 * is never reported as `unavailable`. One placeholder row establishes the
 * schema and is deleted before the FTS index is built.
 */
const PLACEHOLDER_ROW: Readonly<Record<string, unknown>> = {
  [ID_FIELD]: '',
  [PATH_FIELD]: '',
  [BODY_FIELD]: '',
};
const PLACEHOLDER_PREDICATE = `${ID_FIELD} = ''`;

/**
 * The one index switch turned ON, and for the OPPOSITE reason to the ones below:
 * left unset, tantivy's default silently DROPS every token past its cutoff, and
 * fts5 — the production adapter — has no such cutoff, so the asymmetry is an
 * unnamed confound in any cross-adapter comparison rather than a normalization
 * difference.
 *
 * DERIVED FROM MEASUREMENT, not chosen. Probed 2026-08-16 against the installed
 * `@lancedb/lancedb` 0.33.0 with this exact option set: a 39-char token HITS
 * while 40 / 41 / 64 / 128 / 734 / 900 all MISS; with this value every one HITS.
 * Longest stemmed token per corpus (`stemText(atom.body)`, whitespace-split,
 * over the ingested atoms): `vault` 734 (85 tokens ≥40, 10 ≥64, 4 ≥128 — the
 * longest is an embedded base64 blob), `vault-hu` 26 (ZERO ≥40), `scifact` 40,
 * `arguana` 40, `nfcorpus` 31. 1024 is the smallest power of two above 734.
 *
 * The one recorded `lancedb` baseline survives BY CONSTRUCTION: it is
 * `vault-hu`, which holds zero tokens of ≥40 characters, so this is a no-op
 * there. It changes only `vault`, which has no LanceDB baseline to break.
 */
const FTS_MAX_TOKEN_LENGTH = 1024;

/**
 * LanceDB's tokenizer is left at `simple` and its OWN normalization is turned
 * off: the text reaching it is already tokenized, diacritic-folded, lowercased
 * and stemmed by `query.ts`, so every switch here would be a SECOND, divergent
 * normalizer. `withPosition` stays on so phrase queries remain possible.
 */
const FTS_INDEX_OPTIONS = {
  baseTokenizer: 'simple',
  lowercase: true,
  stem: false,
  removeStopWords: false,
  asciiFolding: false,
  withPosition: true,
  maxTokenLength: FTS_MAX_TOKEN_LENGTH,
} as const;

/**
 * How many candidates are requested per requested result. Covers a tie wider
 * than `k` so the port's own tiebreak — not the engine's unstable order —
 * decides which members of that tie survive truncation.
 */
const FTS_OVERFETCH_FACTOR = 8;

/** Options for a full index rebuild. */
export interface BuildLanceDbIndexOptions {
  /** Curated atoms root. MUST NOT be pointed at the proposals root. */
  readonly atomsDir: string;
  /**
   * Destination dataset DIRECTORY — LanceDB writes a tree, not a single file.
   * Its parent is created if absent, and the directory itself is replaced
   * wholesale on every build.
   */
  readonly indexDir: string;
}

/** Options for one adapter instance. */
export interface LanceDbAdapterOptions extends BuildLanceDbIndexOptions {
  /** Injected clock for `isRetrievable`; never read from inside. */
  readonly now: Date;
}

/** Whether the optional dependency loaded, and why it did not. */
export interface LanceDbAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/** The module's own surface, taken from a TYPE-ONLY import so nothing loads eagerly. */
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

/**
 * The ONLY place `@lancedb/lancedb` is loaded. Both settlement paths are
 * handled, so an import that rejects for ANY reason — module resolution OR a
 * native binding failure — yields a reportable skip rather than a throw that
 * would take the caller down with it.
 */
const loadLance = (): Promise<LoadResult> =>
  import('@lancedb/lancedb').then(
    (module): LoadResult => ({ ok: true, lance: module }),
    (error: unknown): LoadResult => ({ ok: false, reason: describeError(error) })
  );

/** Probe the optional dependency so a harness can report WHY a leg was skipped. */
export const lanceDbAvailability = async (): Promise<LanceDbAvailability> => {
  const loaded = await loadLance();
  return loaded.ok ? { available: true } : { available: false, reason: loaded.reason };
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * An unknown or absent `type` falls back to the default rather than dropping the
 * atom: the type vocabulary classifies an atom, it does not gate indexing, so a
 * typo must not make an otherwise valid atom unreachable.
 */
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

/** A file outside the closed frontmatter subset is SKIPPED. */
const toEntry = (atomsDir: string, rel: string): IndexEntry | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, rel), 'utf8'));
  return parsed.ok
    ? { id: parsed.atom.frontmatter.id, path: rel, body: parsed.atom.body }
    : undefined;
};

/** Sorted by relative path, so INSERTION order — and therefore ranking — is reproducible. */
const collectEntries = (atomsDir: string): readonly IndexEntry[] =>
  markdownPaths(atomsDir)
    .map(rel => toEntry(atomsDir, rel))
    .filter(isDefined);

/**
 * INDEX SIDE of the shared stemmer: the stored `body` column holds STEMS, so
 * LanceDB's `simple` tokenizer splits text that is already normalized by
 * `query.ts`. The column is still full text — a document store structurally
 * cannot omit it — which is precisely why "read the body from disk at call
 * time" is a PORT rule (`port.ts`) rather than an index rule.
 */
const toRow = (entry: IndexEntry): Readonly<Record<string, unknown>> => ({
  [ID_FIELD]: entry.id,
  [PATH_FIELD]: entry.path,
  [BODY_FIELD]: stemText(entry.body),
});

const rowsFor = (entries: readonly IndexEntry[]): readonly Readonly<Record<string, unknown>>[] =>
  entries.length === 0 ? [PLACEHOLDER_ROW] : entries.map(toRow);

const purgePlaceholder = async (table: Table, count: number): Promise<void> => {
  await (count === 0 ? table.delete(PLACEHOLDER_PREDICATE) : Promise.resolve());
};

const writeIndex = async (
  lance: LanceModule,
  options: BuildLanceDbIndexOptions
): Promise<number> => {
  const entries = collectEntries(options.atomsDir);
  rmSync(options.indexDir, { recursive: true, force: true });
  mkdirSync(dirname(options.indexDir), { recursive: true });
  const db = await lance.connect(options.indexDir);
  const table = await db.createTable(TABLE_NAME, [...rowsFor(entries)], { mode: 'overwrite' });
  await purgePlaceholder(table, entries.length);
  await table.createIndex(BODY_FIELD, { config: lance.Index.fts(FTS_INDEX_OPTIONS) });
  db.close();
  return entries.length;
};

/**
 * Rebuild the dataset wholesale from `atomsDir` and persist it. Wholesale
 * rather than incremental because reproducibility is the property under test.
 *
 * Returns HOW MANY atoms were indexed, so a caller can tell a built-but-EMPTY
 * dataset from a populated one — a bare success flag reports the empty one as a
 * working index and every query then answers nothing with no error anywhere.
 *
 * `undefined` — never a throw — when the optional dependency is unavailable, so
 * a caller skips this leg instead of failing. The two outcomes are different
 * facts: nothing COULD be built, versus nothing WAS.
 */
export const buildLanceDbIndex = async (
  options: BuildLanceDbIndexOptions
): Promise<number | undefined> => {
  const loaded = await loadLance();
  return loaded.ok ? await writeIndex(loaded.lance, options) : undefined;
};

/**
 * QUERY SIDE of the shared stemmer. `query.ts` owns tokenization and an adapter
 * MUST NOT re-tokenize, so the whole query string is run through the
 * package-wide `stemText`, which preserves token order. Its output is `[a-z0-9 ]`
 * only, so no LanceDB query syntax can be smuggled in and no escaping is needed.
 * `undefined` for a term-free query — an empty search is asked of nobody.
 */
const toMatchExpression = (query: string): string | undefined => {
  const stemmed = stemText(query);
  return stemmed.length === 0 ? undefined : stemmed;
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
const composeHit = (record: Readonly<Record<string, unknown>>): SearchHit | undefined => {
  const id = stringField(record, ID_FIELD);
  const path = stringField(record, PATH_FIELD);
  const score = numberField(record, SCORE_FIELD);
  return id !== undefined && path !== undefined && score !== undefined
    ? { id, path, score }
    : undefined;
};

const toHit = (value: unknown): SearchHit | undefined => {
  const record = asRecord(value);
  return record === undefined ? undefined : composeHit(record);
};

const fromAtom = (atom: Atom, hit: SearchHit, sourcePath: string): RetrievedAtom => ({
  id: hit.id,
  title: atom.frontmatter.title,
  domain: atom.frontmatter.x_domain,
  type: asType(atom.frontmatter.type),
  ...atomOrigin(atom.frontmatter),
  body: atom.body,
  score: hit.score,
  sourcePath,
  originPaths: atom.frontmatter.sources,
});

/** Body, title and retrievability come from DISK, so an edit lands immediately. */
const readHit = (options: LanceDbAdapterOptions, hit: SearchHit): RetrievedAtom | undefined => {
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

const selectAtoms = (
  options: LanceDbAdapterOptions,
  rows: readonly unknown[],
  opts: RetrieveOptions
): readonly RetrievedAtom[] =>
  rows
    .map(toHit)
    .filter(isDefined)
    .map(hit => readHit(options, hit))
    .filter(isDefined)
    .filter(atom => matchDomain(atom, opts.domain))
    .filter(atom => matchType(atom, opts.types))
    .sort(byScoreThenId)
    .slice(0, opts.k);

/**
 * The newest mtime anywhere under a directory TREE. LanceDB writes a tree, not
 * a single file, and a directory's own mtime only tracks its DIRECT children —
 * so comparing directory mtimes alone would miss a rebuild that only rewrote a
 * nested fragment.
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

/**
 * The corpus-newest-mtime sweep, sampled AT MOST ONCE per adapter instance.
 *
 * MEASURED on the fts5 adapter, which carries the identical sweep, over the
 * 43 228-atom corpus: one retrieve cost ~710 ms and ~700 ms of that was the
 * sweep — every markdown file is listed and `stat`ed (43 228 stat calls per
 * query) solely to label `indexState`, which changes neither which atoms come
 * back nor their order. Latency was flat in k (821/799/798 ms for k=1/10/50) and
 * flat in match count, while scaling with corpus size (11 522 atoms → 268 ms,
 * 43 228 → 881 ms).
 *
 * RECORDED DECISION: the corpus is FIXED for the lifetime of a process — ANY
 * markdown change requires a RESTART — so the sweep runs lazily on the first
 * retrieve that needs it and every later retrieve on that instance reuses the
 * verdict. The cell hangs off the INSTANCE, never a module-global cache: two
 * adapters over different atom dirs in one process MUST NOT share a verdict.
 *
 * Only the CORPUS side is cached; `newestTreeMs(indexDir)` is still read per
 * call, so a rebuilt index still flips the verdict, and body, title and
 * retrievability are still read from disk per row on every call.
 */
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

const isStale = (self: LanceDbInstance): boolean =>
  acquireCorpusMs(self.corpus, self.options.atomsDir) > newestTreeMs(self.options.indexDir);

/**
 * `stale` outranks `empty`: an index that both lags the corpus and holds nothing
 * is lagging, and saying `empty` would claim the corpus is genuinely empty.
 */
const resolveState = (self: LanceDbInstance, count: number): IndexState =>
  isStale(self) ? 'stale' : count === 0 ? 'empty' : 'ready';

/** One open dataset: the connection, the table, and which tree they came from. */
interface OpenIndex {
  readonly identity: string;
  readonly db: Connection;
  readonly table: Table;
}

/**
 * Which TREE the cached handle is holding — inode and newest mtime together.
 * `buildLanceDbIndex` removes and recreates the directory, so a live adapter
 * would otherwise keep answering from the superseded dataset forever.
 */
const identityOf = (indexDir: string): string =>
  `${statSync(indexDir).ino}:${newestTreeMs(indexDir)}`;

const openIndex = async (lance: LanceModule, indexDir: string): Promise<OpenIndex> => {
  const db = await lance.connect(indexDir);
  const table = await db.openTable(TABLE_NAME);
  return { identity: identityOf(indexDir), db, table };
};

/**
 * The one mutable cell in this module: the open dataset being amortized across
 * calls. Connecting and opening the table is REAL per-call cost, and paying it
 * inside `retrieve` would make the benchmark's warm regime a second measurement
 * of the cold regime.
 *
 * `opening` is the SINGLE-FLIGHT guard. Without it, two callers arriving before
 * the first open finished each saw an empty `open` and each entered `reopen`,
 * whose `release` closes the connection its sibling is mid-use on — the loser's
 * handle is orphaned and its query answers from a closed dataset. Every caller
 * that arrives while an open is in flight now awaits that SAME promise, so the
 * cell can hold at most one connection at a time.
 */
interface HandleCell {
  open: OpenIndex | undefined;
  opening: Promise<OpenIndex> | undefined;
}

const release = (cell: HandleCell): void => {
  cell.open?.db.close();
  cell.open = undefined;
};

/** The in-flight open landed: it becomes the cell's handle and stops being shared. */
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

/**
 * Publishes the in-flight promise BEFORE it can settle — the assignment happens
 * in the same synchronous turn as the `openIndex` call, so no caller can slip
 * between the two and start a second open.
 */
const reopen = (
  cell: HandleCell,
  lance: LanceModule,
  indexDir: string
): Promise<OpenIndex> => {
  release(cell);
  const opening = openIndex(lance, indexDir).then(
    opened => settle(cell, opened),
    (error: unknown) => forget(cell, error)
  );
  cell.opening = opening;
  return opening;
};

const acquire = (
  cell: HandleCell,
  lance: LanceModule,
  indexDir: string
): Promise<OpenIndex> => {
  const current = cell.open;
  return current !== undefined && current.identity === identityOf(indexDir)
    ? Promise.resolve(current)
    : cell.opening ?? reopen(cell, lance, indexDir);
};

/**
 * A directory that exists but holds no `atoms` table means no search can run —
 * `undefined` here becomes `unavailable`, never `empty`. Narrowed to the OPEN
 * step on purpose: a failure inside the search itself is a real defect and MUST
 * still surface.
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

interface IndexSnapshot {
  readonly count: number;
  readonly atoms: readonly RetrievedAtom[];
}

/** One retrieval call's inputs, kept together so no helper takes four arguments. */
interface SearchRequest {
  readonly query: string;
  readonly opts: RetrieveOptions;
}

const queryRows = (
  table: Table,
  request: SearchRequest,
  limit: number
): Promise<readonly unknown[]> => {
  const match = toMatchExpression(request.query);
  return match === undefined
    ? Promise.resolve([])
    : table.query().fullTextSearch(match).limit(limit).toArray();
};

/** The candidate pool ONE fetch asks the engine for. */
const poolSize = (opts: RetrieveOptions): number => opts.k * FTS_OVERFETCH_FACTOR;

/**
 * Whether the request narrows the pool AFTER the engine truncated it. That is
 * the only shape that can starve — every domain/type survivor may rank below the
 * first `k * FTS_OVERFETCH_FACTOR` rows — and therefore the only shape that
 * escalates. An unfiltered query takes exactly one fetch of exactly the old
 * size, so every recorded benchmark row re-runs byte-identically.
 */
const isFiltered = (opts: RetrieveOptions): boolean =>
  opts.domain !== undefined || opts.types !== undefined;

/**
 * Widen the candidate pool until the answer is settled — `k` survivors are held,
 * or the engine returned fewer rows than asked for and so has no more to give.
 * Same contract as `readUntilSettled` in the FTS5 adapter, which walks rows
 * instead of pools because SQLite hands it the whole ranked list at once; here
 * the engine owns the truncation, so the pool is what grows.
 */
interface PoolWalk {
  readonly index: OpenIndex;
  readonly request: SearchRequest;
  readonly limit: number;
}

const readUntilSettled = async (
  options: LanceDbAdapterOptions,
  walk: PoolWalk
): Promise<readonly RetrievedAtom[]> => {
  const rows = await queryRows(walk.index.table, walk.request, walk.limit);
  const atoms = selectAtoms(options, rows, walk.request.opts);
  return atoms.length >= walk.request.opts.k || rows.length < walk.limit
    ? atoms
    : readUntilSettled(options, { ...walk, limit: walk.limit * 2 });
};

const selectFromIndex = (
  options: LanceDbAdapterOptions,
  index: OpenIndex,
  request: SearchRequest
): Promise<readonly RetrievedAtom[]> =>
  isFiltered(request.opts)
    ? readUntilSettled(options, { index, request, limit: poolSize(request.opts) })
    : queryRows(index.table, request, poolSize(request.opts)).then(rows =>
        selectAtoms(options, rows, request.opts)
      );

const snapshotOf = async (
  options: LanceDbAdapterOptions,
  index: OpenIndex,
  request: SearchRequest
): Promise<IndexSnapshot> => ({
  count: await index.table.countRows(),
  atoms: await selectFromIndex(options, index, request),
});

/**
 * No index directory, no corpus root, no `atoms` table, or no dependency — all
 * of them mean NO search happened, so all of them report `unavailable` and never
 * `empty`. Conflating them is what lets a later evaluation measure nothing and
 * call it a null result.
 */
const UNAVAILABLE: RetrievalResult = {
  atoms: [],
  mode: LANCEDB_MODE,
  indexState: 'unavailable',
};

/** One adapter instance: its immutable options and the handle it amortizes. */
interface LanceDbInstance {
  readonly options: LanceDbAdapterOptions;
  readonly cell: HandleCell;
  readonly corpus: CorpusCell;
}

const describeResult = (self: LanceDbInstance, snapshot: IndexSnapshot): RetrievalResult => ({
  atoms: snapshot.atoms,
  mode: LANCEDB_MODE,
  indexState: resolveState(self, snapshot.count),
});

const search = async (
  self: LanceDbInstance,
  lance: LanceModule,
  request: SearchRequest
): Promise<RetrievalResult> => {
  const index = await openOrSkip(self.cell, lance, self.options.indexDir);
  return index === undefined
    ? UNAVAILABLE
    : describeResult(self, await snapshotOf(self.options, index, request));
};

const canSearch = (options: LanceDbAdapterOptions): boolean =>
  existsSync(options.indexDir) && existsSync(options.atomsDir);

const retrieveFrom = async (
  self: LanceDbInstance,
  request: SearchRequest
): Promise<RetrievalResult> => {
  const loaded = await loadLance();
  return loaded.ok && canSearch(self.options)
    ? search(self, loaded.lance, request)
    : UNAVAILABLE;
};

/**
 * Build a port reading the dataset at `options.indexDir` over
 * `options.atomsDir`.
 *
 * The dataset is opened LAZILY, on first use, and reused for the life of this
 * instance — so an index built after the instance exists is still found,
 * `unavailable` never becomes a sticky verdict, and a rebuild is picked up on
 * the very next retrieve. Call `close()` when done; calling it twice is
 * harmless.
 */
export const createLanceDbAdapter = (options: LanceDbAdapterOptions): KnowledgePort => {
  const self: LanceDbInstance = {
    options,
    cell: { open: undefined, opening: undefined },
    corpus: { newestMs: undefined },
  };
  return {
    name: LANCEDB_MODE,
    retrieve: async (query: string, opts: RetrieveOptions): Promise<RetrievalResult> => {
      assertTypeFilter(opts.types);
      return await retrieveFrom(self, { query, opts });
    },
    close: (): void => release(self.cell),
  };
};
