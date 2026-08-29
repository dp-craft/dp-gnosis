/**
 * The profile-derived half of the retrieval vocabulary: the domain and type
 * label sets, the path→label tables, and the retrieve-time exclusion default.
 *
 * Every export is a FUNCTION, and that is the whole point of the module. The
 * same values used to be module-level `const`s in `config.ts`, which meant
 * `loadIngestProfile(INGEST_PROFILE_PATH)` ran at IMPORT time: importing any
 * module that transitively reached `config.ts` read a fixed file off disk. In
 * the product the profile is the USER'S, chosen at run time, so a fixed path
 * read at import is not merely early — it reads the wrong file. Resolution is
 * therefore LAZY (first call, not import) and MEMOIZED (one read per process),
 * and `setActiveProfile` lets a caller install the profile it loaded.
 *
 * `paths.ts` owns WHERE things live and `config.ts` owns the pure constants;
 * this module owns the DATA the shipped profile carries.
 */
import { DECLARED_TYPES, expectVocabulary } from './config.js';
import type { IngestProfile } from './ingestProfile.js';
import { domainForPath, loadIngestProfile, typeForPath } from './ingestProfile.js';
import { ingestProfilePath } from './paths.js';

/**
 * A domain label. Unbranded on purpose: the valid set is whatever profile is
 * loaded, so no compile-time union can state it without lying about the other
 * profiles.
 */
export type AtomDomain = string;

/**
 * A member of the closed type vocabulary — the STATIC union of
 * {@link DECLARED_TYPES}, never narrowed to the loaded profile. A profile
 * declaring fewer types is a narrower CORPUS, not a narrower type system: the
 * types it omits simply return no results, and `expectVocabulary` returns the
 * full tuple for exactly that reason.
 */
export type AtomType = (typeof DECLARED_TYPES)[number];

/** One mechanical assignment rule: repo-relative path prefix → domain. */
export interface SourceRootDomain {
  readonly prefix: string;
  readonly domain: AtomDomain;
}

/** One mechanical assignment rule: repo-relative path prefix → type. */
export interface SourceRootType {
  readonly prefix: string;
  readonly type: AtomType;
}

/**
 * The memo, held in a Map rather than a rebindable binding so the module keeps
 * one mutation verb (`set` / `clear`) and no reassignment.
 */
const ACTIVE_KEY = 'active';
const resolved = new Map<string, IngestProfile>();

/**
 * Install the profile every vocabulary reader resolves against — what a CLI
 * calls once it has loaded the instance the caller named. It REPLACES whatever
 * was resolved before, so an installed profile is never merged with the shipped
 * one: a half-installed vocabulary would label a corpus from two sources.
 */
export const setActiveProfile = (profile: IngestProfile): void => {
  resolved.set(ACTIVE_KEY, profile);
};

/**
 * Drop the installed profile AND the memoized default, so the next read
 * resolves from scratch. It exists for tests: without it the first test to
 * touch the vocabulary would decide it for every test after, making the suite
 * order-dependent.
 */
export const resetActiveProfile = (): void => {
  resolved.clear();
};

/** Memoize the shipped profile as the active one — the default nobody set. */
const loadShipped = (): IngestProfile => {
  const shipped = loadIngestProfile(ingestProfilePath());
  resolved.set(ACTIVE_KEY, shipped);
  return shipped;
};

/**
 * The profile the vocabulary is read from: whatever was installed, else the
 * shipped one, loaded on FIRST CALL and never re-read. A missing or malformed
 * data file stops the process with the defect named instead of relabelling a
 * whole corpus from built-in values.
 */
export const activeProfile = (): IngestProfile => resolved.get(ACTIVE_KEY) ?? loadShipped();

/** Narrow a profile-declared label to its union member, refusing anything else. */
const expectMember = <T extends string>(value: string, vocabulary: readonly T[], field: string): T => {
  const known = vocabulary.find(member => member === value);
  if (known === undefined) {
    throw new Error(
      `ingest profile "${ingestProfilePath()}" resolved ${field} "${value}", outside the closed vocabulary — replace it with one of ${vocabulary.join(' | ')}`
    );
  }
  return known;
};

/**
 * The `x_domain` vocabulary of the ACTIVE profile — open by profile, so a new
 * knowledge domain onboards with a profile file and no TypeScript edit. An
 * unknown domain is still REFUSED, and twice: `parseIngestProfile` rejects a
 * rule naming a label the profile never declares, and ingest rejects the label
 * at write time, because a free-form string fragments on typos and makes an
 * atom silently invisible to every domain-filtered query. Both refusals happen
 * BEFORE an atom exists, so the index side does not re-check — a second check
 * there, against the DEFAULT profile, dropped every atom of any other profile
 * at index time with no diagnostic anywhere.
 */
export const atomDomains = (): readonly AtomDomain[] => activeProfile().domains;

/**
 * The closed `type` vocabulary. Unlike {@link atomDomains} this one stays
 * CLOSED — an unknown type is REFUSED at write time, because a typo would make
 * the atom silently invisible to every type-filtered query.
 *
 * It returns the FULL declared tuple, never the profile's subset: it is
 * consumed as "every valid label" by the port, the CLI and every adapter's
 * `asType` fallback, and returning the subset would make {@link AtomType} lie.
 */
export const atomTypes = (): readonly AtomType[] =>
  expectVocabulary(activeProfile().types, DECLARED_TYPES, 'types');

/** The type of a source no prefix and no segment rule claims. */
export const defaultAtomType = (): AtomType =>
  expectMember(activeProfile().defaultType, atomTypes(), 'defaultType');

/**
 * The source→domain assignment table the profile declares (`domainRules`).
 * Ingest MUST derive `x_domain` from this alone, so re-running over unchanged
 * input reproduces identical domains. Resolution is longest-prefix-wins; the
 * rows keep their declaration order so a caller may render the table as
 * authored.
 */
export const sourceRootDomains = (): readonly SourceRootDomain[] =>
  activeProfile().domainRules.map(rule => ({
    prefix: rule.prefix,
    domain: expectMember(rule.domain, atomDomains(), 'domainRules[].domain'),
  }));

/**
 * The source→type assignment table (`typeRules`), read exactly as
 * {@link sourceRootDomains} is. A segment rule (also in the profile) overrides
 * every prefix rule.
 */
export const sourceRootTypes = (): readonly SourceRootType[] =>
  activeProfile().typeRules.map(rule => ({
    prefix: rule.prefix,
    type: expectMember(rule.type, atomTypes(), 'typeRules[].type'),
  }));

/**
 * Resolve the domain for a repo-relative source path, or `undefined` when no
 * declared root claims it (such a source is out of scope for ingest).
 */
export const domainForSource = (repoRelativePath: string): AtomDomain | undefined => {
  const domain = domainForPath(activeProfile(), repoRelativePath);
  return domain === undefined ? undefined : expectMember(domain, atomDomains(), 'x_domain');
};

/**
 * Resolve the type for a repo-relative source path. Unlike the domain, an
 * unclaimed source is not out of scope — it simply keeps the `knowledge`
 * fallback.
 */
export const typeForSource = (repoRelativePath: string): AtomType =>
  expectMember(typeForPath(activeProfile(), repoRelativePath), atomTypes(), 'type');

/**
 * The types the CLI hides from `search` unless the caller asks for them, as
 * declared by the profile (`defaultExcludedTypes`). It is a PRESENTATION
 * default and lives on the CLI path alone: nothing in ingest, the port or an
 * adapter reads it, so a corpus still holds every atom and the bench — which
 * calls the port directly — measures exactly what it always measured.
 *
 * Each value is narrowed against {@link atomTypes}, so a profile naming a type
 * outside the closed vocabulary stops the process with the defect named instead
 * of silently excluding nothing. An absent key reads as an empty list.
 */
export const defaultExcludedTypes = (): readonly AtomType[] =>
  (activeProfile().defaultExcludedTypes ?? []).map(value =>
    expectMember(value, atomTypes(), 'defaultExcludedTypes[]')
  );
