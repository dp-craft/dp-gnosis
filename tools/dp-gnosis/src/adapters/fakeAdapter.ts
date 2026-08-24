/**
 * A known-answer `KnowledgePort` fixture: its result is fixed at construction
 * and does not depend on the query text.
 *
 * Why it exists: the benchmark harness computes recall@k and MRR, and those
 * metrics must be validated against an adapter whose output is known in
 * advance. Without one, a metrics bug and a ranking bug are indistinguishable
 * the first time real numbers land.
 *
 * (The plan justified this module as "the bench is built before any real
 * adapter, so it cannot otherwise be tested". That rationale does not hold —
 * the linear-scan and FTS5 adapters land in an earlier phase than the bench.
 * The known-answer reason above is the one that earns the module its place.)
 *
 * It still honours the parts of the port contract the harness leans on — `k`
 * truncation and the `domain` filter — so that a harness bug cannot hide
 * behind fake-specific behaviour.
 */

import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';

/** `mode` reported by the fake, so a persisted report can never read as measured. */
const FAKE_MODE = 'fake';

const selectAtoms = (
  atoms: readonly RetrievedAtom[],
  opts: RetrieveOptions
): readonly RetrievedAtom[] => {
  const domains = opts.domains;
  const filtered =
    domains === undefined ? atoms : atoms.filter(atom => domains.includes(atom.domain));
  return filtered.slice(0, opts.k);
};

/**
 * Build a port that always answers with `atoms`, ignoring the query entirely.
 * `indexState` defaults to `'ready'`.
 */
export const createFakeAdapter = (
  atoms: readonly RetrievedAtom[],
  indexState: IndexState = 'ready'
): KnowledgePort => ({
  name: FAKE_MODE,
  retrieve: (_query: string, opts: RetrieveOptions): Promise<RetrievalResult> =>
    Promise.resolve({ atoms: selectAtoms(atoms, opts), mode: FAKE_MODE, indexState }),
});
