/**
 * Token budgeting for retrieved atoms.
 *
 * Every count here is an UPPER BOUND, never an average. The prior chars/4
 * convention under-counted real vault text by 3–6x (measured chars/token
 * bottoms out at 1.29), which is how oversize documents reached a reranker
 * that then rejected them mid-run.
 */

import { RETRIEVE_TOKEN_BUDGET } from './config.js';
import type { RetrievedAtom } from './port.js';

/**
 * Upper bound on the token count of `text`: its UTF-8 byte length.
 *
 * `tokens <= utf8ByteLength(text)` is a property of byte-fallback BPE, not a
 * coincidence — a byte-fallback tokenizer emits at most one token per byte, and
 * the bound held on all 4,201 vault atoms >=1000 chars plus 7 adversarial
 * synthetic inputs (emoji runs, CJK, hex dump, base64, combining marks, dense
 * accents, random Unicode) against two real tokenizers (XLM-R via
 * bge-reranker-v2-m3, Qwen via qwen3-reranker-0.6b). Zero violations.
 *
 * The margin deliberately left on the table, for a future tuner: measured
 * bytes/token on real atoms is ~3.8x at the median (prose median 3.76, fenced
 * code/diagram median 3.89) and 1.30x at the worst real atom (plain prose min;
 * p1 is 1.49). The worst synthetic input measured 1.15x. So this estimator
 * reserves roughly 3.8x the tokens a median atom actually costs, and only ~15%
 * headroom in the adversarial limit. Tightening it requires a real tokenizer
 * call — any cheaper heuristic reintroduces the under-count.
 *
 * @param text - Text to bound.
 * @returns UTF-8 byte length; 0 for the empty string.
 */
export const estimateTokens = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * One atom the budget could not admit. It carries the SIZE as well as the
 * identity because a warning without the size states a problem the caller
 * cannot act on — whether to raise the budget or fetch the file directly is a
 * decision about magnitude.
 */
export interface SkippedAtom {
  readonly id: string;
  readonly sourcePath: string;
  /** What the active measure charged for the body that did not fit. */
  readonly estimatedTokens: number;
}

/** What survived the budget, and what it cost to leave the rest out. */
export interface BudgetFit {
  readonly kept: readonly RetrievedAtom[];
  readonly skipped: readonly SkippedAtom[];
}

/** Running fit state: the atoms kept so far and the tokens they consume. */
interface FitState {
  readonly kept: readonly RetrievedAtom[];
  readonly skipped: readonly SkippedAtom[];
  readonly used: number;
}

const EMPTY_FIT: FitState = { kept: [], skipped: [], used: 0 };

const skippedOf = (atom: RetrievedAtom, estimatedTokens: number): SkippedAtom => ({
  id: atom.id,
  sourcePath: atom.sourcePath,
  estimatedTokens,
});

/**
 * What one atom costs the budget. INJECTED so the measure can be a real
 * tokenizer count without this module doing I/O: the counts are taken at the
 * command boundary and handed in already resolved, which keeps every function
 * here pure and synchronous.
 */
export type AtomMeasure = (atom: RetrievedAtom) => number;

/** The default measure: {@link estimateTokens} over the body, i.e. UTF-8 bytes. */
export const byteMeasure: AtomMeasure = (atom: RetrievedAtom): number =>
  estimateTokens(atom.body);

const admitIfFits =
  (maxTokens: number, measure: AtomMeasure) =>
    (state: FitState, atom: RetrievedAtom): FitState => {
      const cost = measure(atom);
      return state.used + cost > maxTokens
        ? { ...state, skipped: [...state.skipped, skippedOf(atom, cost)] }
        : { ...state, kept: [...state.kept, atom], used: state.used + cost };
    };

/**
 * Admit as many rank-ordered atoms as `maxTokens` holds, SKIPPING each one that
 * does not fit and continuing with the rest.
 *
 * Skip-and-continue rather than prefix truncation (decided 2026-08-13): a single
 * oversize atom used to discard every lower-ranked atom behind it, so one long
 * document could empty a whole result. Order among the kept atoms is unchanged —
 * skipping never promotes a lower-ranked atom above a higher-ranked one — and
 * every skipped atom stays REPORTED, so the caller can load it by path instead
 * of never learning it existed.
 *
 * @param atoms - Atoms in rank order.
 * @param maxTokens - Budget, measured with `measure`. Defaults to
 *   {@link RETRIEVE_TOKEN_BUDGET}.
 * @param measure - What one atom costs. Defaults to {@link byteMeasure}, so an
 *   unflagged call is byte-identical to the behaviour that preceded injection.
 * @returns The kept atoms and the skipped ones with their sizes.
 */
export const fitToTokenBudget = (
  atoms: readonly RetrievedAtom[],
  maxTokens: number = RETRIEVE_TOKEN_BUDGET,
  measure: AtomMeasure = byteMeasure
): BudgetFit => {
  const { kept, skipped } = atoms.reduce(admitIfFits(maxTokens, measure), EMPTY_FIT);
  return { kept, skipped };
};
