/**
 * A SQLite FTS5 `KnowledgePort`: BM25 lexical retrieval over the atom vault.
 *
 * SCHEMA — resolved against the engine (SQLite 3.53.2, better-sqlite3 12.11.1),
 * not against the plan's prose, because the two obvious readings both fail:
 *
 * - "external content" (`content='atoms'`) means FTS5 reads column values back
 *   from a REAL SQL content table. Here the text lives in markdown FILES, so
 *   there is no such table to point at; pointing at one would require storing
 *   the bodies in SQL, which is exactly what is forbidden (measured when bodies
 *   were stored: +261 MB heap and a 14x query slowdown).
 * - a fully contentless table (`content=''`) with an `id UNINDEXED` column also
 *   fails: measured, `SELECT id FROM t WHERE t MATCH 'zustand'` returns NULL,
 *   because a contentless table stores no column values at all — the join key
 *   would be lost.
 *
 * So the shape used is: an ORDINARY table `atom_meta(rowid, id, path)` carrying
 * the join key and the file location, joined by `rowid` to a CONTENTLESS FTS5
 * table indexing the body. Nothing but the inverted index holds body text, and
 * the body handed to a caller is re-read from disk at call time (port rule).
 *
 * TRIGGERS — deliberately none. AI/AU/AD triggers exist to keep an FTS5 index in
 * sync with an SQL content table; a contentless table has no content table to
 * sync, and `atom_meta` holds no indexed text. The index is rebuilt wholesale
 * from `atomsDir`, which is also what makes it byte-reproducible.
 *
 * `detail=full` — RECORDED CHOICE. `detail=none` shrinks the index by ~92% but
 * measured here it makes phrase queries fail outright ("fts5: phrase queries are
 * not supported (detail!=full)"), and it likewise drops NEAR and column filters.
 * Size is bought back by never storing bodies; query capability is not
 * recoverable without a rebuild, so capability wins.
 *
 * TOKENIZER stays `unicode61` (the FTS5 default) — RECORDED CHOICE. FTS5 ships a
 * free `porter` tokenizer, and binding it here would be the cheap way to satisfy
 * the inflection case. It is refused: that is a DIFFERENT Porter implementation
 * from the one every other adapter uses, so this adapter would stem by its own
 * rules and `--adapter` would stop being a comparison of retrieval. Instead the
 * text is stemmed through the package-wide `stemText` (`query.ts`) BEFORE it is
 * inserted, and every query chunk is stemmed before it reaches `MATCH` — one
 * stemmer, both sides, shared with every other adapter.
 *
 * NO `prefix=` index — RECORDED CHOICE AND TRAP. `buildQuery` (`query.ts`) emits
 * plain terms only, so a prefix index would index nothing anyone asks for. If a
 * future query builder ever emits `term*`, a prefix query against a table
 * without a prefix index measured ~256 MB peak allocation and roughly a 1000x
 * slowdown — add `prefix=` in the SAME change that starts emitting `term*`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

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
import { stemText } from '../query.js';
import { isRetrievable } from '../retrievability.js';

/** `mode`/`name` reported by this adapter. */
const FTS5_MODE = 'fts5';

const MARKDOWN_EXT = '.md';

const CREATE_META_SQL =
  'CREATE TABLE atom_meta(rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, path TEXT NOT NULL)';
const CREATE_FTS_SQL =
  'CREATE VIRTUAL TABLE atom_fts USING fts5(body, content=\'\', detail=full)';
const INSERT_META_SQL = 'INSERT INTO atom_meta(rowid, id, path) VALUES (?, ?, ?)';
const INSERT_FTS_SQL = 'INSERT INTO atom_fts(rowid, body) VALUES (?, ?)';
const COUNT_META_SQL = 'SELECT COUNT(*) AS n FROM atom_meta';
/**
 * `bm25()` returns MORE NEGATIVE for a better match, so plain ascending order is
 * best-first. Bare `bm25()` ordering is NOT deterministic — two rows can hold
 * identical scores — hence the `rowid` tiebreak here, and the port's own
 * `(score DESC, atomId ASC)` tiebreak afterwards so this adapter orders
 * identically to every other adapter.
 */
const SEARCH_SQL =
  'SELECT m.id AS id, m.path AS path, bm25(atom_fts) AS rank FROM atom_fts ' +
  'JOIN atom_meta m ON m.rowid = atom_fts.rowid WHERE atom_fts MATCH ? ' +
  'ORDER BY bm25(atom_fts), m.rowid';

const WHITESPACE_RE = /\s+/;

/** Options for a full index rebuild. */
export interface BuildFts5IndexOptions {
  /** Curated atoms root. MUST NOT be pointed at the proposals root. */
  readonly atomsDir: string;
  /** Destination index file; its parent directory is created if absent. */
  readonly indexPath: string;
}

/** Options for one adapter instance. */
export interface Fts5AdapterOptions extends BuildFts5IndexOptions {
  /** Injected clock for `isRetrievable`; never read from inside. */
  readonly now: Date;
}

interface IndexEntry {
  readonly id: string;
  readonly path: string;
  readonly body: string;
}

interface IndexRow {
  readonly id: string;
  readonly path: string;
  readonly rank: number;
}

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
const toEntry = (atomsDir: string, rel: string): IndexEntry | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, rel), 'utf8'));
  return parsed.ok && asDomain(parsed.atom.frontmatter.x_domain) !== undefined
    ? { id: parsed.atom.frontmatter.id, path: rel, body: parsed.atom.body }
    : undefined;
};

/** Sorted by relative path, so rowids — and therefore ranking — are reproducible. */
const collectEntries = (atomsDir: string): readonly IndexEntry[] =>
  markdownPaths(atomsDir)
    .map(rel => toEntry(atomsDir, rel))
    .filter(isDefined);

const writeEntries = (db: Database.Database, entries: readonly IndexEntry[]): void => {
  const meta = db.prepare(INSERT_META_SQL);
  const fts = db.prepare(INSERT_FTS_SQL);
  db.transaction(() =>
    entries.forEach((entry, index) => {
      meta.run(index + 1, entry.id, entry.path);
      // INDEX SIDE of the shared stemmer: `unicode61` then tokenizes text that
      // is already stems, so the inverted index holds the same terms the linear
      // scan computes in memory.
      fts.run(index + 1, stemText(entry.body));
    })
  )();
};

/**
 * Rebuild the index wholesale from `atomsDir`. Wholesale rather than
 * incremental because reproducibility is the property under test: the same
 * corpus MUST produce the same rowids and therefore the same ranking, whatever
 * order the files were created in.
 */
export const buildFts5Index = (options: BuildFts5IndexOptions): void => {
  const entries = collectEntries(options.atomsDir);
  rmSync(options.indexPath, { force: true });
  mkdirSync(dirname(options.indexPath), { recursive: true });
  const db = new Database(options.indexPath);
  db.exec(CREATE_META_SQL);
  db.exec(CREATE_FTS_SQL);
  writeEntries(db, entries);
  db.close();
};

/**
 * Every term is wrapped in an FTS5 string literal (inner `"` doubled). Without
 * it a technical term carrying `-`, `*`, `:` or `^` is parsed as FTS5 SYNTAX and
 * either throws (`adr-018` → "no such column: 018") or silently becomes a
 * different query.
 */
const escapeTerm = (term: string): string => `"${term.replaceAll('"', '""')}"`;

/**
 * QUERY SIDE of the shared stemmer. The query is still split on whitespace ONLY
 * — `query.ts` owns tokenization and an adapter MUST NOT re-tokenize — but each
 * whitespace chunk is then run through the package-wide `stemText`, so it
 * carries the same stems the index holds. A chunk whose characters are all
 * FTS5 syntax (a lone `"`) stems to the empty string and is dropped rather than
 * emitted as an empty literal.
 *
 * Stemming a chunk keeps its internal token ORDER, so a multi-token chunk such
 * as `adr-018` stays the adjacency-requiring phrase `"adr 018"` it already was
 * — the stemmer changes the terms, never the query's shape.
 *
 * Disjunction, not FTS5's implicit AND: a `buildQuery` string carries up to 32
 * distilled terms, and requiring all of them would match nothing. `undefined`
 * for a term-free query — an empty `MATCH` is a syntax error.
 */
const toMatchExpression = (query: string): string | undefined => {
  const phrases = query.split(WHITESPACE_RE).map(stemText).filter(phrase => phrase.length > 0);
  return phrases.length === 0 ? undefined : phrases.map(escapeTerm).join(' OR ');
};

const newestCorpusMs = (atomsDir: string): number =>
  existsSync(atomsDir)
    ? markdownPaths(atomsDir)
        .map(rel => statSync(resolve(atomsDir, rel)).mtimeMs)
        .reduce((max, ms) => Math.max(max, ms), statSync(atomsDir).mtimeMs)
    : 0;

/**
 * The corpus-newest-mtime sweep, sampled AT MOST ONCE per adapter instance.
 *
 * MEASURED over the 43 228-atom corpus: one retrieve cost ~710 ms and ~700 ms of
 * that was this sweep — it lists every markdown file under `atomsDir` and
 * `stat`s each one (43 228 stat calls per query) solely to label `indexState`,
 * which changes neither which atoms come back nor their order. The evidence it
 * dominates: latency was FLAT IN K (821/799/798 ms for k=1/10/50), FLAT IN MATCH
 * COUNT (a 0-row query cost the same as a 35 838-row one) and scaled with CORPUS
 * SIZE (11 522 atoms → 268 ms, 43 228 → 881 ms), while SQLite itself answered
 * COUNT(*) in 0 ms and the full MATCH+bm25 query in 5.7 ms for 3 869 rows.
 *
 * RECORDED DECISION: the corpus is FIXED for the lifetime of a process — ANY
 * markdown change requires a RESTART — so the sweep runs lazily on the first
 * retrieve that needs it and every later retrieve on that instance reuses the
 * verdict. The cell hangs off the INSTANCE, never a module-global cache: two
 * adapters over different atom dirs in one process MUST NOT share a verdict.
 *
 * Only this corpus-wide sweep is cached. Body, title and retrievability are
 * still read from disk per row on every call, so an edit still lands at once in
 * what is RETURNED — it just no longer moves the reported `indexState`.
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

const isStale = (self: Fts5Instance): boolean =>
  acquireCorpusMs(self.corpus, self.options.atomsDir) >
  statSync(self.options.indexPath).mtimeMs;

/**
 * `stale` outranks `empty`: an index that both lags the corpus and holds nothing
 * is lagging, and saying `empty` would claim the corpus is genuinely empty.
 */
const resolveState = (self: Fts5Instance, count: number): IndexState =>
  isStale(self) ? 'stale' : count === 0 ? 'empty' : 'ready';

/** Score flips sign so larger is better, matching the port's `score DESC` order. */
const fromAtom = (atom: Atom, row: IndexRow, sourcePath: string): RetrievedAtom | undefined => {
  const domain = asDomain(atom.frontmatter.x_domain);
  return domain === undefined
    ? undefined
    : {
        id: row.id,
        title: atom.frontmatter.title,
        domain,
        type: asType(atom.frontmatter.type),
        body: atom.body,
        score: -row.rank,
        sourcePath,
      };
};

/** Body, title and retrievability come from DISK, so an edit lands immediately. */
const readRow = (options: Fts5AdapterOptions, row: IndexRow): RetrievedAtom | undefined => {
  const sourcePath = resolve(options.atomsDir, row.path);
  const parsed = existsSync(sourcePath)
    ? parseAtom(readFileSync(sourcePath, 'utf8'))
    : { ok: false as const, error: 'missing' };
  return parsed.ok && isRetrievable(parsed.atom.frontmatter, options.now)
    ? fromAtom(parsed.atom, row, sourcePath)
    : undefined;
};

const byScoreThenId = (a: RetrievedAtom, b: RetrievedAtom): number =>
  b.score - a.score || compareStrings(a.id, b.id);

const matchDomain = (atom: RetrievedAtom, domain: AtomDomain | undefined): boolean =>
  domain === undefined || atom.domain === domain;

const matchType = (atom: RetrievedAtom, type: AtomType | undefined): boolean =>
  type === undefined || atom.type === type;

/** One row read from disk, kept only if it survives both filters. */
const survivorOf = (
  options: Fts5AdapterOptions,
  row: IndexRow,
  opts: RetrieveOptions
): RetrievedAtom | undefined => {
  const atom = readRow(options, row);
  return atom !== undefined && matchDomain(atom, opts.domain) && matchType(atom, opts.type)
    ? atom
    : undefined;
};

/** The rank of the k-th survivor held so far, or `undefined` before k exist. */
const kthRank = (kept: readonly RetrievedAtom[], k: number): number | undefined => {
  const kth = kept[k - 1];
  return kth === undefined ? undefined : -kth.score;
};

/** Settled: k survivors are held AND this row cannot tie the k-th one. */
const isSettled = (kept: readonly RetrievedAtom[], k: number, rank: number): boolean =>
  kept.length >= k && rank !== kthRank(kept, k);

/**
 * Walk the rows in rank order and stop as soon as the answer is settled.
 *
 * MEASURED before this walk existed, over a 43 228-atom corpus: retrieval was
 * p50 881 ms / p95 2714 ms and FLAT IN k — 821/799/798 ms for k=1/10/50 on one
 * query, 1431/1447/1498 ms on a stopword query. Every matching row was read
 * from disk (`readRow` = `readFileSync` + `parseAtom`) BEFORE `.slice(0, k)`,
 * so a query matching 20 000 atoms performed 20 000 file reads to return 10.
 *
 * `SEARCH_SQL` already orders best-match-first, so once k survivors are held
 * every later row is at least as bad as the k-th. Only a row TIED with the
 * k-th could still displace it through the `(score DESC, id ASC)` tie-break —
 * hence the rank comparison, which keeps the returned list byte-identical to
 * the full scan. A `for` loop with an early `break` is the shape here because
 * short-circuiting the I/O is the entire point.
 */
const readUntilSettled = (
  options: Fts5AdapterOptions,
  rows: readonly IndexRow[],
  opts: RetrieveOptions
): readonly RetrievedAtom[] => {
  const kept: RetrievedAtom[] = [];
  for (const row of rows) {
    if (isSettled(kept, opts.k, row.rank)) break;
    const atom = survivorOf(options, row, opts);
    if (atom !== undefined) kept.push(atom);
  }
  return kept;
};

const selectAtoms = (
  options: Fts5AdapterOptions,
  rows: readonly IndexRow[],
  opts: RetrieveOptions
): readonly RetrievedAtom[] =>
  [...readUntilSettled(options, rows, opts)].sort(byScoreThenId).slice(0, opts.k);

interface IndexSnapshot {
  readonly count: number;
  readonly rows: readonly IndexRow[];
}

/** One open index file plus its already-prepared statements. */
interface OpenIndex {
  readonly identity: string;
  readonly db: Database.Database;
  readonly count: Database.Statement;
  readonly search: Database.Statement;
}

/**
 * Which FILE the cached handle is holding — inode, mtime and size together.
 * `buildFts5Index` unlinks and recreates the index, so a live adapter would
 * otherwise keep reading the deleted inode: an index rebuilt under a running
 * instance would go permanently invisible to it. Comparing identity per call
 * means a rebuild is picked up on the very next retrieve, and a `stat` is
 * cheaper than the open + prepare it guards.
 */
const identityOf = (indexPath: string): string => {
  const info = statSync(indexPath);
  return `${info.ino}:${info.mtimeMs}:${info.size}`;
};

const openIndex = (indexPath: string): OpenIndex => {
  const db = new Database(indexPath, { readonly: true });
  return {
    identity: identityOf(indexPath),
    db,
    count: db.prepare(COUNT_META_SQL),
    search: db.prepare(SEARCH_SQL),
  };
};

/**
 * The per-instance index handle. Opening the database and preparing its
 * statements is REAL per-call cost: doing it inside `retrieve` made the
 * benchmark's warm regime a second measurement of the cold regime, which is the
 * one comparison the harness exists to make.
 *
 * The single mutable cell is deliberate and contained: it is the only way a
 * closure can amortize a resource across calls without a process-global cache
 * keyed by path, which would outlive the instance that owns it.
 */
interface IndexHandle {
  readonly snapshot: (indexPath: string, match: string | undefined) => IndexSnapshot;
  readonly close: () => void;
}

/** The one mutable cell in this module: the handle being amortized. */
interface HandleCell {
  open: OpenIndex | undefined;
}

const release = (cell: HandleCell): void => {
  cell.open?.db.close();
  cell.open = undefined;
};

const reopen = (cell: HandleCell, indexPath: string): OpenIndex => {
  release(cell);
  const opened = openIndex(indexPath);
  cell.open = opened;
  return opened;
};

const acquire = (cell: HandleCell, indexPath: string): OpenIndex => {
  const current = cell.open;
  return current !== undefined && current.identity === identityOf(indexPath)
    ? current
    : reopen(cell, indexPath);
};

const snapshotOf = (index: OpenIndex, match: string | undefined): IndexSnapshot => ({
  count: (index.count.get() as { readonly n: number }).n,
  rows: match === undefined ? [] : (index.search.all(match) as readonly IndexRow[]),
});

const createIndexHandle = (): IndexHandle => {
  const cell: HandleCell = { open: undefined };
  return {
    close: (): void => release(cell),
    snapshot: (indexPath: string, match: string | undefined): IndexSnapshot =>
      snapshotOf(acquire(cell, indexPath), match),
  };
};

/** One adapter instance: its immutable options and the handle it amortizes. */
interface Fts5Instance {
  readonly options: Fts5AdapterOptions;
  readonly handle: IndexHandle;
  readonly corpus: CorpusCell;
}

const search = (self: Fts5Instance, query: string, opts: RetrieveOptions): RetrievalResult => {
  const snapshot = self.handle.snapshot(self.options.indexPath, toMatchExpression(query));
  return {
    atoms: selectAtoms(self.options, snapshot.rows, opts),
    mode: FTS5_MODE,
    indexState: resolveState(self, snapshot.count),
  };
};

/**
 * A missing index file reports `unavailable` with NO atoms — never `empty`.
 * Conflating "no search happened" with "searched and found nothing" is what
 * lets a later evaluation measure nothing and report a clean null result.
 */
const retrieveFrom = (
  self: Fts5Instance,
  query: string,
  opts: RetrieveOptions
): RetrievalResult =>
  existsSync(self.options.indexPath)
    ? search(self, query, opts)
    : { atoms: [], mode: FTS5_MODE, indexState: 'unavailable' };

/**
 * Build a port reading the index at `options.indexPath` over `options.atomsDir`.
 *
 * The database is opened LAZILY, on first use, and reused for the life of this
 * instance — so an index created after the instance exists is still found, and
 * `unavailable` never becomes a sticky verdict. Call `close()` when done.
 */
export const createFts5Adapter = (options: Fts5AdapterOptions): KnowledgePort => {
  const self: Fts5Instance = {
    options,
    handle: createIndexHandle(),
    corpus: { newestMs: undefined },
  };
  return {
    name: FTS5_MODE,
    retrieve: (query: string, opts: RetrieveOptions): Promise<RetrievalResult> =>
      Promise.resolve(retrieveFrom(self, query, opts)),
    close: self.handle.close,
  };
};
