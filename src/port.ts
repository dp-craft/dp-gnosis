import type { AtomDomain } from './config.js';

/**
 * Whether a retrieval leg actually ran, and against what.
 *
 * The split is load-bearing: without it a MISSING index is indistinguishable
 * from a working search that legitimately found nothing, which later lets an
 * evaluation silently compare off-vs-off and report it as a null result.
 *
 * - `ready` — a real search ran against an index current with the corpus.
 * - `empty` — a real search ran, but the corpus/index holds no atoms.
 * - `stale` — a real search ran, but the index is older than the corpus, so
 *   RANKING may lag the current atoms.
 * - `unavailable` — no index exists; no search happened at all.
 */
export type IndexState = 'ready' | 'empty' | 'stale' | 'unavailable';

/** One atom returned by a retrieval call. */
export interface RetrievedAtom {
  readonly id: string;
  readonly title: string;
  readonly domain: AtomDomain;
  readonly body: string;
  readonly score: number;
  readonly sourcePath: string;
}

/** Caller-supplied retrieval knobs. */
export interface RetrieveOptions {
  readonly k: number;
  readonly domain?: AtomDomain;
}

/** The outcome of one retrieval call. */
export interface RetrievalResult {
  readonly atoms: readonly RetrievedAtom[];
  /** Names which legs ran (e.g. the lexical/vector combination used). */
  readonly mode: string;
  readonly indexState: IndexState;
}

/**
 * The binding contract every knowledge adapter implements.
 *
 * The `query` is a plain string so every adapter receives a BYTE-IDENTICAL
 * one; query construction lives ABOVE the port, never inside an adapter.
 *
 * Port rule — the returned atom `body` MUST be read from disk at call time,
 * regardless of what the adapter stores internally. It is stated here, at the
 * port, and not as an index rule, because a document store cannot structurally
 * omit its text column: only the port boundary can guarantee that what a
 * caller reads is the atom currently on disk.
 */
export interface KnowledgePort {
  readonly name: string;
  retrieve(query: string, opts: RetrieveOptions): Promise<RetrievalResult>;
  /**
   * Release whatever this instance holds open between calls (a database handle,
   * prepared statements). OPTIONAL precisely because it is not universal: a
   * scan-based adapter keeps nothing open between calls and so has nothing to
   * release, and forcing it to implement an empty `close` would state a
   * lifecycle it does not have. A caller that owns a port SHOULD call it when
   * present (`port.close?.()`); calling it more than once MUST be harmless.
   */
  close?(): void;
}
