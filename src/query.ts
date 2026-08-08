/**
 * Deterministic retrieval-query construction.
 *
 * This module sits ABOVE the port (`port.ts`) on purpose: `KnowledgePort.retrieve`
 * takes an already-built query STRING, so every adapter receives a byte-identical
 * one. If two adapters could each derive their own query from the raw task input,
 * a benchmark between them would no longer be a comparison of retrieval — it
 * would silently be a comparison of query construction. Adapters MUST NOT
 * re-tokenize or re-weight; they consume what `buildQuery` returns.
 *
 * In production the raw input (targets + test contract + spec excerpts +
 * requirement details) runs to thousands of tokens, and BM25 scores such a blob
 * nothing like a focused query. `buildQuery` reduces it to the `QUERY_MAX_TERMS`
 * rarest distinct terms.
 */
import { BM25_IDF_SMOOTHING, QUERY_MAX_TERMS } from './config.js';

/** The raw task-side material a query is distilled from. */
export interface QueryInput {
  readonly targets: readonly string[];
  readonly testContract?: string;
  readonly specExcerpts?: readonly string[];
  readonly requirementDetails?: readonly string[];
}

/** Corpus statistics: how many documents exist, and how many contain each term. */
export interface DocumentFrequencies {
  readonly totalDocs: number;
  readonly docFreq: ReadonlyMap<string, number>;
}

/**
 * The single tokenizer for the whole package — the tokenization spike (T-17)
 * and every adapter reuse THIS function rather than re-deriving one, because a
 * second tokenizer is a second, invisible query.
 *
 * Lowercase, fold diacritics, then split on every run of non-letter/non-digit
 * characters (Unicode-aware), so `useChatStore.retrieve(query)` and `adr-018`
 * decompose into their word parts. Occurrence order is preserved;
 * de-duplication is the caller's concern.
 *
 * Diacritic folding is NFD decomposition followed by dropping every combining
 * mark (`\p{M}`), so `café` and `cafe` — and the precomposed (U+00E9) and
 * decomposed (e + U+0301) spellings of the same word — collapse to ONE token.
 * Without it the two spellings are different terms, and a document written one
 * way is invisible to a query written the other. It lives HERE rather than in
 * an adapter because a second tokenizer is a second, invisible query.
 *
 * Limits, stated rather than left emergent: this folds marks only. Letters that
 * carry no separable mark (`ß`, `ø`, `ł`) are unchanged, and case folding stays
 * `toLowerCase`. Both are single-script exceptions that a mark-stripping rule
 * cannot express; widening them needs a real Unicode-folding decision.
 */
const NON_WORD_RE = /[^\p{L}\p{N}]+/u;
const COMBINING_MARK_RE = /\p{M}+/gu;

const foldDiacritics = (text: string): string =>
  text.normalize('NFD').replace(COMBINING_MARK_RE, '');

export const tokenize = (text: string): readonly string[] =>
  foldDiacritics(text.toLowerCase())
    .split(NON_WORD_RE)
    .filter(token => token.length > 0);

/** One term with its inverse-document-frequency weight. */
interface ScoredTerm {
  readonly term: string;
  readonly score: number;
}

/**
 * Standard BM25 (Robertson/Sparck-Jones) IDF with the +1 smoothing that keeps
 * the weight non-negative:
 *
 *   idf(t) = ln( 1 + (N - n(t) + 0.5) / (n(t) + 0.5) )
 *
 * where N = `totalDocs` and n(t) = documents containing t. The exact form is
 * spelled out here because a later spike varies it.
 *
 * A term absent from `docFreq` is scored with n(t) = 0, which this formula
 * already maximises — an unseen term is by definition the rarest thing the
 * query can ask for, so it needs no special case and never reaches `undefined`
 * arithmetic (which would yield NaN and corrupt the whole ordering).
 *
 * No stopword list exists, deliberately: IDF already demotes ubiquitous terms
 * by construction, and a hand-maintained word list is exactly the kind of magic
 * constant COMMON.md §III forbids. MUST NOT add one back.
 */
const idf = (term: string, df: DocumentFrequencies): number => {
  const n = df.docFreq.get(term) ?? 0;
  return Math.log(1 + (df.totalDocs - n + BM25_IDF_SMOOTHING) / (n + BM25_IDF_SMOOTHING));
};

/** Lexicographic, code-unit order — NOT `localeCompare`, whose result varies by locale. */
const compareTerms = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Rarest first; equal weights fall back to the term itself, never to Map order. */
const byWeightThenTerm = (a: ScoredTerm, b: ScoredTerm): number =>
  b.score - a.score || compareTerms(a.term, b.term);

const rawText = (input: QueryInput): string =>
  [
    ...input.targets,
    input.testContract ?? '',
    ...(input.specExcerpts ?? []),
    ...(input.requirementDetails ?? []),
  ].join(' ');

/**
 * Build the retrieval query for `input`, weighted against corpus statistics
 * `df`. Pure and set-based: identical input plus identical `df` always yields a
 * byte-identical string, and moving the same text between input sections cannot
 * change it.
 */
export const buildQuery = (input: QueryInput, df: DocumentFrequencies): string =>
  [...new Set(tokenize(rawText(input)))]
    .map(term => ({ term, score: idf(term, df) }))
    .sort(byWeightThenTerm)
    .slice(0, QUERY_MAX_TERMS)
    .map(scored => scored.term)
    .join(' ');
