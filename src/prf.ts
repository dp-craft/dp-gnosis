/**
 * RM3 pseudo-relevance feedback — the MODEL only. PURE: no I/O, no index, no
 * adapter. It takes terms and relevance scores and returns a weighted term
 * model; running the weighted query is the adapter's job.
 *
 * WHY it lives apart from `fts5Adapter.ts`: the arithmetic below is what a later
 * sweep tunes and what a test can pin exactly, while the adapter around it is
 * SQLite and disk. Separating them is what lets the model be hand-checked.
 *
 * The measured facts this file is built on (2026-08-21, real `nfcorpus` index):
 * `bm25()` is exactly additive across single-term fts5 queries to six decimals,
 * so a weighted rescore `score(d) = Σ_t w_t · (−bm25_t(d))` uses fts5's OWN
 * scorer and this file MUST NOT re-implement BM25.
 */

/** The three knobs RM3 has, and the only ones. */
export interface PrfParams {
  /** How many top-ranked first-pass documents the model is built from. */
  readonly fbDocs: number;
  /** How many expansion terms survive the mass cut. */
  readonly fbTerms: number;
  /**
   * The interpolation: the expansion model carries `alpha` of the total mass and
   * the original query carries `1 − alpha`. `0` is the unexpanded query.
   */
  readonly alpha: number;
}

/**
 * The cell the offline forecast measured (§ 1 of the lexical-gap plan):
 * nfcorpus R@100 0.2476 → 0.3142. It is a DEFAULT, not an adopted value — no
 * sweep has frozen a cell yet, and nothing reads it unless a caller opts in.
 */
export const DEFAULT_PRF_PARAMS: PrfParams = { fbDocs: 10, fbTerms: 20, alpha: 0.5 };

/** One feedback document: its ANALYSED terms, in order, and its relevance. */
export interface PrfFeedbackDoc {
  /**
   * The document's terms as the INDEX holds them — repeats included, since the
   * term frequency is counted off this list. Order is irrelevant to the model.
   */
  readonly terms: readonly string[];
  /**
   * A POSITIVE relevance. The fts5 caller passes `−bm25()`, because `bm25()`
   * returns more NEGATIVE for a better match; passing the raw value would invert
   * the document weighting silently.
   */
  readonly score: number;
}

/** Everything `rm3Weights` needs, stated as one object rather than four arguments. */
export interface Rm3Input {
  /** The ANALYSED query terms, repeats included — a repeat is repeated mass. */
  readonly queryTerms: readonly string[];
  /** The first-pass feedback set, best first. Only the first `fbDocs` are read. */
  readonly feedback: readonly PrfFeedbackDoc[];
  readonly params: PrfParams;
}

type TermMass = readonly (readonly [string, number])[];

const compareTerms = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Each document's share of the model, normalised to sum 1.
 *
 * A non-positive score contributes nothing, and a feedback set carrying NO mass
 * at all falls back to uniform rather than to `NaN`: a zero divisor here would
 * turn every weight into `NaN`, which fts5 would accept and rank as garbage —
 * the "produced nothing, recorded as data" class this project keeps hitting.
 */
const docWeights = (feedback: readonly PrfFeedbackDoc[]): readonly number[] => {
  const positives = feedback.map(fb => Math.max(fb.score, 0));
  const total = positives.reduce((sum, score) => sum + score, 0);
  return total > 0 ? positives.map(score => score / total) : positives.map(() => 1 / feedback.length);
};

/** One document's contribution: `w · tf(t)/len(d)`, accumulated per occurrence. */
const addDoc = (
  acc: Map<string, number>,
  doc: PrfFeedbackDoc,
  weight: number
): Map<string, number> =>
  doc.terms.reduce(
    (mass, term) => mass.set(term, (mass.get(term) ?? 0) + weight / doc.terms.length),
    acc
  );

const termMass = (
  feedback: readonly PrfFeedbackDoc[],
  weights: readonly number[]
): ReadonlyMap<string, number> =>
  feedback.reduce(
    (acc, doc, position) => addDoc(acc, doc, weights[position] ?? 0),
    new Map<string, number>()
  );

/** Top `fbTerms` by mass; the term tiebreak keeps the cut deterministic. */
const topTerms = (mass: ReadonlyMap<string, number>, fbTerms: number): TermMass =>
  [...mass]
    .sort((a, b) => b[1] - a[1] || compareTerms(a[0], b[0]))
    .slice(0, Math.max(fbTerms, 0));

/** The kept terms renormalised to `z` and scaled to `alpha` of the total mass. */
const expansionWeights = (feedback: readonly PrfFeedbackDoc[], params: PrfParams): TermMass => {
  if (feedback.length === 0) return [];
  const kept = topTerms(termMass(feedback, docWeights(feedback)), params.fbTerms);
  const z = kept.reduce((sum, [, value]) => sum + value, 0);
  return z > 0 ? kept.map(([term, value]) => [term, (params.alpha * value) / z] as const) : [];
};

/**
 * The original query's `1 − alpha`, spread over its terms. A repeated term gets
 * repeated mass — that is the query language model, and deduplicating it would
 * quietly reweight a query the caller typed.
 */
const queryWeights = (queryTerms: readonly string[], alpha: number): Map<string, number> => {
  const each = queryTerms.length === 0 ? 0 : (1 - alpha) / queryTerms.length;
  return queryTerms.reduce(
    (acc, term) => acc.set(term, (acc.get(term) ?? 0) + each),
    new Map<string, number>()
  );
};

/**
 * The RM3 term model: query terms at `(1 − alpha)/|Q|` each, expansion terms at
 * `alpha · v/z`, and a term appearing in BOTH carrying the SUM of the two — it
 * is one term with two sources of evidence, not two competing weights.
 *
 * Every term returned is ALREADY ANALYSED, so it MUST reach the index through
 * `toAnalyzedMatchExpression`. See its doc comment: the analysis chain is not
 * idempotent, and re-analysing an index term searches for a string the index
 * does not hold.
 */
export const rm3Weights = (input: Rm3Input): ReadonlyMap<string, number> => {
  const feedback = input.feedback.slice(0, Math.max(input.params.fbDocs, 0));
  const weights = queryWeights(input.queryTerms, input.params.alpha);
  return expansionWeights(feedback, input.params).reduce(
    (acc, [term, value]) => acc.set(term, (acc.get(term) ?? 0) + value),
    weights
  );
};
