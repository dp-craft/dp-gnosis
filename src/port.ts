import type { AtomFrontmatter } from './atom.js';
import type { AtomDomain, AtomType } from './config.js';
import { ATOM_DOMAINS, ATOM_TYPES } from './config.js';

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
 * - `mismatched` — an index exists but its STAMP refuses it: it describes a
 *   different corpus than the one on disk, or a schema this build cannot read.
 *   No search happened either, and the remedy differs from `unavailable`'s —
 *   the corpus is there, the index is the thing that must be rebuilt.
 *
 * `mismatched` is its own value rather than a second route to `unavailable`
 * precisely because `count: 0` under it is NOT the "it is not in the vault"
 * answer: nothing was asked of the corpus at all.
 */
export type IndexState = 'ready' | 'empty' | 'stale' | 'unavailable' | 'mismatched';

/**
 * WHERE IN its source document an atom sits, carried verbatim from the
 * frontmatter ingest wrote (snake_case on disk, camelCase on the port).
 *
 * Every field is ABSENT when the frontmatter did not carry it — an atom
 * ingested before these existed states nothing rather than claiming position 0
 * of 0 in a section named "". Presence is therefore itself the signal, exactly
 * as with `rerankScore`.
 *
 * None of them enters scoring, matching or ordering: they are what a consumer
 * needs to ORDER and GROUP the atoms it was already given.
 */
export interface AtomOrigin {
  /** `0`-based position among the atoms the source document produced. */
  readonly originIndex?: number;
  readonly originCount?: number;
  /** The `>`-joined section path, e.g. `Rerank > Fusion > RRF`. */
  readonly headingChain?: string;
  /** The source document's own one-line summary. */
  readonly summary?: string;
}

/**
 * The origin fields of one atom's frontmatter, as a spreadable fragment: an
 * absent field stays absent rather than becoming an explicit `undefined`. Shared
 * by every adapter so the port's key set cannot diverge per adapter.
 */
const originPosition = (frontmatter: AtomFrontmatter): AtomOrigin => ({
  ...(frontmatter.origin_index === undefined ? {} : { originIndex: frontmatter.origin_index }),
  ...(frontmatter.origin_count === undefined ? {} : { originCount: frontmatter.origin_count }),
});

const originContext = (frontmatter: AtomFrontmatter): AtomOrigin => ({
  ...(frontmatter.heading_chain === undefined ? {} : { headingChain: frontmatter.heading_chain }),
  ...(frontmatter.summary === undefined ? {} : { summary: frontmatter.summary }),
});

export const atomOrigin = (frontmatter: AtomFrontmatter): AtomOrigin => ({
  ...originPosition(frontmatter),
  ...originContext(frontmatter),
});

/** One atom returned by a retrieval call. */
export interface RetrievedAtom extends AtomOrigin {
  readonly id: string;
  readonly title: string;
  readonly domain: AtomDomain;
  /**
   * Always populated: unlike `x_domain`, a `type` outside the closed vocabulary
   * falls back to `DEFAULT_ATOM_TYPE` rather than dropping the atom. An unknown
   * domain means the atom was never indexed; an unknown type must not make an
   * indexed atom unreachable.
   */
  readonly type: AtomType;
  readonly body: string;
  readonly score: number;
  /**
   * The score BEFORE the rerank, and the raw cross-encoder score that reordered
   * it. Both are set ONLY on a reranked run — absent everywhere else, so a
   * first-pass atom is byte-identical to what it always was.
   *
   * `score` keeps its meaning: it is the FUSED score, the one that produced the
   * order it is printed beside. These two exist because that fused number is not
   * decomposable — a reader cannot tell an atom the reranker promoted from one
   * the first pass carried, and those are different kinds of evidence. They are
   * carried through the fusion BY IDENTITY (`rerankAtoms`), never re-looked-up
   * afterwards: a second lookup by index would silently misattribute a score the
   * moment the fusion reorders.
   *
   * `rerankScore` is absent on an atom the reranker did not return, which is a
   * fact about that atom, not a zero.
   */
  readonly firstPassScore?: number;
  readonly rerankScore?: number;
  readonly sourcePath: string;
  /**
   * The ORIGINAL document(s) the atom was cut from — its frontmatter `sources`,
   * repo-relative as ingest wrote them. Distinct from `sourcePath`, which is the
   * atom's OWN file under the atoms dir: one points at the derived artefact, the
   * other at the evidence, and a caller that must open the proof needs the
   * second.
   *
   * A LIST, never a single string: `AtomFrontmatter.sources` is
   * `readonly string[]`, so collapsing it would silently drop entries. Measured
   * 2026-08-14: all 11 345 vault atoms and all 5 202 SciFact probe atoms carry
   * exactly one, and `ingest` writes exactly one, so the 1:1 case is the only
   * one that occurs today — it is not the only one representable.
   *
   * EMPTY means the frontmatter named no source. Every disk-backed adapter is
   * structurally incapable of producing it (`parseAtom` refuses an atom with
   * zero sources), so it can only reach a rendering from a synthetic port. It
   * renders as OMISSION — no text line, no xml element — never as an empty
   * string; `--json` states the empty list verbatim.
   */
  readonly originPaths: readonly string[];
}

/** Caller-supplied retrieval knobs. */
export interface RetrieveOptions {
  readonly k: number;
  /**
   * A candidate passes when its domain is a MEMBER of this list. Absent means
   * unfiltered — every domain passes. An EMPTY list is refused rather than read
   * as "match nothing": a caller that computed an empty filter asked for a
   * result no query can produce, and silently returning zero atoms would
   * present that bug as an empty corpus.
   */
  readonly domains?: readonly AtomDomain[];
  /**
   * A candidate passes when its type is a MEMBER of this list. Absent means
   * unfiltered — every type passes. An EMPTY list is refused rather than read as
   * "match nothing": a caller that computed an empty filter asked for a result
   * no query can produce, and silently returning zero atoms would present that
   * bug as an empty corpus.
   */
  readonly types?: readonly AtomType[];
  /**
   * QUERY-SIDE adjacency treatment, honoured by `fts5` alone. When true, a raw
   * query token that analyzes to two or more terms contributes the multi-term
   * PHRASE as an extra disjunct BESIDE its individual terms — additive scoring,
   * never a filter: a candidate lacking the phrase still matches on the terms.
   * Absent or false is today's behaviour, byte for byte, on every adapter.
   */
  readonly adjacency?: boolean;
}

/** The single wording for "an empty type filter is a caller bug". */
export const EMPTY_TYPES_MESSAGE =
  `retrieve: "types" MUST name at least one type — omit it to search every type, or pass one of: ${ATOM_TYPES.join(' | ')}`;

/** Refuse an empty `types` at the port boundary, before any candidate is read. */
export const assertTypeFilter = (types: readonly AtomType[] | undefined): void => {
  if (types !== undefined && types.length === 0) throw new Error(EMPTY_TYPES_MESSAGE);
};

/**
 * The same wording on the domain axis. The vocabulary it prints is the LOADED
 * profile's, so a caller running under `--profile` is corrected with the domains
 * that instance really declares rather than the shipped ones.
 */
export const EMPTY_DOMAINS_MESSAGE =
  `retrieve: "domains" MUST name at least one domain — omit it to search every domain, or pass one of: ${ATOM_DOMAINS.join(' | ')}`;

/** Refuse an empty `domains` at the port boundary, before any candidate is read. */
export const assertDomainFilter = (domains: readonly AtomDomain[] | undefined): void => {
  if (domains !== undefined && domains.length === 0) throw new Error(EMPTY_DOMAINS_MESSAGE);
};

/** The outcome of one retrieval call. */
export interface RetrievalResult {
  readonly atoms: readonly RetrievedAtom[];
  /** Names which legs ran (e.g. the lexical/vector combination used). */
  readonly mode: string;
  readonly indexState: IndexState;
  /**
   * WHY the index was refused, present on `mismatched` alone. It names which
   * condition fired, both digests (or that one is absent) and the rebuild
   * command, so the caller needs no second call to act on it. Absent everywhere
   * else, so a searched run is byte-identical to what it always was.
   */
  readonly indexRefusal?: string;
  /**
   * The UN-TRUNCATED candidate pool `atoms` was cut from, best-first, for a
   * route whose whole point is that the cut throws information away: merging two
   * legs raises recall, and capping the merged order back to `k` gives most of
   * that gain straight back. `atoms` is still at most `k` — this is a SECOND
   * reading of the same call, never a wider answer to it, so `atoms` remains the
   * port's contract and every existing caller is unaffected.
   *
   * ABSENT on every route that has no such pool, which is all of them but
   * `lancedb-hybrid-full`. Its LENGTH is the realised pool size, which varies
   * with the query and with how much the two legs overlapped: a caller that
   * reports the pool reports `poolAtoms.length` rather than assuming a bound.
   * It cannot exceed `2 * k` — the pool is the union of two top-`k` lists — and
   * lands near `1.55 * k` on the real corpora, where the legs overlap heavily.
   */
  readonly poolAtoms?: readonly RetrievedAtom[];
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
