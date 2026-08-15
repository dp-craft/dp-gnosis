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
import { stemmer } from 'stemmer';

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

/** Applied to every term, on BOTH the document side and the query side. */
export type TermProcessor = (term: string) => string;

/**
 * THE English normalizer for the whole package — every adapter's default
 * `processTerm`, so a third or fourth adapter cannot drift into its own
 * stemming.
 *
 * It lives beside `tokenize` for the same reason `tokenize` lives here: a
 * second normalizer is a second, invisible query, and an adapter that stemmed
 * while its neighbour did not would turn the benchmark from a comparison of
 * RETRIEVAL into a comparison of tokenizers. That is also why SQLite FTS5's
 * free built-in `porter` tokenizer is deliberately NOT used: it is a different
 * Porter implementation, so binding it to one adapter reintroduces exactly that
 * confound. FTS5 keeps `unicode61` and stems its text through THIS function on
 * both sides instead.
 *
 * `stemmer` is the Porter (1980) algorithm, English only, MIT, zero transitive
 * dependencies — approved in the COMMON.md §IX round of 2026-08-08.
 */
export const stemTerm: TermProcessor = term => stemmer(term);

/**
 * Tokenize `text` and stem every token back into a space-separated string.
 *
 * For an adapter that hands TEXT rather than terms to its engine (FTS5 inserts
 * a string and tokenizes it internally with `unicode61`): stemming the text
 * before it reaches the engine is what makes that adapter's index hold the same
 * stems the linear scan computes in memory. Token ORDER is preserved, so phrase
 * and NEAR queries still work over the stems.
 */
export const stemText = (text: string): string => tokenize(text).map(stemTerm).join(' ');

/**
 * One analysis step: tokens in, tokens out.
 *
 * Every stage has the SAME shape so a chain is data (an ordered array) rather
 * than a hand-written function body — which is what makes the analyzer
 * nameable, reorderable and comparable in a benchmark. Text enters a chain as
 * the single-element token list `[text]`.
 */
export type Stage = (tokens: readonly string[]) => readonly string[];

const nonEmpty = (token: string): boolean => token.length > 0;

/**
 * Split every input token on runs of non-letter/non-digit characters.
 *
 * The class also admits combining marks (`\p{M}`). `tokenize` folds marks away
 * BEFORE it splits, so a mark never reaches its split; a chain splits FIRST, so
 * keeping marks attached to their base letter here is exactly what makes
 * split-then-fold reproduce today's fold-then-split token for token — otherwise
 * a decomposed `café` (e + U+0301) would break into `cafe` and `s`-style
 * fragments where the precomposed spelling stays whole. Marks left stranded by
 * folding are dropped by `foldTokens`, never emitted as empty tokens.
 */
const NON_WORD_SPLIT_RE = /[^\p{L}\p{N}\p{M}]+/u;

export const splitTokens: Stage = tokens =>
  tokens.flatMap(token => token.split(NON_WORD_SPLIT_RE)).filter(nonEmpty);

export const lowercaseTokens: Stage = tokens => tokens.map(token => token.toLowerCase());

export const foldTokens: Stage = tokens => tokens.map(foldDiacritics).filter(nonEmpty);

export const stemTokens: Stage = tokens => tokens.map(stemTerm);

/**
 * The named analyzers. `porter-fold` IS today's behaviour — `analyze(text)`
 * reproduces `tokenize(text).map(stemTerm)` token for token — and the other
 * three exist so folding and stemming can be switched off INDEPENDENTLY, which
 * is what a non-English corpus needs to be measured against.
 */
export const ANALYZERS = {
  'porter-fold': [splitTokens, lowercaseTokens, foldTokens, stemTokens],
  'porter-nofold': [splitTokens, lowercaseTokens, stemTokens],
  'nostem-fold': [splitTokens, lowercaseTokens, foldTokens],
  'nostem-nofold': [splitTokens, lowercaseTokens],
} as const satisfies Readonly<Record<string, readonly Stage[]>>;

/** The name of a chain in `ANALYZERS`. */
export type AnalyzerId = keyof typeof ANALYZERS;

/** Today's chain: the default everywhere, so nothing changes until a caller opts out. */
export const DEFAULT_ANALYZER: AnalyzerId = 'porter-fold';

/** Run `text` through the named chain: enter as `[text]`, reduce the stages in order. */
export const analyze = (text: string, id: AnalyzerId = DEFAULT_ANALYZER): readonly string[] =>
  ANALYZERS[id].reduce<readonly string[]>((tokens, stage) => stage(tokens), [text]);

/** `analyze` for an adapter that hands TEXT, not terms, to its engine. */
export const analyzeToText = (text: string, id: AnalyzerId = DEFAULT_ANALYZER): string =>
  analyze(text, id).join(' ');

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
