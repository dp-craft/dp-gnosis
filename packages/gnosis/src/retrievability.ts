import type { AtomFrontmatter } from './atom.js';

/**
 * READ-TIME filtering: the single predicate deciding whether an atom may be
 * RETURNED to a caller. Deliberately separate from `validate.ts`, which decides
 * what may be WRITTEN. EVERY adapter MUST call this one function so the rule
 * cannot drift between adapters — an adapter re-implementing "skip deprecated"
 * inline is how one retrieval path starts leaking known-wrong content.
 *
 * `now` is an injected parameter and `new Date()` is deliberately NOT read
 * inside: a time-dependent predicate cannot be asserted deterministically by
 * the conformance suite (case 15).
 */

/** Length of the `YYYY-MM-DD` date prefix of an ISO-8601 timestamp. */
const ISO_DATE_PREFIX_LENGTH = 10;

/** The UTC calendar day of `now`, in the `YYYY-MM-DD` shape `stale_after` uses. */
const utcDay = (now: Date): string => now.toISOString().slice(0, ISO_DATE_PREFIX_LENGTH);

/**
 * `stale_after` names the LAST day on which the atom is still valid, so the
 * boundary is STRICTLY past: equal to today's UTC day → still retrievable;
 * the following day → excluded. Both sides are compared as `YYYY-MM-DD`
 * strings, whose lexicographic order equals their chronological order.
 *
 * Decision recorded by the user: an expired atom is EXCLUDED. Deprioritizing
 * it in ranking, or annotating it as stale and still injecting it, were both
 * considered and rejected.
 *
 * The user also noted they see no strong use case for `stale_after` in a
 * knowledge base meant to be generic, so the field stays OPTIONAL and is
 * expected to be unused in the seed corpus — but the behaviour is defined and
 * asserted here rather than left emergent.
 */
const isExpired = (staleAfter: string | undefined, now: Date): boolean =>
  staleAfter !== undefined && staleAfter < utcDay(now);

/**
 * Whether an atom may reach a prompt. Excluded when it is `deprecated`
 * (knowingly-wrong content must never be injected) or expired per the boundary
 * rule above.
 */
export const isRetrievable = (frontmatter: AtomFrontmatter, now: Date): boolean =>
  frontmatter.status !== 'deprecated' && !isExpired(frontmatter.stale_after, now);
