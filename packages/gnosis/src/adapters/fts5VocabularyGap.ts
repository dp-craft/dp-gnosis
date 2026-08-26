/**
 * C11a — the ZERO-POSTING QUERY-TERM DIAGNOSTIC. Read-only, zero GPU, and the
 * exact analogue of what C1 did for the silent enrichment hole: it makes the
 * VOCABULARY hole visible before anything tries to fix it.
 *
 * The hole it closes: a query term the index has never seen contributes an
 * empty posting list. `MATCH` still succeeds, bm25 still ranks, the CLI still
 * exits 0 — and the term that carried the caller's actual intent reached
 * nothing. Worse under RM3, which is *pseudo*-relevance feedback: if the query
 * says `BMI` and no document says `BMI`, the first pass returns noise and the
 * expansion AMPLIFIES the noise (finalization plan § 2.9.1).
 *
 * OWN MODULE, beside the adapter rather than inside it. `fts5Adapter.ts` owns
 * the `KnowledgePort` — build, open, match, rank — and is already 1 300+ lines.
 * A diagnostic that opens its own read-only handle, touches no prepared
 * statement of the retrieval path and can never change a ranking is a different
 * responsibility, and keeping it out is what proves the hot path unchanged. It
 * lives NEXT to the adapter because it is fts5-schema-specific: it reads
 * {@link FTS_TABLE}, the very table that build creates.
 *
 * WRITES NOTHING. The database is opened `readonly`; the `fts5vocab` handle is
 * a TEMP virtual table, so it lives in the connection's own temp database and
 * the index file is never touched. Verified against the engine (SQLite 3.53.2,
 * better-sqlite3 12.11.1): a temp `fts5vocab` over a readonly `main` opens and
 * answers.
 */
import Database from 'better-sqlite3';

import { analyze, type AnalyzerId } from '../query.js';
import { FTS_TABLE } from './fts5Adapter.js';

/** One analysed query term and the number of atoms its posting list reaches. */
export interface QueryTermPostings {
  readonly term: string;
  /**
   * `fts5vocab`'s `doc` — how many indexed rows hold the term, which is the
   * number an operator can act on ("how many atoms can this term reach"). Not
   * `cnt` (total instances): a term in one atom fifty times still reaches one
   * atom, and reach is what a vocabulary hole is about.
   */
  readonly postings: number;
}

/** What one query's terms look like against one index's vocabulary. */
export interface VocabularyGap {
  /** Every DISTINCT analysed term of the query, in the order it was analysed. */
  readonly terms: readonly QueryTermPostings[];
  /** Just the terms with zero postings — the hole, named. */
  readonly gapTerms: readonly string[];
  readonly gapCount: number;
  readonly termCount: number;
}

/**
 * The `fts5vocab` handle. `row` mode gives one row per term carrying `doc` and
 * `cnt`; that is all this diagnostic needs, and it is the cheapest of the three
 * modes. The name is namespaced so it cannot collide with a temp table a
 * caller's own connection made — this one is created on a handle nobody else
 * holds, and dropped when that handle closes.
 */
const VOCAB_TABLE = 'gnosis_query_vocab';

const CREATE_VOCAB_SQL =
  `CREATE VIRTUAL TABLE temp.${VOCAB_TABLE} USING fts5vocab(main, ${FTS_TABLE}, 'row')`;

const SELECT_POSTINGS_SQL = `SELECT doc AS doc FROM temp.${VOCAB_TABLE} WHERE term = ?`;

/**
 * THE COMPARISON SITE, and the non-idempotency landmine binds it directly.
 *
 * MEASURED over every term in the shipped `nfcorpus` index: 822 of 19 098
 * terms (4.3 %) CHANGE under a second `analyze()` — `abus` → `abu`, `accident`
 * → `accid`. The analysis chain is NOT idempotent.
 *
 * So the two sides enter analysed space by DIFFERENT routes, exactly once each:
 *
 * - the QUERY is RAW text and is analysed HERE, once, by the index's own chain;
 * - a `fts5vocab` term is ALREADY ANALYSED — it came out of this very index —
 *   and is compared BYTE FOR BYTE. It MUST NOT be re-analysed, and it MUST NOT
 *   be passed back through `toMatchExpression`, which analyses whatever it is
 *   handed. For 4.3 % of terms either would ask about a string the index does
 *   not hold: zero rows, and a clean "gap" reported for a term that is present.
 *
 * The equality is therefore a plain `term = ?` bind against the vocabulary — no
 * second analysis anywhere on this path.
 */
const postingsOf = (statement: Database.Statement, term: string): QueryTermPostings => {
  const row = statement.get(term) as { readonly doc: number } | undefined;
  return { term, postings: row === undefined ? 0 : row.doc };
};

/** Distinct, order-preserving: a term repeated in the query is ONE vocabulary fact. */
const distinctTerms = (terms: readonly string[]): readonly string[] => [...new Set(terms)];

/**
 * The counts, derived from the per-term rows alone — pure, so a caller holding
 * postings from anywhere can summarise them the same way this module does.
 */
export const summarizeVocabularyGap = (
  terms: readonly QueryTermPostings[]
): VocabularyGap => {
  const gapTerms = terms.filter(entry => entry.postings === 0).map(entry => entry.term);
  return { terms, gapTerms, gapCount: gapTerms.length, termCount: terms.length };
};

/**
 * Per analysed query term, how many atoms it reaches in the index at
 * `indexPath`. `analyzer` is the chain STAMPED into that index — see
 * {@link readIndexAnalyzer} — never a chain a caller picked, for the reason the
 * query path reads it off the file: a diagnostic run under a different chain
 * would report a hole that only its own analysis invented.
 */
export const readVocabularyGap = (
  indexPath: string,
  query: string,
  analyzer: AnalyzerId
): VocabularyGap => {
  const db = new Database(indexPath, { readonly: true });
  db.exec(CREATE_VOCAB_SQL);
  const statement = db.prepare(SELECT_POSTINGS_SQL);
  const terms = distinctTerms(analyze(query, analyzer)).map(term => postingsOf(statement, term));
  db.close();
  return summarizeVocabularyGap(terms);
};
