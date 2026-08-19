/**
 * A MiniSearch `KnowledgePort`: a pure-JavaScript inverted index over the atom
 * vault, persisted as JSON.
 *
 * WHY THIS ADAPTER EXISTS — it is measured for its LOAD-vs-QUERY cost profile,
 * not for a different ranking function. MiniSearch holds the whole index in
 * memory, so a cold process pays a deserialization cost the FTS5 adapter never
 * pays, while a warm process amortizes it over N queries. That is the one
 * comparison the benchmark makes, so the index is SERIALIZED to disk
 * (`toJSON` / `loadJSON`) and loaded, never rebuilt in memory per process:
 * rebuilding would measure indexing, not loading.
 *
 * LAZY DYNAMIC IMPORT — `minisearch` is an `optionalDependency`, so it may be
 * absent. It is imported inside the call path, and EVERY import error is caught,
 * not just `MODULE_NOT_FOUND`: a transitive or native failure surfaces as a
 * different error class, and a narrow catch would hard-fail the whole suite
 * instead of skipping this one leg. `miniSearchAvailability` exposes the reason
 * so the harness can REPORT the skip rather than swallow it.
 *
 * STEMMING — `stemTerm` from `query.ts` is the SHARED English stemmer every
 * adapter applies, wired here through MiniSearch's `processTerm`, which the
 * library applies index-side and query-side alike. MiniSearch's own bundled
 * term processing is deliberately NOT used: a second stemmer implementation
 * would be an unnamed confound that invalidates the whole comparison. The
 * package tokenizer is likewise replaced by the shared `tokenize`.
 *
 * DETERMINISM — MiniSearch's internal document ids follow INSERTION order, so
 * two equally-scored atoms would otherwise rank by whichever file the
 * filesystem listed first. Entries are inserted in sorted relative-path order
 * AND the results carry the port-wide explicit `(score DESC, atomId ASC)`
 * tiebreak, so a corpus rebuilt from files created in a different order ranks
 * byte-identically.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import type MiniSearch from 'minisearch';
import type { Options } from 'minisearch';

import { type Atom, parseAtom } from '../atom.js';
import {
  ATOM_DOMAINS,
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
import { stemTerm, type TermProcessor, tokenize } from '../query.js';
import { isRetrievable } from '../retrievability.js';

/** `mode`/`name` reported by this adapter. */
const MINISEARCH_MODE = 'minisearch';

const MARKDOWN_EXT = '.md';

/** The one indexed field, the join key, and the one stored field. */
const BODY_FIELD = 'body';
const ID_FIELD = 'id';
const PATH_FIELD = 'path';

/** Options for a full index rebuild. */
export interface BuildMiniSearchIndexOptions {
  /** Curated atoms root. MUST NOT be pointed at the proposals root. */
  readonly atomsDir: string;
  /** Destination index file; its parent directory is created if absent. */
  readonly indexPath: string;
  /**
   * Term normalizer applied index-side and query-side. Defaults to the SHARED
   * `stemTerm`; a caller overriding it MUST pass the same processor to the
   * adapter, or the two sides drift and the index stops answering its own query.
   */
  readonly processTerm?: TermProcessor;
}

/** Options for one adapter instance. */
export interface MiniSearchAdapterOptions extends BuildMiniSearchIndexOptions {
  /** Injected clock for `isRetrievable`; never read from inside. */
  readonly now: Date;
}

/** Whether the optional dependency loaded, and why it did not. */
export interface MiniSearchAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

type MiniSearchIndex = MiniSearch<IndexDoc>;

/**
 * Exactly the surface this adapter uses, stated structurally so the module's
 * default export is checked against it rather than re-declared.
 */
interface MiniSearchCtor {
  new (options: Options<IndexDoc>): MiniSearchIndex;
  loadJSON(json: string, options: Options<IndexDoc>): MiniSearchIndex;
}

type LoadResult =
  | { readonly ok: true; readonly ctor: MiniSearchCtor }
  | { readonly ok: false; readonly reason: string };

interface IndexDoc {
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
 * The ONLY place `minisearch` is loaded. Both settlement paths are handled, so
 * an import that rejects for ANY reason yields a reportable skip rather than a
 * throw that would take the caller down with it.
 */
const loadMiniSearch = (): Promise<LoadResult> =>
  import('minisearch').then(
    (module): LoadResult => ({ ok: true, ctor: module.default }),
    (error: unknown): LoadResult => ({ ok: false, reason: describeError(error) })
  );

/** Probe the optional dependency so a harness can report WHY a leg was skipped. */
export const miniSearchAvailability = async (): Promise<MiniSearchAvailability> => {
  const loaded = await loadMiniSearch();
  return loaded.ok ? { available: true } : { available: false, reason: loaded.reason };
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const asDomain = (value: string): AtomDomain | undefined =>
  ATOM_DOMAINS.find(domain => domain === value);

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

/** A file outside the closed frontmatter subset or domain vocabulary is SKIPPED. */
const toDoc = (atomsDir: string, rel: string): IndexDoc | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, rel), 'utf8'));
  return parsed.ok && asDomain(parsed.atom.frontmatter.x_domain) !== undefined
    ? { id: parsed.atom.frontmatter.id, path: rel, body: parsed.atom.body }
    : undefined;
};

/** Sorted by relative path, so INSERTION order — and therefore ranking — is reproducible. */
const collectDocs = (atomsDir: string): readonly IndexDoc[] =>
  markdownPaths(atomsDir)
    .map(rel => toDoc(atomsDir, rel))
    .filter(isDefined);

const processTermOf = (options: BuildMiniSearchIndexOptions): TermProcessor =>
  options.processTerm ?? stemTerm;

/**
 * The index options, which `loadJSON` needs to match the ones used at build
 * time — functions are not serialized, so they are re-supplied on every load.
 * Bodies are NOT stored: only `path` is, and the body handed to a caller is
 * re-read from disk at call time (port rule).
 */
const indexOptions = (options: BuildMiniSearchIndexOptions): Options<IndexDoc> => ({
  fields: [BODY_FIELD],
  storeFields: [PATH_FIELD],
  idField: ID_FIELD,
  tokenize: (text: string): string[] => [...tokenize(text)],
  processTerm: processTermOf(options),
});

const writeIndex = (ctor: MiniSearchCtor, options: BuildMiniSearchIndexOptions): true => {
  const index = new ctor(indexOptions(options));
  index.addAll(collectDocs(options.atomsDir));
  rmSync(options.indexPath, { force: true });
  mkdirSync(dirname(options.indexPath), { recursive: true });
  writeFileSync(options.indexPath, JSON.stringify(index), 'utf8');
  return true;
};

/**
 * Rebuild the index wholesale from `atomsDir` and persist it. Returns `false`
 * — never throws — when the optional dependency is unavailable, so a caller
 * skips this leg instead of failing.
 */
export const buildMiniSearchIndex = async (
  options: BuildMiniSearchIndexOptions
): Promise<boolean> => {
  const loaded = await loadMiniSearch();
  return loaded.ok ? writeIndex(loaded.ctor, options) : false;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? { ...value } : undefined;

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const numberField = (record: Readonly<Record<string, unknown>>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
};

/** `SearchResult` types `id` and its stored fields loosely, so they are GUARDED, never cast. */
const composeHit = (record: Readonly<Record<string, unknown>>): SearchHit | undefined => {
  const id = stringField(record, ID_FIELD);
  const path = stringField(record, PATH_FIELD);
  const score = numberField(record, 'score');
  return id !== undefined && path !== undefined && score !== undefined
    ? { id, path, score }
    : undefined;
};

const toHit = (value: unknown): SearchHit | undefined => {
  const record = asRecord(value);
  return record === undefined ? undefined : composeHit(record);
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
const readHit = (options: MiniSearchAdapterOptions, hit: SearchHit): RetrievedAtom | undefined => {
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
  options: MiniSearchAdapterOptions,
  hits: readonly unknown[],
  opts: RetrieveOptions
): readonly RetrievedAtom[] =>
  hits
    .map(toHit)
    .filter(isDefined)
    .map(hit => readHit(options, hit))
    .filter(isDefined)
    .filter(atom => matchDomain(atom, opts.domain))
    .filter(atom => matchType(atom, opts.types))
    .sort(byScoreThenId)
    .slice(0, opts.k);

const newestCorpusMs = (atomsDir: string): number =>
  markdownPaths(atomsDir)
    .map(rel => statSync(resolve(atomsDir, rel)).mtimeMs)
    .reduce((max, ms) => Math.max(max, ms), statSync(atomsDir).mtimeMs);

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
 * Only this corpus-wide sweep is cached; body, title and retrievability are
 * still read from disk per hit on every call.
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

const isStale = (self: MiniSearchInstance): boolean =>
  acquireCorpusMs(self.corpus, self.options.atomsDir) >
  statSync(self.options.indexPath).mtimeMs;

/**
 * `stale` outranks `empty`: an index that both lags the corpus and holds nothing
 * is lagging, and saying `empty` would claim the corpus is genuinely empty.
 */
const resolveState = (self: MiniSearchInstance, count: number): IndexState =>
  isStale(self) ? 'stale' : count === 0 ? 'empty' : 'ready';

/**
 * Which FILE the cached index was deserialized from — inode, mtime and size
 * together. `buildMiniSearchIndex` unlinks and rewrites the file, so a live
 * adapter would otherwise answer forever from the superseded snapshot. A `stat`
 * per call is far cheaper than the JSON load it guards.
 */
const identityOf = (indexPath: string): string => {
  const info = statSync(indexPath);
  return `${info.ino}:${info.mtimeMs}:${info.size}`;
};

interface LoadedIndex {
  readonly identity: string;
  readonly index: MiniSearchIndex;
}

/**
 * The one mutable cell in this module: the deserialized index being amortized
 * across calls. Deserializing inside `retrieve` would make the benchmark's warm
 * regime a second measurement of the cold regime, which is the one comparison
 * this adapter exists to inform.
 */
interface HandleCell {
  loaded: LoadedIndex | undefined;
}

const openIndex = (
  ctor: MiniSearchCtor,
  options: MiniSearchAdapterOptions
): LoadedIndex => ({
  identity: identityOf(options.indexPath),
  index: ctor.loadJSON(readFileSync(options.indexPath, 'utf8'), indexOptions(options)),
});

const acquire = (
  cell: HandleCell,
  ctor: MiniSearchCtor,
  options: MiniSearchAdapterOptions
): MiniSearchIndex => {
  const current = cell.loaded;
  const reused =
    current !== undefined && current.identity === identityOf(options.indexPath)
      ? current
      : openIndex(ctor, options);
  cell.loaded = reused;
  return reused.index;
};

/** One adapter instance: its immutable options and the handle it amortizes. */
interface MiniSearchInstance {
  readonly options: MiniSearchAdapterOptions;
  readonly cell: HandleCell;
  readonly corpus: CorpusCell;
}

/** One retrieval call's inputs, kept together so no helper takes four arguments. */
interface SearchRequest {
  readonly query: string;
  readonly opts: RetrieveOptions;
}

const search = (
  self: MiniSearchInstance,
  ctor: MiniSearchCtor,
  request: SearchRequest
): RetrievalResult => {
  const index = acquire(self.cell, ctor, self.options);
  return {
    atoms: selectAtoms(self.options, index.search(request.query), request.opts),
    mode: MINISEARCH_MODE,
    indexState: resolveState(self, index.documentCount),
  };
};

/**
 * No index file, no corpus root, or no dependency — all three mean NO search
 * happened, so all three report `unavailable` and never `empty`. Conflating
 * them is what lets a later evaluation measure nothing and call it a null
 * result.
 */
const UNAVAILABLE: RetrievalResult = {
  atoms: [],
  mode: MINISEARCH_MODE,
  indexState: 'unavailable',
};

const canSearch = (options: MiniSearchAdapterOptions): boolean =>
  existsSync(options.indexPath) && existsSync(options.atomsDir);

const retrieveFrom = async (
  self: MiniSearchInstance,
  request: SearchRequest
): Promise<RetrievalResult> => {
  const loaded = await loadMiniSearch();
  return loaded.ok && canSearch(self.options)
    ? search(self, loaded.ctor, request)
    : UNAVAILABLE;
};

/**
 * Build a port reading the persisted index at `options.indexPath` over
 * `options.atomsDir`.
 *
 * The index is deserialized LAZILY, on first use, and reused for the life of
 * this instance — so an index written after the instance exists is still found,
 * `unavailable` never becomes a sticky verdict, and a rebuild is picked up on
 * the very next retrieve. Call `close()` when done; calling it twice is
 * harmless.
 */
export const createMiniSearchAdapter = (options: MiniSearchAdapterOptions): KnowledgePort => {
  const self: MiniSearchInstance = {
    options,
    cell: { loaded: undefined },
    corpus: { newestMs: undefined },
  };
  return {
    name: MINISEARCH_MODE,
    retrieve: async (query: string, opts: RetrieveOptions): Promise<RetrievalResult> => {
      assertTypeFilter(opts.types);
      return await retrieveFrom(self, { query, opts });
    },
    close: (): void => {
      self.cell.loaded = undefined;
    },
  };
};
