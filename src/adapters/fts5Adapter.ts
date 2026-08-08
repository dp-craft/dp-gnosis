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
import { ATOM_DOMAINS, type AtomDomain } from '../config.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';
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
      fts.run(index + 1, entry.body);
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
 * different query. Terms are split on whitespace ONLY: `query.ts` owns
 * tokenization and an adapter MUST NOT re-tokenize.
 */
const escapeTerm = (term: string): string => `"${term.replaceAll('"', '""')}"`;

/**
 * Disjunction, not FTS5's implicit AND: a `buildQuery` string carries up to 32
 * distilled terms, and requiring all of them would match nothing. `undefined`
 * for a term-free query — an empty `MATCH` is a syntax error.
 */
const toMatchExpression = (query: string): string | undefined => {
  const terms = query.split(WHITESPACE_RE).filter(term => term.length > 0);
  return terms.length === 0 ? undefined : terms.map(escapeTerm).join(' OR ');
};

const newestCorpusMs = (atomsDir: string): number =>
  existsSync(atomsDir)
    ? markdownPaths(atomsDir)
        .map(rel => statSync(resolve(atomsDir, rel)).mtimeMs)
        .reduce((max, ms) => Math.max(max, ms), statSync(atomsDir).mtimeMs)
    : 0;

const isStale = (options: Fts5AdapterOptions): boolean =>
  newestCorpusMs(options.atomsDir) > statSync(options.indexPath).mtimeMs;

/**
 * `stale` outranks `empty`: an index that both lags the corpus and holds nothing
 * is lagging, and saying `empty` would claim the corpus is genuinely empty.
 */
const resolveState = (options: Fts5AdapterOptions, count: number): IndexState =>
  isStale(options) ? 'stale' : count === 0 ? 'empty' : 'ready';

/** Score flips sign so larger is better, matching the port's `score DESC` order. */
const fromAtom = (atom: Atom, row: IndexRow, sourcePath: string): RetrievedAtom | undefined => {
  const domain = asDomain(atom.frontmatter.x_domain);
  return domain === undefined
    ? undefined
    : {
        id: row.id,
        title: atom.frontmatter.title,
        domain,
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

const selectAtoms = (
  options: Fts5AdapterOptions,
  rows: readonly IndexRow[],
  opts: RetrieveOptions
): readonly RetrievedAtom[] =>
  rows
    .map(row => readRow(options, row))
    .filter(isDefined)
    .filter(atom => matchDomain(atom, opts.domain))
    .sort(byScoreThenId)
    .slice(0, opts.k);

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
}

const search = (self: Fts5Instance, query: string, opts: RetrieveOptions): RetrievalResult => {
  const snapshot = self.handle.snapshot(self.options.indexPath, toMatchExpression(query));
  return {
    atoms: selectAtoms(self.options, snapshot.rows, opts),
    mode: FTS5_MODE,
    indexState: resolveState(self.options, snapshot.count),
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
  const self: Fts5Instance = { options, handle: createIndexHandle() };
  return {
    name: FTS5_MODE,
    retrieve: (query: string, opts: RetrieveOptions): Promise<RetrievalResult> =>
      Promise.resolve(retrieveFrom(self, query, opts)),
    close: self.handle.close,
  };
};
