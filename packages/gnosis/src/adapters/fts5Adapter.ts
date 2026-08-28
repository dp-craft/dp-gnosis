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
  type BodySource,
  DEFAULT_BODY_SOURCE,
  DEFAULT_ENRICHMENT_COLUMN_SPEC,
  DEFAULT_ENRICHMENT_COLUMNS,
  DEFAULT_FIELD_WEIGHTS,
  DEFAULT_KEYWORD_FILTER,
  type EnrichmentColumnSpec,
  type FieldWeights,
  FTS_COLUMNS,
  type FtsColumn,
  type KeywordFilter
} from '../config.js';
import { CORPUS_MANIFEST_FILE, manifestPathFor, readManifestDigest } from '../corpusManifest.js';
import { type EnrichmentRecord, loadEnrichmentSidecar } from '../enrichment.js';
import { indexRebuildCommand } from '../invocation.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';
import { assertDomainFilter, assertTypeFilter, atomOrigin } from '../port.js';
import type { PrfFeedbackDoc, PrfParams } from '../prf.js';
import { rm3Weights } from '../prf.js';
import {
  analyze,
  type AnalyzerId,
  ANALYZERS,
  analyzeToText,
  DEFAULT_ANALYZER,
  identifierTermOf,
  partsAnalyzerOf
} from '../query.js';
import { isRetrievable } from '../retrievability.js';
import {
  type AtomDomain,
  type AtomType,
  atomTypes,
  defaultAtomType
} from '../vocabulary.js';

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
export const INDEX_SCHEMA_VERSION = '2';
/**
 * The stamped key naming HOW MANY sidecar records this build merged. `'0'` means
 * the enrichment columns are empty — the only state in which this index ranks
 * identically to a one-column one — and stamping it is what lets a later reader
 * tell "no sidecar was passed" from "a sidecar was passed and matched nothing",
 * which are the same empty index and very different facts.
 */
const ENRICHMENT_RECORDS_KEY = 'enrichment_records';
/**
 * The two keys a GENERATED-body build writes, and a default build does not write
 * at all. Their absence is what makes an `atom`-bodied index the same file it
 * has always been — a row stating the default would change every index ever
 * rebuilt, and every recorded number is reproducible only from an unchanged one.
 */
const BODY_SOURCE_KEY = 'body_source';
/**
 * How many indexed atoms got an EMPTY `body` under a generated source — a
 * sidecar record that is missing, or one whose generated text is blank. Those
 * rows are unreachable by any body term while the build reports success, which
 * is this project's failure class, so the count is STAMPED rather than inferred.
 */
const EMPTY_BODY_ATOMS_KEY = 'empty_body_atoms';
/**
 * The three keys a FILTERED-keyword build writes, and an unfiltered build does
 * not write at all — their absence is what keeps today's index the same file it
 * has always been, for the reason {@link BODY_SOURCE_KEY}'s absence does.
 *
 * The two counts are stamped rather than left to be recounted: what the sidecar
 * OFFERED and what the index HOLDS differ by exactly the echo the filter
 * removed, and that difference is the fact an operator needs about THEIR corpus.
 */
const KEYWORD_FILTER_KEY = 'keyword_filter';
const KEYWORDS_KEPT_KEY = 'keywords_kept';
const KEYWORDS_DROPPED_KEY = 'keywords_dropped';
/**
 * The ONE key a build that populated only SOME enrichment columns writes, and a
 * full build does not write at all — its absence is what keeps today's index the
 * same file it has always been, for the reason {@link BODY_SOURCE_KEY}'s is.
 *
 * The value is the canonical LABEL, not the raw flag text: two builds that
 * populated the same columns produced the same index and MUST stamp the same
 * string, or an arm comparison would read a spelling difference as a treatment.
 */
const ENRICHMENT_COLUMNS_KEY = 'enrichment_columns';
/**
 * Columns come from {@link FTS_COLUMNS} rather than a literal: the declaration
 * order, the insert order and the `bm25()` weight order are then the SAME list,
 * and a column cannot be indexed in one position while being weighted in another.
 */
/**
 * The inverted-index table's NAME, exported because a read-only diagnostic must
 * name the same table this build creates. A second literal elsewhere is how a
 * tool ends up reporting on a table nothing writes.
 */
export const FTS_TABLE = 'atom_fts';
const CREATE_FTS_SQL = `CREATE VIRTUAL TABLE ${FTS_TABLE} USING fts5(${FTS_COLUMNS.join(', ')}, content='', detail=full)`;
const INSERT_META_SQL = 'INSERT INTO atom_meta(rowid, id, path) VALUES (?, ?, ?)';
const FTS_PLACEHOLDERS = ['rowid', ...FTS_COLUMNS].map(() => '?').join(', ');
const INSERT_FTS_SQL =
  `INSERT INTO ${FTS_TABLE}(rowid, ${FTS_COLUMNS.join(', ')}) VALUES (${FTS_PLACEHOLDERS})`;
const COUNT_META_SQL = 'SELECT COUNT(*) AS n FROM atom_meta';
/**
 * A weight is INLINED as a numeric literal rather than bound as a parameter:
 * SQLite will not accept a bound value in an auxiliary function's argument list,
 * so the statement is built once PER ADAPTER INSTANCE from that instance's
 * weights and prepared there. A non-finite weight REFUSES instead of being
 * formatted into `NaN` — which SQLite would parse as a column name and fail on
 * at a point far from the caller that supplied it.
 */
const weightLiteral = (column: FtsColumn, weight: number): string => {
  if (!Number.isFinite(weight)) {
    throw new Error(`fts5 index: field weight for "${column}" is ${String(weight)}, not a finite number.`);
  }
  return String(weight);
};

const bm25Call = (weights: FieldWeights): string =>
  `bm25(atom_fts, ${FTS_COLUMNS.map(column => weightLiteral(column, weights[column])).join(', ')})`;

/**
 * `bm25()` returns MORE NEGATIVE for a better match, so plain ascending order is
 * best-first. Bare `bm25()` ordering is NOT deterministic — two rows can hold
 * identical scores — hence the `rowid` tiebreak, and the port's own
 * `(score DESC, atomId ASC)` tiebreak afterwards so this adapter orders
 * identically to every other adapter.
 *
 * Both the projected score and the ORDER BY carry the SAME weight vector — a
 * bare `bm25(atom_fts)` in either position would score by one function and rank
 * by another.
 */
const searchSql = (weights: FieldWeights): string => {
  const scorer = bm25Call(weights);
  return (
    `SELECT m.id AS id, m.path AS path, ${scorer} AS rank FROM atom_fts ` +
    'JOIN atom_meta m ON m.rowid = atom_fts.rowid WHERE atom_fts MATCH ? ' +
    `ORDER BY ${scorer}, m.rowid`
  );
};

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
  /**
   * The enrichment sidecar to JOIN into the enrichment columns, by atom id.
   * ABSENT — or present but pointing at a file that does not exist — leaves every
   * enrichment column EMPTY, which is today's index byte for byte: an empty
   * column contributes no tokens, so it moves neither `bm25()`'s length
   * normalisation nor any score.
   */
  readonly enrichmentPath?: string | undefined;
  /**
   * WHERE the `body` column takes its text from. Absent means
   * {@link DEFAULT_BODY_SOURCE} — the atom's own body, which is today's index
   * byte for byte. A generated source REPLACES the body rather than adding a
   * column: `--field-weights body=0` cannot express that, because `bm25()`
   * normalises by the row's total token count and a populated body still
   * lengthens every row.
   */
  readonly bodySource?: BodySource | undefined;
  /**
   * WHETHER a keyword that merely re-emits body vocabulary reaches the index.
   * Absent means {@link DEFAULT_KEYWORD_FILTER} — every keyword, which is
   * today's index byte for byte.
   */
  readonly keywordFilter?: KeywordFilter | undefined;
  /**
   * WHICH enrichment columns this build populates. Absent means
   * {@link DEFAULT_ENRICHMENT_COLUMN_SPEC} — all six, which is today's index
   * byte for byte. An unselected column is written EMPTY rather than dropped:
   * the schema is fixed by {@link FTS_COLUMNS}, and an empty column contributes
   * no token to `bm25()`'s length normalisation.
   */
  readonly enrichmentColumns?: EnrichmentColumnSpec | undefined;
}

/**
 * Options for one adapter instance — deliberately NO `analyzer`. The query side
 * reads the chain back off the index it opens, so a caller cannot name one here
 * and silently analyze against an index built by a different chain.
 */
export interface Fts5AdapterOptions extends Fts5IndexLocation {
  /** Injected clock for `isRetrievable`; never read from inside. */
  readonly now: Date;
  /**
   * The `bm25()` weight per column, for THIS instance. Absent means
   * {@link DEFAULT_FIELD_WEIGHTS} — body only, which is the ranking every
   * recorded fts5 number was measured on. Unlike `analyzer` this IS a caller's
   * choice: a weight changes how the same index is read, never what it holds,
   * so it cannot desynchronise the query side from the index side.
   */
  readonly fieldWeights?: FieldWeights | undefined;
  /**
   * The chain the CALLER declares this index is built with, asserted against the
   * stamp before anything is searched. This is NOT the `analyzer` the docblock
   * above rules out: it never SELECTS a chain — the query side still reads the
   * stamp — it only refuses to answer when the index disagrees with what the
   * caller said it holds. Absent means no declaration and no assertion.
   */
  readonly expectedAnalyzer?: AnalyzerId | undefined;
}

interface IndexEntry {
  readonly id: string;
  readonly path: string;
  readonly body: string;
  /** The sidecar record joined to this atom, or `undefined` when none matched. */
  readonly enrichment: EnrichmentRecord | undefined;
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
  atomTypes().find(type => type === value) ?? defaultAtomType();

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const markdownPaths = (atomsDir: string): readonly string[] =>
  existsSync(atomsDir)
    ? readdirSync(atomsDir, { recursive: true, encoding: 'utf8' })
        .filter(rel => rel.endsWith(MARKDOWN_EXT))
        .filter(rel => statSync(resolve(atomsDir, rel)).isFile())
        .sort(compareStrings)
    : [];

/** The sidecar, keyed by atom id; an EMPTY map when no path was named. */
const loadEnrichment = (path: string | undefined): ReadonlyMap<string, EnrichmentRecord> =>
  path === undefined ? new Map() : loadEnrichmentSidecar(path);

/** A file outside the closed frontmatter subset is SKIPPED. */
const toEntry = (
  atomsDir: string,
  rel: string,
  enrichment: ReadonlyMap<string, EnrichmentRecord>
): IndexEntry | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, rel), 'utf8'));
  if (!parsed.ok) return undefined;
  const id = parsed.atom.frontmatter.id;
  return { id, path: rel, body: parsed.atom.body, enrichment: enrichment.get(id) };
};

/** Sorted by relative path, so rowids — and therefore ranking — are reproducible. */
const collectEntries = (
  atomsDir: string,
  enrichment: ReadonlyMap<string, EnrichmentRecord>
): readonly IndexEntry[] =>
  markdownPaths(atomsDir)
    .map(rel => toEntry(atomsDir, rel, enrichment))
    .filter(isDefined);

/** Everything the TEXT of one column depends on, for one build. */
interface TextSpec {
  readonly analyzer: AnalyzerId;
  readonly bodySource: BodySource;
  readonly keywordFilter: KeywordFilter;
  readonly enrichmentColumns: EnrichmentColumnSpec;
}

/**
 * A keyword is NOVEL unless every term it analyses to is already a body term.
 * A keyword analysing to nothing carries no term the body lacks, so it is not
 * novel — and it contributes no token either way.
 */
const isNovelKeyword = (
  keyword: string,
  bodyTerms: ReadonlySet<string>,
  analyzer: AnalyzerId
): boolean => !analyze(keyword, analyzer).every(term => bodyTerms.has(term));

/**
 * The keywords THIS entry contributes under the chosen filter.
 *
 * SAFE UNDER THE NON-IDEMPOTENCY LANDMINE (`analyze(analyze(x)) !== analyze(x)`
 * for 4.3 % of terms): both sides are analysed from RAW text — the atom body as
 * `parseAtom` returned it, and the sidecar's raw keyword strings. Nothing is
 * read back out of the inverted index, so no term is ever analysed twice.
 */
const filteredKeywords = (
  record: EnrichmentRecord,
  body: string,
  spec: TextSpec
): readonly string[] =>
  spec.keywordFilter === DEFAULT_KEYWORD_FILTER
    ? record.keywords
    : record.keywords.filter(keyword =>
        isNovelKeyword(keyword, new Set(analyze(body, spec.analyzer)), spec.analyzer)
      );

/** The keywords one entry contributes; NONE when no sidecar record matched it. */
const keptKeywords = (entry: IndexEntry, spec: TextSpec): readonly string[] =>
  entry.enrichment === undefined ? [] : filteredKeywords(entry.enrichment, entry.body, spec);

/**
 * Column → the text a record contributes. `body` is absent on purpose: it comes
 * from the atom, not the sidecar, and listing it here would let a record
 * overwrite the corpus.
 *
 * A list field is joined with a single space. It is TEXT to an inverted index —
 * there is no list type to preserve — and joining is what makes each item its own
 * token instead of one unsearchable run.
 */
const ENRICHMENT_TEXT: Readonly<
  Record<Exclude<FtsColumn, 'body'>, (entry: IndexEntry, spec: TextSpec) => string>
> = {
  short: entry => entry.enrichment?.short ?? '',
  long: entry => entry.enrichment?.long ?? '',
  doc_desc: entry => entry.enrichment?.doc_description ?? '',
  keywords: (entry, spec) => keptKeywords(entry, spec).join(' '),
  entities: entry => entry.enrichment?.entities.join(' ') ?? '',
  questions: entry => entry.enrichment?.questions.join(' ') ?? '',
};

const joinText = (parts: readonly string[]): string =>
  parts.filter(part => part.trim().length > 0).join(' ');

/**
 * Body source → the text the `body` column holds. A generated source reads the
 * SIDECAR, so an atom with no record yields `''` — an empty body, counted by
 * {@link EMPTY_BODY_ATOMS_KEY} rather than passed off as an indexed atom.
 */
const BODY_TEXT: Readonly<Record<BodySource, (entry: IndexEntry, spec: TextSpec) => string>> = {
  atom: entry => entry.body,
  long: entry => entry.enrichment?.long ?? '',
  'long+keywords': (entry, spec) =>
    entry.enrichment === undefined
      ? ''
      : joinText([entry.enrichment.long, keptKeywords(entry, spec).join(' ')]),
};

/** Whether this build was told to populate an enrichment column at all. */
const isSelected = (column: FtsColumn, spec: TextSpec): boolean =>
  spec.enrichmentColumns.columns.some(selected => selected === column);

/**
 * An unenriched atom yields `''` for every enrichment column — no tokens, no
 * effect — and so does a column this build was NOT told to populate: an empty
 * column contributes no token, which is exactly what "this arm did not carry
 * that column" has to mean for `bm25()`'s length normalisation.
 */
const columnText = (column: FtsColumn, entry: IndexEntry, spec: TextSpec): string =>
  column === 'body'
    ? BODY_TEXT[spec.bodySource](entry, spec)
    : isSelected(column, spec)
      ? ENRICHMENT_TEXT[column](entry, spec)
      : '';

/** Atoms whose `body` column ends up holding nothing under the chosen source. */
const emptyBodyAtoms = (entries: readonly IndexEntry[], spec: TextSpec): number =>
  entries.filter(entry => BODY_TEXT[spec.bodySource](entry, spec).trim().length === 0).length;

/** What the keyword filter kept and what it dropped, across the whole build. */
export interface KeywordCensus {
  readonly kept: number;
  readonly dropped: number;
}

/**
 * OFFERED minus KEPT, counted over the entries the index actually holds — a
 * sidecar record matching no atom offers nothing to this build, so counting the
 * sidecar would report an echo rate for a corpus that was never indexed.
 */
const keywordCensus = (entries: readonly IndexEntry[], spec: TextSpec): KeywordCensus => {
  const offered = entries.flatMap(entry => entry.enrichment?.keywords ?? []).length;
  const kept = entries.flatMap(entry => keptKeywords(entry, spec)).length;
  return { kept, dropped: offered - kept };
};

/** One `index_meta` row, as the build states it. */
interface StampRow {
  readonly key: string;
  readonly value: string;
}

/** What one build stamps into the index it produces. */
interface StampSpec extends TextSpec {
  /**
   * `undefined` when no corpus manifest sits beside the atoms dir. NO row is
   * written then — an empty string would claim a corpus identity the build never
   * read, and the query side could not tell it from a real digest.
   */
  readonly corpusDigest: string | undefined;
  /** How many atoms were joined to a sidecar record; `0` when none were. */
  readonly enrichmentRecords: number;
  /** How many atoms that source left with an empty `body`. */
  readonly emptyBodyAtoms: number;
  /** How many keywords the chosen filter kept, and how many it dropped. */
  readonly keywordCensus: KeywordCensus;
}

/**
 * The generated-body rows, written ONLY when a build really generated a body.
 * A default build stamps neither, so it stays the index it has always been.
 */
const bodySourceRows = (spec: StampSpec): readonly StampRow[] =>
  spec.bodySource === DEFAULT_BODY_SOURCE
    ? []
    : [
        { key: BODY_SOURCE_KEY, value: spec.bodySource },
        { key: EMPTY_BODY_ATOMS_KEY, value: String(spec.emptyBodyAtoms) },
      ];

/**
 * The filtered-keyword rows, written ONLY when a build really filtered. An
 * unfiltered build stamps none, so it stays the index it has always been.
 */
const keywordFilterRows = (spec: StampSpec): readonly StampRow[] =>
  spec.keywordFilter === DEFAULT_KEYWORD_FILTER
    ? []
    : [
        { key: KEYWORD_FILTER_KEY, value: spec.keywordFilter },
        { key: KEYWORDS_KEPT_KEY, value: String(spec.keywordCensus.kept) },
        { key: KEYWORDS_DROPPED_KEY, value: String(spec.keywordCensus.dropped) },
      ];

/**
 * The selected-columns row, written ONLY when a build left a column out. A build
 * that populated all six stamps nothing, so it stays the index it has always been.
 */
const enrichmentColumnsRows = (spec: StampSpec): readonly StampRow[] =>
  spec.enrichmentColumns.label === DEFAULT_ENRICHMENT_COLUMNS
    ? []
    : [{ key: ENRICHMENT_COLUMNS_KEY, value: spec.enrichmentColumns.label }];

const stampRows = (spec: StampSpec): readonly StampRow[] => [
  { key: ANALYZER_KEY, value: spec.analyzer },
  { key: SCHEMA_VERSION_KEY, value: INDEX_SCHEMA_VERSION },
  { key: ENRICHMENT_RECORDS_KEY, value: String(spec.enrichmentRecords) },
  ...bodySourceRows(spec),
  ...keywordFilterRows(spec),
  ...enrichmentColumnsRows(spec),
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
      // linear scan computes in memory. EVERY column goes through it, not just
      // `body` — a query is analyzed once, so a column that skipped the chain
      // would hold terms the query can never spell.
      fts.run(
        index + 1,
        ...FTS_COLUMNS.map(column =>
          analyzeToText(columnText(column, entry, spec), spec.analyzer)
        )
      );
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
/** WHICH TEXT the columns draw on, each absent choice falling back to today's. */
const sourceSpecOf = (
  options: BuildFts5IndexOptions
): Omit<TextSpec, 'analyzer'> => ({
  bodySource: options.bodySource ?? DEFAULT_BODY_SOURCE,
  keywordFilter: options.keywordFilter ?? DEFAULT_KEYWORD_FILTER,
  enrichmentColumns: options.enrichmentColumns ?? DEFAULT_ENRICHMENT_COLUMN_SPEC,
});

/** Every text choice this build makes: the analysis chain, plus the sources. */
const textSpecOf = (options: BuildFts5IndexOptions): TextSpec => ({
  analyzer: options.analyzer ?? DEFAULT_ANALYZER,
  ...sourceSpecOf(options),
});

export const buildFts5Index = (options: BuildFts5IndexOptions): number => {
  const entries = collectEntries(options.atomsDir, loadEnrichment(options.enrichmentPath));
  const text = textSpecOf(options);
  rmSync(options.indexPath, { force: true });
  mkdirSync(dirname(options.indexPath), { recursive: true });
  const db = new Database(options.indexPath);
  db.exec(CREATE_META_SQL);
  db.exec(CREATE_FTS_SQL);
  db.exec(CREATE_INDEX_META_SQL);
  writeEntries(db, entries, {
    ...text,
    corpusDigest: readManifestDigest(options.atomsDir),
    enrichmentRecords: entries.filter(entry => entry.enrichment !== undefined).length,
    emptyBodyAtoms: emptyBodyAtoms(entries, text),
    keywordCensus: keywordCensus(entries, text),
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
 * How many sidecar records THIS index merged, read back off the stamp the build
 * wrote inside the same transaction as the rows it describes. Read rather than
 * recomputed: counting the sidecar would report what was OFFERED, and the fact a
 * caller needs is what was MERGED — the two differ precisely when a sidecar was
 * written for a different atoms dir, which is the failure worth reporting.
 *
 * `undefined` when the file carries no such stamp. That absence is a fact about
 * the index, never a zero: a zero is a build that merged nothing.
 */
export const readEnrichmentRecords = (indexPath: string): number | undefined => {
  const db = new Database(indexPath, { readonly: true });
  const value = stampValue(db, ENRICHMENT_RECORDS_KEY);
  db.close();
  return value === undefined ? undefined : asRecordCount(value);
};

/**
 * How many atoms THIS index left with an empty `body` column, read back off the
 * stamp. `undefined` on every index built from the atom body — those have no
 * generated body to be empty, which is a different fact from a zero.
 */
export const readEmptyBodyAtoms = (indexPath: string): number | undefined => {
  const db = new Database(indexPath, { readonly: true });
  const value = stampValue(db, EMPTY_BODY_ATOMS_KEY);
  db.close();
  return value === undefined ? undefined : asRecordCount(value);
};

/**
 * What the keyword filter kept and dropped in THIS index, read back off the
 * stamp the build wrote. `undefined` on every unfiltered build — those dropped
 * nothing because no filter ran, which is a different fact from a zero.
 *
 * The ECHO RATE this census states is a property of the corpus and the
 * generator, never a constant: an operator MUST read it off their OWN run.
 */
export const readKeywordCensus = (indexPath: string): KeywordCensus | undefined => {
  const db = new Database(indexPath, { readonly: true });
  const kept = stampValue(db, KEYWORDS_KEPT_KEY);
  const dropped = stampValue(db, KEYWORDS_DROPPED_KEY);
  db.close();
  return censusOf(
    kept === undefined ? undefined : asRecordCount(kept),
    dropped === undefined ? undefined : asRecordCount(dropped)
  );
};

/** Both counts or neither — half a census would state an echo rate nobody built. */
const censusOf = (
  kept: number | undefined,
  dropped: number | undefined
): KeywordCensus | undefined =>
  kept === undefined || dropped === undefined ? undefined : { kept, dropped };

/** A stamp this build cannot read as a count is reported as ABSENT, not as 0. */
const asRecordCount = (value: string): number | undefined =>
  Number.isInteger(Number(value)) ? Number(value) : undefined;

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
 * The chain an index CARRIES, which is not the chain it STATES: a file written
 * before `index_meta` held an analyzer states nothing and carries
 * {@link PRE_STAMP_ANALYZER}, because that is the only chain that ever produced
 * one. Exported so a read-only diagnostic judges the same value the refusal
 * chain judges -- `doctor` read the raw stamp, found `undefined` on such a
 * file, and stayed SILENT on the exact state every retrieve then refused.
 */
export const carriedAnalyzer = (stamped: string | undefined): string =>
  stamped ?? PRE_STAMP_ANALYZER;

/**
 * The stamped chain of an index file, for a caller that must analyse text the
 * way THAT index was analysed but does not open a port — the zero-posting
 * diagnostic (`fts5VocabularyGap.ts`) and its offline aggregate. It reads the
 * same stamp the query side reads, through the same fallback, so a diagnostic
 * cannot analyse under a chain the searcher would not use.
 */
export const readIndexAnalyzer = (indexPath: string): AnalyzerId => {
  const db = new Database(indexPath, { readonly: true });
  const analyzer = stampedAnalyzer(db);
  db.close();
  return analyzer;
};

/**
 * The two INDEX-IDENTITY keys, read off the file being searched. Both are
 * `undefined` on a pre-stamp index, and that absence is itself the finding —
 * never defaulted to a value the build never wrote.
 */
export interface IndexStamp {
  readonly schemaVersion: string | undefined;
  readonly corpusDigest: string | undefined;
  /**
   * The chain this index was BUILT with. Judged only against a caller that
   * DECLARED one ({@link Fts5AdapterOptions.expectedAnalyzer}); absent there,
   * this value still drives the query side exactly as it always has.
   */
  readonly analyzer: string | undefined;
}

const readStamp = (db: Database.Database): IndexStamp => ({
  schemaVersion: stampValue(db, SCHEMA_VERSION_KEY),
  corpusDigest: stampValue(db, CORPUS_DIGEST_KEY),
  analyzer: stampValue(db, ANALYZER_KEY),
});

/**
 * The identity stamp of an index file, for a READ-ONLY caller that must report
 * what the file claims without opening a port — the `doctor` pass. It reads the
 * SAME three keys the refusal chain reads, so a diagnostic cannot describe an
 * index by facts the searcher does not use, and it changes nothing about how
 * that chain then serves the file.
 */
export const readIndexStamp = (indexPath: string): IndexStamp => {
  const db = new Database(indexPath, { readonly: true });
  try {
    return readStamp(db);
  } finally {
    db.close();
  }
};

const rebuildRemedy = (): string =>
  `rebuild it with \`${indexRebuildCommand(FTS5_MODE)}\``;

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
    : `${REFUSED} its stamp schema_version is "${version}" and this build reads only "${INDEX_SCHEMA_VERSION}"; ${rebuildRemedy()}`;

const unstampedRefusal = (manifest: string): string =>
  `${REFUSED} the index carries NO ${CORPUS_DIGEST_KEY} stamp (it was built before the stamp existed), while ${CORPUS_MANIFEST_FILE} beside the atoms dir carries ${manifest}, so which corpus the index describes cannot be proved; ${rebuildRemedy()}`;

const driftRefusal = (stamped: string, manifest: string): string =>
  `${REFUSED} the stamped ${CORPUS_DIGEST_KEY} ${stamped} disagrees with ${manifest}, the digest ${CORPUS_MANIFEST_FILE} beside the atoms dir carries now — the index describes a different corpus; ${rebuildRemedy()}`;

const removedManifestRefusal = (stamped: string, atomsDir: string): string =>
  `${REFUSED} the index carries the ${CORPUS_DIGEST_KEY} stamp ${stamped}, but no ${CORPUS_MANIFEST_FILE} sits at ${manifestPathFor(atomsDir)} — that stamp is written ONLY from a manifest read while the index was built, so the manifest EXISTED then and has since been removed; nothing is left to prove which corpus the index describes; ${rebuildRemedy()}`;

/**
 * The four states of the pair, each stated rather than assumed:
 *
 * - stamp and manifest agree — served.
 * - stamp and manifest disagree — {@link driftRefusal}.
 * - manifest present, NO stamp — {@link unstampedRefusal}.
 * - stamp present, manifest ABSENT — {@link removedManifestRefusal}. A
 *   `corpus_digest` row exists only when `readManifestDigest` returned a value
 *   at build time (the row is omitted otherwise), so a stamp PROVES a manifest
 *   was there; its absence now is a REMOVAL, not a fact nobody recorded.
 *   Reading it as "nothing to compare with" disabled drift detection outright —
 *   deleting one file made a stale or foreign index answer as `ready` at exit 0.
 *
 * Only the NEITHER case stays silent: a corpus ingested before the manifest
 * existed, or an atoms dir assembled by hand, records no stamp and no manifest
 * and MUST NOT be refused for a fact nobody ever wrote.
 */
const digestRefusal = (
  stamped: string | undefined,
  manifest: string | undefined,
  atomsDir: string
): string | undefined => {
  if (stamped === undefined) {
    return manifest === undefined ? undefined : unstampedRefusal(manifest);
  }
  if (manifest === undefined) return removedManifestRefusal(stamped, atomsDir);
  return stamped === manifest ? undefined : driftRefusal(stamped, manifest);
};

/**
 * A caller that DECLARED the chain its index is built with — a profile's
 * `defaultAnalyzer` — against the chain the index actually carries.
 *
 * Silent disagreement here is the failure class this project is named against:
 * the query side reads the STAMP, so a profile could state `ident-hulight-fold`
 * and be served a `porter-fold` index forever, returning a plausible ranking
 * under exit 0 with nothing anywhere saying the declaration was ignored. It was
 * measured in exactly that state on 2026-08-27.
 *
 * A caller that declares nothing is NOT refused: the stamp is then the only
 * statement of intent there is, which is the behaviour every recorded run and
 * the whole benchmark were measured under.
 */
const analyzerRefusal = (
  stamped: string | undefined,
  expected: string | undefined
): string | undefined => {
  if (expected === undefined) return undefined;
  const carried = carriedAnalyzer(stamped);
  return carried === expected
    ? undefined
    : `${REFUSED} it was built with the "${carried}" analysis chain while the active profile declares "${expected}" — the query side reads the chain off the INDEX, so every term would be analysed the way the index was built and not the way the profile states; ${rebuildRemedy()} under that profile`;
};

/** What one stamp is judged against: the corpus beside it and the declared chain. */
interface StampJudgement {
  readonly stamp: IndexStamp;
  readonly manifest: string | undefined;
  readonly atomsDir: string;
  readonly expectedAnalyzer: string | undefined;
}

const stampRefusal = (judged: StampJudgement): string | undefined =>
  versionRefusal(judged.stamp.schemaVersion) ??
  digestRefusal(judged.stamp.corpusDigest, judged.manifest, judged.atomsDir) ??
  analyzerRefusal(judged.stamp.analyzer, judged.expectedAnalyzer);

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

/**
 * The disjuncts one chunk contributes under an IDENT chain.
 *
 * The chunk is analyzed with `partsAnalyzer` — the PARTS chain `query.ts` pairs
 * with the ident chain — rather than with the ident chain itself, because the
 * ident chain flattens the whole-token term into the same list as the parts and
 * `disjunctsOf` would then weld them into one nonsense phrase. An
 * identifier-shaped chunk becomes a PARENTHESISED group: the unstemmed
 * whole-token literal OR whatever the chunk already emitted, so an atom that
 * spells the identifier whole and one that spells its parts both match.
 * Anything else is byte-identical to the non-ident path.
 */
const identDisjuncts = (
  chunk: string,
  partsAnalyzer: AnalyzerId,
  adjacency: boolean
): readonly string[] => {
  const parts = analyze(chunk, partsAnalyzer);
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

/**
 * EVERY ident chain takes the ident path, resolved from `partsAnalyzerOf` rather
 * than compared against one literal id — the index side gained a second ident
 * chain, and a query side that knew only the first would analyze it as plain
 * text and emit a phrase the index never holds.
 */
const chunkDisjuncts = (
  chunk: string,
  analyzer: AnalyzerId,
  adjacency: boolean
): readonly string[] => {
  const partsAnalyzer = partsAnalyzerOf(analyzer);
  return partsAnalyzer === undefined
    ? plainDisjuncts(chunk, analyzer, adjacency)
    : identDisjuncts(chunk, partsAnalyzer, adjacency);
};

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

/**
 * The RE-ENTRY path for terms read back OUT of an index: it QUOTES and joins,
 * and analyzes NOTHING.
 *
 * This is deliberately NOT {@link toMatchExpression}, which analyzes whatever it
 * is handed. MEASURED 2026-08-21 over every term in the shipped `nfcorpus`
 * index: **822 of 19 098 terms (4.3 %) CHANGE under a second `analyze()`** —
 * `abus` → `abu`, `accident` → `accid`, `absente` → `absent`. The analysis chain
 * is not idempotent. An expansion term comes out of the index already analysed,
 * so sending it through the normal query path would, for 4.3 % of terms, search
 * for a string the index does not hold: zero rows, zero contribution, and a
 * clean number reported — the "produced nothing, recorded as data" failure class
 * this project keeps hitting, here invisible because RM3 would still "work",
 * just weaker.
 *
 * Rule: any term read out of an index MUST re-enter it through this function.
 * `undefined` for an empty list — an empty `MATCH` is a syntax error.
 */
export const toAnalyzedMatchExpression = (terms: readonly string[]): string | undefined =>
  terms.length === 0 ? undefined : terms.map(escapeTerm).join(' OR ');

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

/**
 * The weighted search statement is prepared HERE, once per open file, from the
 * instance's weights — never rebuilt per call. Preparing it per retrieve would
 * make the benchmark's warm regime a second measurement of the cold one, which
 * is the comparison the harness exists to make.
 */
const openIndex = (indexPath: string, weights: FieldWeights): OpenIndex => {
  const db = new Database(indexPath, { readonly: true });
  return {
    identity: identityOf(indexPath),
    db,
    count: db.prepare(COUNT_META_SQL),
    search: db.prepare(searchSql(weights)),
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
  readonly snapshot: (
    indexPath: string,
    query: string,
    request: SnapshotRequest
  ) => IndexSnapshot;
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

const reopen = (cell: HandleCell, indexPath: string, weights: FieldWeights): OpenIndex => {
  release(cell);
  const opened = openIndex(indexPath, weights);
  cell.open = opened;
  return opened;
};

const acquire = (cell: HandleCell, indexPath: string, weights: FieldWeights): OpenIndex => {
  const current = cell.open;
  return current !== undefined && current.identity === identityOf(indexPath)
    ? current
    : reopen(cell, indexPath, weights);
};

/**
 * The RM3 knobs plus the ONE piece of I/O the model needs — the text behind a
 * first-pass row. Passed IN rather than read here, so `prf.ts` stays pure and
 * this file keeps every file read in one place.
 */
interface PrfRequest {
  readonly params: PrfParams;
  readonly bodyOf: (row: IndexRow) => string | undefined;
}

/** What one retrieval asks of the index, beyond the query text itself. */
interface SnapshotRequest {
  readonly adjacency: boolean;
  /** Absent = no feedback pass; the first pass IS the answer, as it always was. */
  readonly prf: PrfRequest | undefined;
}

/** Everything the feedback pass needs, once the index — and its chain — is open. */
interface PrfPass {
  readonly index: OpenIndex;
  readonly request: PrfRequest;
  /** The query, analyzed with the INDEX's own chain. */
  readonly queryTerms: readonly string[];
}

/**
 * The feedback set: the top `fbDocs` rows, analyzed with the INDEX's OWN chain
 * so the model's terms are the terms the index holds. An unreadable row is
 * dropped rather than counted as an empty document, which would dilute every
 * weight with mass drawn from nothing.
 */
const feedbackDocs = (pass: PrfPass, rows: readonly IndexRow[]): readonly PrfFeedbackDoc[] =>
  rows
    .slice(0, Math.max(pass.request.params.fbDocs, 0))
    .map(row => {
      const body = pass.request.bodyOf(row);
      return body === undefined
        ? undefined
        : { terms: analyze(body, pass.index.analyzer), score: -row.rank };
    })
    .filter(isDefined);

/**
 * One weighted term's rows. The term is ALREADY ANALYSED — it came out of this
 * very index — so it re-enters through {@link toAnalyzedMatchExpression}, never
 * through `toMatchExpression`. See that function for the measurement.
 */
const termRows = (index: OpenIndex, term: string): readonly IndexRow[] => {
  const match = toAnalyzedMatchExpression([term]);
  return match === undefined ? [] : (index.search.all(match) as readonly IndexRow[]);
};

/** One candidate's running total: where it lives, and the mass it has gathered. */
interface Accumulated {
  readonly path: string;
  readonly score: number;
}

const addTerm = (
  acc: Map<string, Accumulated>,
  index: OpenIndex,
  entry: readonly [string, number]
): Map<string, Accumulated> =>
  termRows(index, entry[0]).reduce(
    (map, row) =>
      map.set(row.id, { path: row.path, score: (map.get(row.id)?.score ?? 0) + entry[1] * -row.rank }),
    acc
  );

const byRankThenId = (a: IndexRow, b: IndexRow): number =>
  a.rank - b.rank || compareStrings(a.id, b.id);

/**
 * The weighted rescore `score(d) = Σ_t w_t · (−bm25_t(d))`, one single-term
 * query per weighted term, accumulated.
 *
 * MEASURED 2026-08-21 on the real `nfcorpus` index: `bm25()` is exactly additive
 * across single-term fts5 queries to six decimals, so this IS fts5's own scorer
 * — no BM25 is re-implemented here, and none may be. `SEARCH_SQL` carries no
 * LIMIT, so each term contributes its FULL matching set and the sum is exact
 * rather than truncated.
 *
 * A ZERO-weight term is dropped before it is queried. It would contribute no
 * mass, yet its rows would still ENTER the candidate set at score 0 — a term
 * that carries no evidence deciding which documents are ranked at all, which is
 * this project's recurring failure class wearing a plausible number.
 *
 * The result is handed back as `IndexRow`s with `rank = −score`, because the
 * rest of this adapter reads `rank` the way `bm25()` writes it: lower is better.
 */
const rescoredRows = (
  index: OpenIndex,
  weights: ReadonlyMap<string, number>
): readonly IndexRow[] =>
  [...[...weights]
    .filter(([, weight]) => weight > 0)
    .reduce((acc, entry) => addTerm(acc, index, entry), new Map<string, Accumulated>())]
    .map(([id, cell]) => ({ id, path: cell.path, rank: -cell.score }))
    .sort(byRankThenId);

/**
 * The RM3 pass. An EMPTY feedback set returns the first pass unchanged — there
 * is nothing to expand from, and a rescore over no model would rank the corpus
 * by the query alone at a different scale for no reason.
 */
const prfRows = (pass: PrfPass, rows: readonly IndexRow[]): readonly IndexRow[] => {
  const feedback = feedbackDocs(pass, rows);
  if (feedback.length === 0) return rows;
  const weights = rm3Weights({
    queryTerms: pass.queryTerms,
    feedback,
    params: pass.request.params,
  });
  return rescoredRows(pass.index, weights);
};

/** The pass a snapshot asks for, or `undefined` when no feedback was requested. */
const prfPassOf = (index: OpenIndex, query: string, request: SnapshotRequest): PrfPass | undefined =>
  request.prf === undefined
    ? undefined
    : { index, request: request.prf, queryTerms: analyze(query, index.analyzer) };

const snapshotOf = (
  index: OpenIndex,
  query: string,
  request: SnapshotRequest
): IndexSnapshot => {
  const match = toMatchExpression(query, index.analyzer, request.adjacency);
  const rows = match === undefined ? [] : (index.search.all(match) as readonly IndexRow[]);
  const pass = prfPassOf(index, query, request);
  return {
    count: (index.count.get() as { readonly n: number }).n,
    rows: pass === undefined ? rows : prfRows(pass, rows),
  };
};

const createIndexHandle = (weights: FieldWeights): IndexHandle => {
  const cell: HandleCell = { open: undefined };
  return {
    close: (): void => release(cell),
    stamp: (indexPath: string): IndexStamp => acquire(cell, indexPath, weights).stamp,
    snapshot: (indexPath: string, query: string, request: SnapshotRequest): IndexSnapshot =>
      snapshotOf(acquire(cell, indexPath, weights), query, request),
  };
};

/** One adapter instance: its immutable options and the handle it amortizes. */
interface Fts5Instance {
  readonly options: Fts5AdapterOptions;
  readonly handle: IndexHandle;
  readonly corpus: CorpusCell;
}

/**
 * The body behind one row, read from DISK like every other atom read here, so a
 * feedback document is the same text a delivered atom would carry.
 */
const bodyOfRow = (options: Fts5AdapterOptions, row: IndexRow): string | undefined => {
  const sourcePath = resolve(options.atomsDir, row.path);
  if (!existsSync(sourcePath)) return undefined;
  const parsed = parseAtom(readFileSync(sourcePath, 'utf8'));
  return parsed.ok ? parsed.atom.body : undefined;
};

/** Absent `prf` means NO feedback pass — the one branch that keeps the default
 * path byte for byte what it was. */
const prfRequest = (self: Fts5Instance, opts: RetrieveOptions): PrfRequest | undefined =>
  opts.prf === undefined
    ? undefined
    : { params: opts.prf, bodyOf: (row: IndexRow) => bodyOfRow(self.options, row) };

const search = (self: Fts5Instance, query: string, opts: RetrieveOptions): RetrievalResult => {
  const snapshot = self.handle.snapshot(self.options.indexPath, query, {
    adjacency: opts.adjacency === true,
    prf: prfRequest(self, opts),
  });
  return {
    atoms: selectAtoms(self.options, snapshot.rows, opts),
    mode: FTS5_MODE,
    indexState: resolveState(self, snapshot.count),
  };
};

/** The stamp on the open index, judged against the manifest sitting there NOW. */
const refusalOf = (self: Fts5Instance): string | undefined =>
  stampRefusal({
    stamp: self.handle.stamp(self.options.indexPath),
    manifest: readManifestDigest(self.options.atomsDir),
    atomsDir: self.options.atomsDir,
    expectedAnalyzer: self.options.expectedAnalyzer,
  });

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
    handle: createIndexHandle(options.fieldWeights ?? DEFAULT_FIELD_WEIGHTS),
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
