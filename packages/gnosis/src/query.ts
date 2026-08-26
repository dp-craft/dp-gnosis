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

const PORTER_FOLD_STAGES: readonly Stage[] = [
  splitTokens,
  lowercaseTokens,
  foldTokens,
  stemTokens,
];

/**
 * HUNGARIAN LIGHT STEMMING — the suffix stripper the `hulight-fold` chain runs
 * INSTEAD OF Porter.
 *
 * It is lexicon-free and pure by construction: an agglutinative language cannot
 * be served by an English suffix table, and a word list would be exactly the
 * hand-maintained magic constant COMMON.md §III forbids. It runs AFTER
 * `foldTokens`, so it only ever sees lowercase ASCII — `kötelezettségek` reaches
 * it as `kotelezettsegek` — which is what lets the suffix tables be plain ASCII
 * rather than a cross product of accented spellings.
 *
 * `MIN_STEM_LENGTH` is the whole safety mechanism: over-stemming an
 * agglutinative language collapses unrelated words onto one term and is
 * invisible in the numbers, so EVERY cut is refused when it would leave a
 * shorter stem, and a refused cut ends its step with the token unchanged.
 */
const MIN_STEM_LENGTH = 4;

const cutChars = (token: string, count: number): string =>
  token.length - count < MIN_STEM_LENGTH ? token : token.slice(0, token.length - count);

/** One step of the stemmer: token in, token out — unchanged when nothing matched. */
type StemStep = (token: string) => string;

/**
 * One terminal-inflection rule: the cut token, or `undefined` when the rule does
 * not MATCH. The distinction matters because step 1 applies at most one rule —
 * the first that matches — and a match whose cut is refused still ends the step.
 */
type SuffixRule = (token: string) => string | undefined;

/**
 * Suffix tables are matched LONGEST-FIRST: each list is ordered so that no entry
 * precedes a longer entry ending in it, and `find` takes the first hit.
 */
const suffixRule =
  (suffixes: readonly string[]): SuffixRule =>
    token => {
      const hit = suffixes.find(suffix => token.endsWith(suffix));
      return hit === undefined ? undefined : cutChars(token, hit.length);
    };

const stripStep =
  (suffixes: readonly string[]): StemStep =>
    token =>
      suffixRule(suffixes)(token) ?? token;

/**
 * Instrumental assimilation: `-val`/`-vel` assimilates its `v` to the stem-final
 * consonant, so the surface form doubles it (`cimkékkel`). Cut the case ending,
 * then the consonant it copied.
 */
const DOUBLED_INSTRUMENTAL_RE = /([bcdfghjklmnpqrstvwxyz])\1(al|el)$/;

const assimilatedInstrumental: SuffixRule = token => {
  if (!DOUBLED_INSTRUMENTAL_RE.test(token)) return undefined;
  const stripped = cutChars(token, 2);
  return stripped === token ? token : cutChars(stripped, 1);
};

const NOMINALIZER_ACCUSATIVE: readonly string[] = ['ast', 'est', 'ost', 'ist', 'ust'];

const CASE_SUFFIXES: readonly string[] = [
  'kent', 'ban', 'ben', 'bol', 'rol', 'tol', 'hoz', 'hez', 'nak', 'nek',
  'val', 'vel', 'nal', 'nel', 'ert', 'ba', 'be', 'ra', 're', 'ig', 'ul', 'on', 'en',
];

/**
 * The accusative is cut ONLY after a vowel or a linking vowel. There is
 * deliberately NO bare consonant+`t` rule: it fires on stems that legitimately
 * end in `t` (`kozpont`, `csoport`) and MEASURABLY creates new vocabulary gaps —
 * a query term the index no longer holds under any spelling.
 */
const VOWEL_ACCUSATIVE_RE = /[aeiou]t$/;

const vowelAccusative: SuffixRule = token =>
  VOWEL_ACCUSATIVE_RE.test(token) ? cutChars(token, 1) : undefined;

const LINKING_ACCUSATIVE: readonly string[] = ['at', 'et', 'ot'];

const VERBAL_SUFFIXES: readonly string[] = [
  'hattam', 'hettem', 'ottam', 'ettem', 'attam', 'tettem', 'ttunk', 'ttam', 'ttem',
  'tunk', 'tam', 'tem', 'juk', 'jon', 'jen', 'jek', 'jak', 'jam', 'jem', 'jal', 'jel',
  'unk', 'ani', 'eni', 'ni', 'va', 've', 'ok', 'om', 'em', 'am', 'sz',
];

/** Step 1 — terminal inflection, at most ONE rule, the first that matches. */
const TERMINAL_RULES: readonly SuffixRule[] = [
  assimilatedInstrumental,
  suffixRule(NOMINALIZER_ACCUSATIVE),
  suffixRule(CASE_SUFFIXES),
  vowelAccusative,
  suffixRule(LINKING_ACCUSATIVE),
  suffixRule(VERBAL_SUFFIXES),
];

const stripTerminal: StemStep = token =>
  TERMINAL_RULES.reduce<string | undefined>((hit, rule) => hit ?? rule(token), undefined) ?? token;

const POSSESSIVE_SUFFIXES: readonly string[] = [
  'juk', 'jai', 'jei', 'unk', 'ja', 'je', 'uk', 'ik', 'om', 'od', 'am', 'ad',
  'em', 'ed', 'a', 'e', 'm', 'd',
];

const PLURAL_SUFFIXES: readonly string[] = ['ok', 'ek', 'ak', 'ik', 'k'];

const DERIVATIONAL_SUFFIXES: readonly string[] = ['as', 'es', 'os', 'is', 'us', 's'];

/**
 * A stem left ending in a doubled consonant is usually an artefact of the cut
 * before it, so undo the doubling — above the minimum only, where the doubling
 * cannot be the whole short stem. Lexicon-free, it also fires on a stem whose
 * own spelling doubles (`bevall` → `beval`); both spellings then collapse onto
 * ONE term, which is the point on the index and query sides alike.
 */
const DOUBLED_FINAL_RE = /([bcdfghjklmnpqrstvwxyz])\1$/;

const undouble: StemStep = token =>
  token.length > MIN_STEM_LENGTH && DOUBLED_FINAL_RE.test(token) ? cutChars(token, 1) : token;

const HU_LIGHT_STEPS: readonly StemStep[] = [
  stripTerminal,
  stripStep(POSSESSIVE_SUFFIXES),
  stripStep(PLURAL_SUFFIXES),
  stripStep(DERIVATIONAL_SUFFIXES),
  undouble,
];

/** Strip Hungarian inflection off ONE already-folded, already-lowercased token. */
export const huLightStem = (token: string): string =>
  HU_LIGHT_STEPS.reduce((stem, step) => step(stem), token);

export const huLightStemTokens: Stage = tokens => tokens.map(huLightStem);

/**
 * `hulight-fold` REPLACES the Porter stage rather than chaining after it: Porter
 * is English-only and its `-s` rule truncates native Hungarian words
 * (`bevallás` → `bevallá`), so running both would stem each token under two
 * unrelated grammars.
 *
 * CORPUS-SCOPED. This chain is opt-in (`--analyzer hulight-fold`) and MUST NOT
 * be proposed as `DEFAULT_ANALYZER` — see that docblock: `ident-porter-fold`
 * shipped as the default on a plausible argument and was REVERTED on measured
 * harm to the primary corpus. A Hungarian chain earns the default only from a
 * measurement on the corpus it would become the default FOR.
 */
const HULIGHT_FOLD_STAGES: readonly Stage[] = [
  splitTokens,
  lowercaseTokens,
  foldTokens,
  huLightStemTokens,
];

const WHITESPACE_SPLIT_RE = /\s+/;
/**
 * A separator counts ONLY when it is INTERNAL — alphanumeric on both sides. A
 * trailing `.` or `:` on a prose word (`pack.`, `them:`, `numbers.**`) is
 * punctuation, not an identifier, and a markdown table rule (`|---|---|`) is
 * neither; admitting them made 14.7 % of body tokens identifier-shaped and
 * doubled the token stream for half of those with no retrieval gain — measured
 * harm on `scifact` (nDCG@10 −0.0188, p=0.0178) and `vault` (−0.0162). Requiring
 * the separator to be internal drops the same sample to 7.5 %.
 */
const IDENTIFIER_SHAPE_RE = /[a-zA-Z0-9][/:_.-]+[a-zA-Z0-9]|[a-z][A-Z]/;
const NON_SLUG_RE = /[^a-z0-9]+/g;
const EDGE_UNDERSCORE_RE = /^_+|_+$/g;
const AT_SIGN = '@';
const AT_WORD = 'at';

/**
 * Does this RAW token look like an identifier — a path, a flag, a screaming
 * constant, a dotted call, a camelCase symbol? Prose never carries `/ : _ - .`
 * BETWEEN two alphanumerics and never runs a lowercase letter straight into an
 * uppercase one, so those six shapes separate code-shaped tokens from words
 * without a dictionary. An edge separator does NOT count — see
 * `IDENTIFIER_SHAPE_RE`. Accents and digits are NOT a signal: `bevallás` and
 * `018` are ordinary words a Hungarian or a version query supplies.
 */
export const isIdentifierShaped = (raw: string): boolean => IDENTIFIER_SHAPE_RE.test(raw);

/**
 * The slug an identifier-shaped token keeps as ONE term: lowercase, fold marks
 * away, spell `@` as `at` (it is the only punctuation that carries a word), then
 * collapse every non-alphanumeric run to a single `_` and trim the edges. The
 * result is deliberately NOT stemmed — `useChatStore` must stay findable under
 * the exact spelling a user typed.
 */
const normalizeIdentifier = (raw: string): string =>
  foldDiacritics(raw.toLowerCase())
    .replaceAll(AT_SIGN, AT_WORD)
    .replace(NON_SLUG_RE, '_')
    .replace(EDGE_UNDERSCORE_RE, '');

/**
 * The EXTRA whole-token term a raw token contributes beside its `porter-fold`
 * parts, or `undefined` when it contributes none — the token is not identifier
 * shaped, normalizes to nothing, or already equals the single part the parts
 * chain produced (emitting it twice would double that term's frequency).
 *
 * Shared by the `ident-porter-fold` chain (index side) and `toMatchExpression`
 * (query side) so the two cannot drift into disagreeing about which tokens earn
 * a whole-token term.
 */
const isRedundantWhole = (whole: string, parts: readonly string[]): boolean =>
  whole === '' || (parts.length === 1 && parts[0] === whole);

export const identifierTermOf = (raw: string, parts: readonly string[]): string | undefined => {
  if (!isIdentifierShaped(raw)) return undefined;
  const whole = normalizeIdentifier(raw);
  return isRedundantWhole(whole, parts) ? undefined : whole;
};

/**
 * ONE composite stage rather than a list of them: the whole-token term and the
 * parts belong to the SAME raw token, and a `Stage` chain sees only a flat token
 * list, which loses that pairing after the first split. So the stage does its
 * own whitespace split — the raw-token boundary — and runs the PARTS chain per
 * token internally.
 *
 * The parts chain is a PARAMETER rather than a hard-coded `porter-fold`, because
 * the identifier mechanism is orthogonal to which grammar stems the parts: a
 * copy per parts chain is a second place for the whole-token rule to drift away
 * from `identifierTermOf`, which the query side also reads.
 */
const identStageOver = (partsStages: readonly Stage[]): Stage => {
  const identTokensOf = (raw: string): readonly string[] => {
    const parts = partsStages.reduce<readonly string[]>((tokens, stage) => stage(tokens), [raw]);
    const whole = identifierTermOf(raw, parts);
    return whole === undefined ? parts : [whole, ...parts];
  };
  return tokens =>
    tokens
      .flatMap(token => token.split(WHITESPACE_SPLIT_RE))
      .filter(nonEmpty)
      .flatMap(identTokensOf);
};

export const identPorterFoldStage: Stage = identStageOver(PORTER_FOLD_STAGES);

export const identHuLightFoldStage: Stage = identStageOver(HULIGHT_FOLD_STAGES);

/**
 * The named analyzers. `porter-fold` IS the original behaviour —
 * `analyze(text, 'porter-fold')` reproduces `tokenize(text).map(stemTerm)` token
 * for token — three chains exist so folding and stemming can be switched off
 * INDEPENDENTLY (what a non-English corpus needs to be measured against), and
 * `ident-porter-fold` ADDS an unstemmed whole-token term for every
 * identifier-shaped raw token beside the `porter-fold` parts it already emits.
 *
 * `hulight-fold` swaps the Porter stage for the Hungarian light stemmer, and
 * `ident-hulight-fold` is to it exactly what `ident-porter-fold` is to
 * `porter-fold`. Both are CORPUS-SCOPED and opt-in — see `HULIGHT_FOLD_STAGES`.
 */
export const ANALYZERS = {
  'porter-fold': PORTER_FOLD_STAGES,
  'porter-nofold': [splitTokens, lowercaseTokens, stemTokens],
  'nostem-fold': [splitTokens, lowercaseTokens, foldTokens],
  'nostem-nofold': [splitTokens, lowercaseTokens],
  'ident-porter-fold': [identPorterFoldStage],
  'hulight-fold': HULIGHT_FOLD_STAGES,
  'ident-hulight-fold': [identHuLightFoldStage],
} as const satisfies Readonly<Record<string, readonly Stage[]>>;

/** The name of a chain in `ANALYZERS`. */
export type AnalyzerId = keyof typeof ANALYZERS;

/**
 * For each IDENT chain, the chain its PARTS come from — the ONE place that
 * pairing is written down.
 *
 * The query side (`toMatchExpression`) must analyze a chunk with the PARTS chain
 * rather than with the ident chain, because the ident chain flattens the
 * whole-token term into the same list as the parts and the adapter would then
 * weld them into one nonsense phrase. Keyed on the chain id, not on a literal:
 * a query path that recognised only `ident-porter-fold` would silently do that
 * welding for every ident chain added after it.
 */
const IDENT_PARTS_ANALYZERS: ReadonlyMap<AnalyzerId, AnalyzerId> = new Map<AnalyzerId, AnalyzerId>([
  ['ident-porter-fold', 'porter-fold'],
  ['ident-hulight-fold', 'hulight-fold'],
]);

/** The parts chain of an ident chain, or `undefined` when `id` is not one. */
export const partsAnalyzerOf = (id: AnalyzerId): AnalyzerId | undefined =>
  IDENT_PARTS_ANALYZERS.get(id);

/**
 * The default everywhere.
 *
 * `ident-porter-fold` shipped as the default, was measured against it on the
 * post-boundary corpus (BM25 first stage, both arms at one sha, after one
 * tightening pass) and REVERTED: `vault` nDCG@10 -0.0155, p=0.0478, 95% CI
 * [-0.0317, -0.0014] — significant harm on the primary corpus, with `scifact`
 * -0.0097 (p=0.1286) and `nfcorpus` null beside it. It stays reachable as an
 * explicit `--analyzer ident-porter-fold` (it carries a non-significant
 * Hungarian signal, `vault-hu` +0.0416, p=0.1557); MUST NOT be re-proposed as
 * the default without a new measurement.
 */
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
