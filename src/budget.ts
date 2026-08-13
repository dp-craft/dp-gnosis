/**
 * Token budgeting for retrieved atoms.
 *
 * Every count here is an UPPER BOUND, never an average. The prior chars/4
 * convention under-counted real vault text by 3–6x (measured chars/token
 * bottoms out at 1.29), which is how oversize documents reached a reranker
 * that then rejected them mid-run.
 */

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

/** Running fit state: the atoms kept so far and the tokens they consume. */
interface FitState {
  readonly kept: readonly RetrievedAtom[];
  readonly used: number;
  readonly stopped: boolean;
}

const EMPTY_FIT: FitState = { kept: [], used: 0, stopped: false };

const addIfFits =
  (maxTokens: number) =>
    (state: FitState, atom: RetrievedAtom): FitState => {
      if (state.stopped) return state;
      const next = state.used + estimateTokens(atom.body);
      if (next > maxTokens) return { ...state, stopped: true };
      return { kept: [...state.kept, atom], used: next, stopped: false };
    };

/**
 * Take the longest rank-ordered prefix of `atoms` whose bodies fit `maxTokens`.
 *
 * Order is preserved and truncation is a PREFIX: the walk stops at the first
 * atom that would exceed the budget rather than skipping it to fit a smaller
 * lower-ranked one, so the caller never receives a set that silently reorders
 * relevance. Returns empty when even the first atom does not fit.
 *
 * @param atoms - Atoms in rank order.
 * @param maxTokens - Budget, measured with {@link estimateTokens}.
 * @returns The kept prefix.
 */
export const fitToTokenBudget = (
  atoms: readonly RetrievedAtom[],
  maxTokens: number
): readonly RetrievedAtom[] => atoms.reduce(addIfFits(maxTokens), EMPTY_FIT).kept;
