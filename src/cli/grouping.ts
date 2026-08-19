/**
 * How a ranked answer is ARRANGED for reading: several atoms cut from one source
 * document are delivered together, in the order the author wrote them, and no
 * single document may flood the answer.
 *
 * Pure by construction — no I/O, no config, no clock. It takes the ranking it is
 * given and returns another ordering of the same atoms, so it can be proved
 * against synthetic rankings without a corpus, and so it cannot change WHICH
 * atoms scored what: the cap subtracts, the grouping reorders, neither scores.
 *
 * The two rules, and why each is not the obvious one:
 *
 * - A document's RANK is its BEST atom's rank, but the order INSIDE it is
 *   reading order (`originIndex`), never score. A reader quoting the answer
 *   reads the source top-down; `(2/7)` printed above `(1/7)` reverses the
 *   author's argument while looking correctly ranked.
 * - The cap is applied to the POOL, before the `-k` slice. Applied after it, a
 *   dropped atom would shrink the answer instead of freeing a slot, and `-k 5`
 *   would silently deliver 3 whenever one document held the best atoms.
 */
import type { RetrievedAtom } from '../port.js';

/**
 * At most this many atoms from any one source document, unless the caller says
 * otherwise. Two is the smallest cap that can still show a claim beside its
 * neighbour, which is the reason to group at all.
 */
export const DEFAULT_MAX_PER_DOC = 2;

/** The spelling of "cap nothing": one flag then carries both the cap and its absence. */
export const NO_CAP = 0;

/**
 * The DEEPEST a capped first pass must reach, floor not cap.
 *
 * `k * cap` alone is INVERTED: a tighter cap needs a DEEPER pool, because
 * delivering `k` atoms at `cap` per document takes `ceil(k / cap)` DISTINCT
 * documents in the pool, and at `cap = 1` that is `k` documents — which a pool
 * of `k` atoms supplies only when no two of them share a document. Measured on
 * the vault: `-k 10 --max-per-doc 1` fetched 10 atoms spanning 5 documents and
 * delivered 5.
 *
 * 100 mirrors `RERANK_K_INIT`, the other pool floor in this CLI, and costs
 * nothing on the BM25 path, which has no network hop: the first pass is a local
 * index scan whose depth is already paid for. It is a FLOOR, so a caller asking
 * for more than it keeps its own depth.
 */
export const GROUPED_POOL_FLOOR = 100;

/** One source document's atoms, in reading order, under the document's identity. */
export interface DocumentGroup {
  readonly document: string;
  readonly atoms: readonly RetrievedAtom[];
}

/**
 * The document an atom belongs to. `originPaths[0]` is the same rollup the
 * benchmark scores at, so grouping and measurement agree on what "one document"
 * means. An atom naming no origin stands as its own document rather than joining
 * a shared empty bucket — an empty `originPaths` is a fact about that atom, not
 * a document every such atom shares.
 */
const documentOf = (atom: RetrievedAtom): string => atom.originPaths[0] ?? atom.sourcePath;

/**
 * An atom carrying no `originIndex` sorts LAST rather than first: it states no
 * position, and placing it at 0 would assert one. It is never dropped — atoms
 * ingested before the field existed are still answers.
 */
const UNPLACED = Number.MAX_SAFE_INTEGER;

const readingKey = (atom: RetrievedAtom): number => atom.originIndex ?? UNPLACED;

/** Stable, so two unplaced atoms keep the rank order they arrived in. */
const inReadingOrder = (atoms: readonly RetrievedAtom[]): readonly RetrievedAtom[] =>
  [...atoms].sort((left, right) => readingKey(left) - readingKey(right));

/**
 * The ranking partitioned by source document. Group order is the order the
 * documents FIRST appear, which on a ranked input is best-rank order; atom order
 * within a group is reading order.
 */
export const groupByDocument = (atoms: readonly RetrievedAtom[]): readonly DocumentGroup[] =>
  [...new Set(atoms.map(documentOf))].map(document => ({
    document,
    atoms: inReadingOrder(atoms.filter(atom => documentOf(atom) === document)),
  }));

const takenBefore = (
  atoms: readonly RetrievedAtom[],
  index: number,
  document: string
): number => atoms.slice(0, index).filter(prior => documentOf(prior) === document).length;

/**
 * At most `maxPerDoc` atoms per source document, keeping the ranking order of
 * those it kept. SUBTRACTIVE and rank-preserving: it never reorders and never
 * promotes an atom past one it kept — the promotion callers see comes from the
 * `-k` slice landing further down a shorter list.
 *
 * `NO_CAP` returns the input untouched, so "no cap" costs no copy and cannot
 * reorder anything.
 */
export const capPerDocument = (
  atoms: readonly RetrievedAtom[],
  maxPerDoc: number
): readonly RetrievedAtom[] =>
  maxPerDoc <= NO_CAP
    ? atoms
    : atoms.filter((atom, index) => takenBefore(atoms, index, documentOf(atom)) < maxPerDoc);

/**
 * The atom's reading position as `(i/n)`, one-based against its document's atom
 * count. An atom missing either field renders the EMPTY string — the marker is
 * omitted, never defaulted: a `(1/1)` printed over an atom that stated no
 * position would claim its document holds one atom.
 */
export const positionMarker = (atom: RetrievedAtom): string =>
  atom.originIndex === undefined || atom.originCount === undefined
    ? ''
    : `(${atom.originIndex + 1}/${atom.originCount})`;
