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
 * text runs through a package-wide named analyzer (`analyzeToText`, `query.ts`)
 * BEFORE it is inserted, and every query chunk runs through the SAME named
 * analyzer before it reaches `MATCH`.
 *
 * ANALYZER SYMMETRY IS STRUCTURAL, not conventional. The chain's id is STAMPED
 * into `index_meta` in the same transaction that writes the rows, and the query
 * side reads it back off the file it opens — so no caller can pick a chain for
 * the query that differs from the one the index holds. An index predating the
 * stamp carries no `index_meta`; it reads as `porter-fold`, the only chain that
 * ever built one. An index stamped with an id outside `ANALYZERS` REFUSES.
 *
 * CORPUS IDENTITY IS STAMPED THE SAME WAY, and it is a REFUSAL rather than a
 * label: `schema_version` and `corpus_digest` go into `index_meta` in that same
 * transaction, and every retrieve compares the stamped digest with the one
 * `corpus-manifest.json` carries beside the atoms dir NOW. A disagreement, an
 * absent stamp beside a present manifest, or a schema version this build does
 * not read, each report `mismatched` with NO search — an index answered from
 * after the corpus moved is a ranking over content that is no longer there.
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
  ATOM_TYPES,
  type AtomDomain,
  type AtomType,
  DEFAULT_ATOM_TYPE
} from '../config.js';
import { CORPUS_MANIFEST_FILE, readManifestDigest } from '../corpusManifest.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';
import { assertDomainFilter, assertTypeFilter, atomOrigin } from '../port.js';
import {
  analyze,
  type AnalyzerId,
  ANALYZERS,
  analyzeToText,
  DEFAULT_ANALYZER,
  identifierTermOf
} from '../query.js';
import { isRetrievable } from '../retrievability.js';

/** `mode`/`name` reported by this adapter. */
const FTS5_MODE = 'fts5';

const MARKDOWN_EXT = '.md';

const CREATE_META_SQL =
  'CREATE TABLE atom_meta(rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, path TEXT NOT NULL)';
/**
 * INDEX-LEVEL facts, one row per key — deliberately NOT `atom_meta`, which is
 * per-atom: stamping the analyzer there would repeat it once per row and let
 * two rows disagree about which chain produced the index they share.
 */
const CREATE_INDEX_META_SQL = 'CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)';
const INSERT_INDEX_META_SQL = 'INSERT INTO index_meta(key, value) VALUES (?, ?)';
const SELECT_INDEX_META_SQL = 'SELECT value AS value FROM index_meta WHERE key = ?';
const HAS_INDEX_META_SQL =
  'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'index_meta\'';
/** The stamped key naming the analysis chain hop 7 used. */
const ANALYZER_KEY = 'analyzer';
/** The stamped key naming the SHAPE of the stamp itself. */
const SCHEMA_VERSION_KEY = 'schema_version';
/**
 * The stamped key naming WHICH CORPUS produced this index — the aggregate
 * digest `corpus-manifest.json` records beside the atoms dir.
 */
const CORPUS_DIGEST_KEY = 'corpus_digest';
/**
 * The stamp shape this build writes and this query side reads. A version outside
 * it REFUSES rather than being read optimistically: an unrecognised stamp means
 * the keys mean something this code has not been told, and guessing there is how
 * a stale index gets answered from.
 */
export const INDEX_SCHEMA_VERSION = '1';
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

/** Which corpus, and which index file over it. */
interface Fts5IndexLocation {
  /** Curated atoms root. MUST NOT be pointed at the proposals root. */
  readonly atomsDir: string;
  /** Destination index file; its parent directory is created if absent. */
  readonly indexPath: string;
}

/** Options for a full index rebuild. */
export interface BuildFts5IndexOptions extends Fts5IndexLocation {
  /**
   * The analysis chain hop 7 applies, STAMPED into the index it produces.
   * Absent means `DEFAULT_ANALYZER`; a pre-stamp index reads as `porter-fold`.
   */
  readonly analyzer?: AnalyzerId;
}

/**
 * Options for one adapter instance — deliberately NO `analyzer`. The query side
 * reads the chain back off the index it opens, so a caller cannot name one here
 * and silently analyze against an index built by a different chain.
 */
export interface Fts5AdapterOptions extends Fts5IndexLocation {
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

/** Sorted by relative path, so rowids — and therefore ranking — are reproducible. */
const collectEntries = (atomsDir: string): readonly IndexEntry[] =>
  markdownPaths(atomsDir)
    .map(rel => toEntry(atomsDir, rel))
    .filter(isDefined);

/** One `index_meta` row, as the build states it. */
interface StampRow {
  readonly key: string;
  readonly value: string;
}

/** What one build stamps into the index it produces. */
interface StampSpec {
  readonly analyzer: AnalyzerId;
  /**
   * `undefined` when no corpus manifest sits beside the atoms dir. NO row is
   * written then — an empty string would claim a corpus identity the build never
   * read, and the query side could not tell it from a real digest.
   */
  readonly corpusDigest: string | undefined;
}

const stampRows = (spec: StampSpec): readonly StampRow[] => [
  { key: ANALYZER_KEY, value: spec.analyzer },
  { key: SCHEMA_VERSION_KEY, value: INDEX_SCHEMA_VERSION },
  ...(spec.corpusDigest === undefined
    ? []
    : [{ key: CORPUS_DIGEST_KEY, value: spec.corpusDigest }]),
];

/**
 * The stamp is written inside the SAME transaction as the rows it describes, so
 * a build that dies part-way leaves no index claiming a chain or a corpus it
 * never applied: either both land or neither does.
 */
const writeEntries = (
  db: Database.Database,
  entries: readonly IndexEntry[],
  spec: StampSpec
): void => {
  const meta = db.prepare(INSERT_META_SQL);
  const fts = db.prepare(INSERT_FTS_SQL);
  const stamp = db.prepare(INSERT_INDEX_META_SQL);
  db.transaction(() => {
    stampRows(spec).forEach(row => stamp.run(row.key, row.value));
    entries.forEach((entry, index) => {
      meta.run(index + 1, entry.id, entry.path);
      // INDEX SIDE of the shared analyzer: `unicode61` then tokenizes text that
      // is already analyzed, so the inverted index holds the same terms the
      // linear scan computes in memory.
      fts.run(index + 1, analyzeToText(entry.body, spec.analyzer));
    });
  })();
};

/**
 * Rebuild the index wholesale from `atomsDir`. Wholesale rather than
 * incremental because reproducibility is the property under test: the same
 * corpus MUST produce the same rowids and therefore the same ranking, whatever
 * order the files were created in.
 *
 * Returns HOW MANY atoms were indexed. A build that reads a directory full of
 * atoms and writes zero rows is the project's worst failure shape — an index
 * that answers every query with nothing and reports success — so the count is
 * returned rather than discarded, and the caller gates on it.
 */
export const buildFts5Index = (options: BuildFts5IndexOptions): number => {
  const entries = collectEntries(options.atomsDir);
  rmSync(options.indexPath, { force: true });
  mkdirSync(dirname(options.indexPath), { recursive: true });
  const db = new Database(options.indexPath);
  db.exec(CREATE_META_SQL);
  db.exec(CREATE_FTS_SQL);
  db.exec(CREATE_INDEX_META_SQL);
  writeEntries(db, entries, {
    analyzer: options.analyzer ?? DEFAULT_ANALYZER,
    corpusDigest: readManifestDigest(options.atomsDir),
  });
  db.close();
  return entries.length;
};

/** A stamped id outside `ANALYZERS` REFUSES — a silent fallback would analyze
 * the query by a different chain than the index holds and publish the result
 * under the wrong label. */
const isAnalyzerId = (value: string): value is AnalyzerId => Object.keys(ANALYZERS).includes(value);

const asAnalyzer = (value: string): AnalyzerId => {
  if (isAnalyzerId(value)) return value;
  throw new Error(
    `fts5 index: unknown analyzer "${value}" — known analyzers are ${Object.keys(ANALYZERS).join(', ')}.`
  );
};

const hasIndexMeta = (db: Database.Database): boolean =>
  db.prepare(HAS_INDEX_META_SQL).get() !== undefined;

const stampValue = (db: Database.Database, key: string): string | undefined =>
  hasIndexMeta(db)
    ? (db.prepare(SELECT_INDEX_META_SQL).get(key) as { readonly value: string } | undefined)?.value
    : undefined;

/**
 * An index built before the stamp existed carries no `index_meta`. `porter-fold`
 * is the ONLY chain that ever produced one, so reading an absent stamp as that
 * chain is exact rather than a guess — and it neither throws nor rebuilds.
 */
/**
 * What a PRE-STAMP index was built by — a fixed chain, never `DEFAULT_ANALYZER`.
 * Those files were written before `index_meta` existed, and `porter-fold` is the
 * only chain that ever produced one; reading them under whatever the default has
 * since become would query them with terms their inverted index does not hold.
 */
const PRE_STAMP_ANALYZER: AnalyzerId = 'porter-fold';

const stampedAnalyzer = (db: Database.Database): AnalyzerId => {
  const value = stampValue(db, ANALYZER_KEY);
  return value === undefined ? PRE_STAMP_ANALYZER : asAnalyzer(value);
};

/**
 * The two INDEX-IDENTITY keys, read off the file being searched. Both are
 * `undefined` on a pre-stamp index, and that absence is itself the finding —
 * never defaulted to a value the build never wrote.
 */
interface IndexStamp {
  readonly schemaVersion: string | undefined;
  readonly corpusDigest: string | undefined;
}

const readStamp = (db: Database.Database): IndexStamp => ({
  schemaVersion: stampValue(db, SCHEMA_VERSION_KEY),
  corpusDigest: stampValue(db, CORPUS_DIGEST_KEY),
});

const REBUILD_REMEDY = `rebuild it with \`npm run gnosis -- index --adapter ${FTS5_MODE}\``;

const REFUSED = 'fts5 index: REFUSED, nothing was searched —';

/**
 * An unrecognised `schema_version` refuses on its own, BEFORE the digests are
 * compared: this build does not know what the other keys mean under that
 * version, so reading a digest out of it would compare two things it cannot
 * prove are the same measurement.
 */
const versionRefusal = (version: string | undefined): string | undefined =>
  version === undefined || version === INDEX_SCHEMA_VERSION
    ? undefined
    : `${REFUSED} its stamp schema_version is "${version}" and this build reads only "${INDEX_SCHEMA_VERSION}"; ${REBUILD_REMEDY}`;

const unstampedRefusal = (manifest: string): string =>
  `${REFUSED} the index carries NO ${CORPUS_DIGEST_KEY} stamp (it was built before the stamp existed), while ${CORPUS_MANIFEST_FILE} beside the atoms dir carries ${manifest}, so which corpus the index describes cannot be proved; ${REBUILD_REMEDY}`;

const driftRefusal = (stamped: string, manifest: string): string =>
  `${REFUSED} the stamped ${CORPUS_DIGEST_KEY} ${stamped} disagrees with ${manifest}, the digest ${CORPUS_MANIFEST_FILE} beside the atoms dir carries now — the index describes a different corpus; ${REBUILD_REMEDY}`;

/**
 * NO manifest beside the atoms dir means there is nothing to compare against,
 * which is not evidence of drift: a corpus ingested before the manifest existed,
 * or an atoms dir assembled by hand, MUST NOT be refused for a fact nobody
 * recorded. Every other combination is stated.
 */
const digestRefusal = (
  stamped: string | undefined,
  manifest: string | undefined
): string | undefined => {
  if (manifest === undefined) return undefined;
  if (stamped === undefined) return unstampedRefusal(manifest);
  return stamped === manifest ? undefined : driftRefusal(stamped, manifest);
};

const stampRefusal = (stamp: IndexStamp, manifest: string | undefined): string | undefined =>
  versionRefusal(stamp.schemaVersion) ?? digestRefusal(stamp.corpusDigest, manifest);

/**
 * Every term is wrapped in an FTS5 string literal (inner `"` doubled). Without
 * it a technical term carrying `-`, `*`, `:` or `^` is parsed as FTS5 SYNTAX and
 * either throws (`adr-018` → "no such column: 018") or silently becomes a
 * different query.
 */
const escapeTerm = (term: string): string => `"${term.replaceAll('"', '""')}"`;

/**
 * The disjuncts ONE raw token contributes. Off, and for a token analyzing to a
 * single term, that is the one literal it has always been. On, a multi-term run
 * contributes its terms AND the phrase — the phrase last, so the expression
 * reads as "these terms, and a bonus when they are adjacent".
 */
const disjunctsOf = (run: readonly string[], adjacency: boolean): readonly string[] =>
  adjacency && run.length > 1
    ? [...run.map(escapeTerm), escapeTerm(run.join(' '))]
    : [escapeTerm(run.join(' '))];

/** The one chain whose query side emits a whole-token alternative. */
const IDENT_ANALYZER: AnalyzerId = 'ident-porter-fold';

/**
 * The disjuncts one chunk contributes under `ident-porter-fold`.
 *
 * The chunk is analyzed with `porter-fold` — the PARTS chain — rather than with
 * the ident chain, because the ident chain flattens the whole-token term into
 * the same list as the parts and `disjunctsOf` would then weld them into one
 * nonsense phrase. An identifier-shaped chunk becomes a PARENTHESISED group:
 * the unstemmed whole-token literal OR whatever the chunk already emitted, so
 * an atom that spells the identifier whole and one that spells its parts both
 * match. Anything else is byte-identical to the non-ident path.
 */
const identDisjuncts = (chunk: string, adjacency: boolean): readonly string[] => {
  const parts = analyze(chunk, 'porter-fold');
  if (parts.length === 0) return [];
  const whole = identifierTermOf(chunk, parts);
  const inner = disjunctsOf(parts, adjacency);
  return whole === undefined ? inner : [`(${[escapeTerm(whole), ...inner].join(' OR ')})`];
};

const plainDisjuncts = (
  chunk: string,
  analyzer: AnalyzerId,
  adjacency: boolean
): readonly string[] => {
  const run = analyze(chunk, analyzer);
  return run.length === 0 ? [] : disjunctsOf(run, adjacency);
};

const chunkDisjuncts = (
  chunk: string,
  analyzer: AnalyzerId,
  adjacency: boolean
): readonly string[] =>
  analyzer === IDENT_ANALYZER
    ? identDisjuncts(chunk, adjacency)
    : plainDisjuncts(chunk, analyzer, adjacency);

/**
 * QUERY SIDE of the shared analyzer. `analyzer` is the chain STAMPED into the
 * index being searched, never a parameter a caller chose: index and query are
 * analyzed by construction rather than by convention.
 *
 * The query is still split on whitespace ONLY — `query.ts` owns tokenization and
 * an adapter MUST NOT re-tokenize — but each whitespace chunk is then run
 * through the package-wide `analyzeToText`, so it carries the same terms the
 * index holds. A chunk whose characters are all FTS5 syntax (a lone `"`)
 * analyzes to the empty string and is dropped rather than emitted as an empty
 * literal.
 *
 * Analyzing a chunk keeps its internal token ORDER, so a multi-token chunk such
 * as `adr-018` stays the adjacency-requiring phrase `"adr 018"` it already was
 * — the analyzer changes the terms, never the query's shape.
 *
 * Disjunction, not FTS5's implicit AND: a `buildQuery` string carries up to 32
 * distilled terms, and requiring all of them would match nothing. `undefined`
 * for a term-free query — an empty `MATCH` is a syntax error.
 *
 * `adjacency` is ADDITIVE SCORING, never a filter: it ADDS each individual term
 * of a multi-token raw token beside the phrase that token already produced, so
 * an atom carrying the terms APART still matches while one carrying them
 * adjacent is scored by both the terms and the phrase. Absent or `false` emits
 * today's expression byte for byte, which is what keeps every recorded fts5 run
 * reproducible.
 */
export const toMatchExpression = (
  query: string,
  analyzer: AnalyzerId,
  adjacency = false
): string | undefined => {
  const disjuncts = query
    .split(WHITESPACE_RE)
    .flatMap(chunk => chunkDisjuncts(chunk, analyzer, adjacency));
  return disjuncts.length === 0 ? undefined : disjuncts.join(' OR ');
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
const fromAtom = (atom: Atom, row: IndexRow, sourcePath: string): RetrievedAtom => ({
  id: row.id,
  title: atom.frontmatter.title,
  domain: atom.frontmatter.x_domain,
  type: asType(atom.frontmatter.type),
  ...atomOrigin(atom.frontmatter),
  body: atom.body,
  score: -row.rank,
  sourcePath,
  originPaths: atom.frontmatter.sources,
});

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

const matchDomain = (atom: RetrievedAtom, domains: readonly AtomDomain[] | undefined): boolean =>
  domains === undefined || domains.includes(atom.domain);

const matchType = (atom: RetrievedAtom, types: readonly AtomType[] | undefined): boolean =>
  types === undefined || types.includes(atom.type);

/** One row read from disk, kept only if it survives both filters. */
const survivorOf = (
  options: Fts5AdapterOptions,
  row: IndexRow,
  opts: RetrieveOptions
): RetrievedAtom | undefined => {
  const atom = readRow(options, row);
  return atom !== undefined && matchDomain(atom, opts.domains) && matchType(atom, opts.types)
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
  /** Read off the file being searched — the query side's ONLY source of it. */
  readonly analyzer: AnalyzerId;
  /** Read off the same file, and checked BEFORE any row is matched. */
  readonly stamp: IndexStamp;
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
    analyzer: stampedAnalyzer(db),
    stamp: readStamp(db),
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
  /** Takes the RAW query: the match expression can only be built once the
   * index — and therefore its stamped analyzer — is open. */
  readonly snapshot: (indexPath: string, query: string, adjacency: boolean) => IndexSnapshot;
  /** The index-identity keys alone, so the stamp can be judged without searching. */
  readonly stamp: (indexPath: string) => IndexStamp;
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

const snapshotOf = (index: OpenIndex, query: string, adjacency: boolean): IndexSnapshot => {
  const match = toMatchExpression(query, index.analyzer, adjacency);
  return {
    count: (index.count.get() as { readonly n: number }).n,
    rows: match === undefined ? [] : (index.search.all(match) as readonly IndexRow[]),
  };
};

const createIndexHandle = (): IndexHandle => {
  const cell: HandleCell = { open: undefined };
  return {
    close: (): void => release(cell),
    stamp: (indexPath: string): IndexStamp => acquire(cell, indexPath).stamp,
    snapshot: (indexPath: string, query: string, adjacency: boolean): IndexSnapshot =>
      snapshotOf(acquire(cell, indexPath), query, adjacency),
  };
};

/** One adapter instance: its immutable options and the handle it amortizes. */
interface Fts5Instance {
  readonly options: Fts5AdapterOptions;
  readonly handle: IndexHandle;
  readonly corpus: CorpusCell;
}

const search = (self: Fts5Instance, query: string, opts: RetrieveOptions): RetrievalResult => {
  const snapshot = self.handle.snapshot(self.options.indexPath, query, opts.adjacency === true);
  return {
    atoms: selectAtoms(self.options, snapshot.rows, opts),
    mode: FTS5_MODE,
    indexState: resolveState(self, snapshot.count),
  };
};

/** The stamp on the open index, judged against the manifest sitting there NOW. */
const refusalOf = (self: Fts5Instance): string | undefined =>
  stampRefusal(
    self.handle.stamp(self.options.indexPath),
    readManifestDigest(self.options.atomsDir)
  );

/**
 * A missing index file reports `unavailable` with NO atoms — never `empty`.
 * Conflating "no search happened" with "searched and found nothing" is what
 * lets a later evaluation measure nothing and report a clean null result.
 *
 * A REFUSED stamp is the same class of fact under its own name: the index is
 * present but describes another corpus, so the query is never run. Answering it
 * would be the worst version of the conflation — a full ranking, over content
 * that is no longer there, under exit 0.
 */
const retrieveFrom = (
  self: Fts5Instance,
  query: string,
  opts: RetrieveOptions
): RetrievalResult => {
  if (!existsSync(self.options.indexPath)) {
    return { atoms: [], mode: FTS5_MODE, indexState: 'unavailable' };
  }
  const refusal = refusalOf(self);
  return refusal === undefined
    ? search(self, query, opts)
    : { atoms: [], mode: FTS5_MODE, indexState: 'mismatched', indexRefusal: refusal };
};

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
    retrieve: async (query: string, opts: RetrieveOptions): Promise<RetrievalResult> => {
      assertTypeFilter(opts.types);
      assertDomainFilter(opts.domains);
      return retrieveFrom(self, query, opts);
    },
    close: self.handle.close,
  };
};
