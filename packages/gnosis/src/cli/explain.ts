/**
 * WHY an atom is in the answer — the presentation half of a ranking.
 *
 * A score alone is unreadable: it has no unit, no scale and no connection to the
 * words that earned it. These three fields answer the three questions a reader
 * actually has — which query terms the atom carries, where in the body it
 * carries them, and how the score reads against the rest of THIS answer.
 *
 * They live in the CLI, never on `RetrievedAtom`: they are computed from the
 * atom and the query after ranking, so putting them on the port's type would
 * make every adapter responsible for a rendering decision, and a caller could
 * not tell a stored value from a derived one.
 *
 * The overlap is ANALYSED, not raw: the adapters match stems, so a `matchedTerms`
 * built from surface words would report a miss on exactly the term that produced
 * the hit.
 */
import type { RetrievedAtom } from '../port.js';
import { analyze } from '../query.js';

/**
 * The snippet ceiling. Wide enough for the sentence around a hit and its
 * neighbours, narrow enough that a `-k 10` answer stays readable in one screen.
 */
export const SNIPPET_MAX_CHARS = 400;

/** The analysed query terms the body carries, deduped, in QUERY order. */
export const matchedTerms = (query: string, body: string): readonly string[] => {
  const carried = new Set(analyze(body));
  return [...new Set(analyze(query))].filter(term => carried.has(term));
};

/** Word runs, with their offsets — the positions a window is measured over. */
const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * Where each matched term OCCURS in the raw body. A word is located by its raw
 * offset and judged by its analysed form, which is the only way a stemmed term
 * can point at the surface text it came from.
 */
const occurrences = (body: string, terms: ReadonlySet<string>): readonly number[] =>
  [...body.matchAll(WORD_RE)]
    .filter(match => analyze(match[0]).some(term => terms.has(term)))
    .map(match => match.index ?? 0);

const countFrom = (starts: readonly number[], from: number): number =>
  starts.filter(start => start >= from && start < from + SNIPPET_MAX_CHARS).length;

/**
 * The densest window, anchored on an OCCURRENCE: a window holding the maximum
 * can always be slid until it starts on one, so the anchors are the only
 * candidates worth scoring. A tie keeps the EARLIEST, since `starts` ascends and
 * the comparison is strict.
 */
const densestStart = (starts: readonly number[]): number =>
  starts.reduce(
    (best, start) => (countFrom(starts, start) > countFrom(starts, best) ? start : best),
    starts[0] ?? 0
  );

/** Back to just after the preceding whitespace, so the window opens on a word. */
const snapStart = (body: string, start: number): number => {
  const gap = /\s\S*$/.exec(body.slice(0, start));
  return gap === null ? 0 : gap.index + 1;
};

/** The body's own end, or a boundary the next character already makes clean. */
const endsCleanly = (body: string, end: number): boolean =>
  end >= body.length || /\s/.test(body[end] ?? '');

/** Forward end, pulled back to the last whitespace so the window closes on a word. */
const snapEnd = (body: string, start: number): number => {
  const end = Math.min(body.length, start + SNIPPET_MAX_CHARS);
  if (endsCleanly(body, end)) return end;
  const gap = /\s(?=\S*$)/.exec(body.slice(start, end));
  return gap === null ? end : start + gap.index;
};

/**
 * The ≤`SNIPPET_MAX_CHARS` window of `body` holding the most occurrences of
 * `terms`. No match reads as "show the head" rather than "show nothing": an atom
 * that survived the budget is still part of the answer.
 *
 * A body that already fits IS the window: it holds every occurrence there is, so
 * anchoring on the first one would drop leading text for no gain.
 */
export const snippetOf = (body: string, terms: readonly string[]): string => {
  if (body.length <= SNIPPET_MAX_CHARS) return body;
  const starts = occurrences(body, new Set(terms));
  if (starts.length === 0) return body.slice(0, SNIPPET_MAX_CHARS);
  const start = snapStart(body, densestStart(starts));
  return body.slice(start, snapEnd(body, start));
};

/**
 * Min-max over the RETURNED atoms, or `null`.
 *
 * `null` is not a missing value — it is the honest answer for a set that carries
 * no relative signal. A single atom has nothing to be relative TO, and a FLAT
 * set would normalise every member to 1, presenting "all scores equal" as "every
 * atom is a perfect match" — the project's recurring failure class, a
 * plausible-looking number standing in for no information.
 */
const normalise = (scores: readonly number[]): readonly (number | null)[] => {
  if (scores.length < 2) return scores.map(() => null);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => null);
  return scores.map(score => (score - min) / (max - min));
};

/** One returned atom, plus the three fields that make its score readable. */
export interface ExplainedAtom extends RetrievedAtom {
  readonly matchedTerms: readonly string[];
  readonly snippet: string;
  readonly scoreNormalised: number | null;
}

/**
 * `query` MUST be the text actually SEARCHED — the rewrite when `--rephrase`
 * rewrote one. Explaining a ranking with the query the user typed rather than
 * the one the engine ran would attribute the hits to words no adapter ever saw.
 */
export const explainAtoms = (
  query: string,
  atoms: readonly RetrievedAtom[]
): readonly ExplainedAtom[] => {
  const normalised = normalise(atoms.map(atom => atom.score));
  return atoms.map((atom, index) => {
    const terms = matchedTerms(query, atom.body);
    return {
      ...atom,
      matchedTerms: terms,
      snippet: snippetOf(atom.body, terms),
      scoreNormalised: normalised[index] ?? null,
    };
  });
};
