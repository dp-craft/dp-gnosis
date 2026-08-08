/**
 * Retrieval and authoring policy constants. Deliberately separate from
 * `paths.ts` (SRP): that module owns WHERE things live, this one owns the
 * limits and vocabulary an atom must satisfy.
 */

/**
 * Hard write-time cap on a single atom's body.
 *
 * Derivation: the injection budget is 2–3k tokens and a query returns top-k
 * 3–5 atoms, so one atom must stay near ~1000 tokens — 4000 characters at the
 * conventional 4 chars/token. Measured in CHARACTERS on purpose: it needs no
 * tokenizer dependency and is byte-deterministic across models.
 */
export const ATOM_MAX_CHARS = 4000;

/**
 * What the chunker aims for, leaving headroom so a sub-split (heading prefix,
 * source trailer) still lands under `ATOM_MAX_CHARS`.
 */
export const ATOM_CHUNK_TARGET_CHARS = 3200;

/**
 * Hard cap on how many terms a constructed retrieval query may carry.
 *
 * A task's targets, test contract and spec excerpts together run to thousands
 * of tokens, and BM25 scores a 2000-token blob nothing like a focused query:
 * every additional low-IDF term adds score mass to documents that match it
 * incidentally. 32 keeps the query in the range lexical scoring was designed
 * for while still admitting several distinct identifiers per input section.
 */
export const QUERY_MAX_TERMS = 32;

/**
 * The smoothing term of the BM25 inverse-document-frequency formula
 * `ln(1 + (N - n + 0.5) / (n + 0.5))`, where N is the corpus size and n the
 * number of documents containing the term. It appears on both sides of that
 * fraction and is ONE quantity, so it is owned here and imported by every
 * scorer — a per-file copy would let the two implementations drift apart.
 */
export const BM25_IDF_SMOOTHING = 0.5;

/**
 * The closed `x_domain` vocabulary. An unknown domain is REFUSED at write
 * time: a free-form string fragments on typos and makes an atom silently
 * invisible to every domain-filtered query.
 */
export const ATOM_DOMAINS = ['runner', 'standards', 'adr'] as const;

/** A member of the closed domain vocabulary. */
export type AtomDomain = (typeof ATOM_DOMAINS)[number];

/** One mechanical assignment rule: repo-relative path prefix → domain. */
export interface SourceRootDomain {
  readonly prefix: string;
  readonly domain: AtomDomain;
}

/**
 * The mechanical source→domain assignment table, longest-prefix-wins. Ingest
 * MUST derive `x_domain` from this alone, so re-running over unchanged input
 * reproduces identical domains.
 */
export const SOURCE_ROOT_DOMAINS: readonly SourceRootDomain[] = [
  { prefix: 'RUNNER-', domain: 'runner' },
  { prefix: 'tools/agentic-code-runner/', domain: 'runner' },
  { prefix: 'claude-artifacts/standards/', domain: 'standards' },
  { prefix: 'doc/40-code-standards/90-decisions/', domain: 'adr' },
];

const LONGEST_PREFIX_FIRST: readonly SourceRootDomain[] = [...SOURCE_ROOT_DOMAINS].sort(
  (a, b) => b.prefix.length - a.prefix.length
);

/**
 * Resolve the domain for a repo-relative source path, or `undefined` when no
 * declared root claims it (such a source is out of scope for ingest).
 */
export const domainForSource = (repoRelativePath: string): AtomDomain | undefined =>
  LONGEST_PREFIX_FIRST.find(rule => repoRelativePath.startsWith(rule.prefix))?.domain;
