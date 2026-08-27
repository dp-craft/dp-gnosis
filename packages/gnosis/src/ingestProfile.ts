import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { expandUserPath } from './env.js';

import type { PrfParams } from './prf.js';
import type { AnalyzerId } from './query.js';
import { ANALYZERS } from './query.js';

/**
 * The ingest PROFILE: the closed label vocabularies and the mechanical
 * path→label tables, loaded from a data file instead of being spelled in code.
 *
 * What this module owns is the MECHANISM, and the mechanism is unchanged by the
 * move: longest-prefix-wins domain and type resolution, a segment rule that
 * overrides every prefix rule, and REFUSAL at write time of a label outside the
 * vocabulary — never a silent fallback to a guessed label.
 *
 * A missing or malformed profile is a hard error naming the file and the exact
 * defect. Falling back to built-in values would relabel a whole corpus in
 * silence, and the only symptom would be queries that quietly stop matching.
 */

/** One mechanical assignment rule: source-path prefix → domain. */
export interface ProfileDomainRule {
  readonly prefix: string;
  readonly domain: string;
}

/** One mechanical assignment rule: source-path prefix → type. */
export interface ProfileTypeRule {
  readonly prefix: string;
  readonly type: string;
}

/** A whole-path-segment rule: any path containing the segment takes the type. */
export interface ProfileSegmentRule {
  readonly segment: string;
  readonly type: string;
}

/**
 * One complete, named instance: the vocabulary and labelling policy PLUS where
 * that instance keeps its corpus, its atoms and its index.
 *
 * `name` is the profile ID — the identity an atoms directory is stamped with
 * (see `ATOMS_OWNER_FILE`), so two instances that share a directory are caught
 * instead of overwriting each other.
 *
 * Every location is OPTIONAL, and that is the whole compatibility story: a
 * profile that states none behaves exactly as before, and a CLI flag still
 * outranks whatever a profile does state (flag > profile > default).
 */
export interface IngestProfile {
  readonly name: string;
  readonly domains: readonly string[];
  readonly types: readonly string[];
  /** The type of a source no prefix and no segment rule claims. */
  readonly defaultType: string;
  readonly domainRules: readonly ProfileDomainRule[];
  readonly typeRules: readonly ProfileTypeRule[];
  readonly segmentRules: readonly ProfileSegmentRule[];
  /** Root the corpus roots are walked under and `sources` is made relative to. */
  readonly repoRoot?: string | undefined;
  /**
   * Roots this instance ingests — its corpus SCOPE. A relative root is walked
   * under `repoRoot`; an ABSOLUTE one, or one starting `~/`, is walked where it
   * points, so one index can span trees that share no parent.
   */
  readonly corpusRoots?: readonly string[] | undefined;
  /** Where this instance's atoms are written and read. */
  readonly atomsDir?: string | undefined;
  /** Where this instance's index is built; a DIRECTORY for lancedb. */
  readonly indexPath?: string | undefined;
  /**
   * The golden-set directory (or single file) this instance breaks EXACT-BODY
   * DEDUPE TIES against, stated here so the shipped path names its own gold
   * source instead of inheriting an invisible default. Absent means no gold
   * tie-break at all — the first copy by sorted source path wins — which is the
   * only case allowed to be silent, because it is the case the profile ASKED
   * for. A declared path that cannot be read REFUSES the ingest.
   */
  readonly goldIdsPath?: string | undefined;
  /**
   * Hard cap on one atom's body, in characters. Absent means the shipped
   * `ATOM_MAX_CHARS`, so an existing profile chunks exactly as before.
   *
   * It is per-instance because it is a property of the CORPUS, not of the tool:
   * a BEIR abstract is one indivisible passage of up to ten thousand characters
   * and splitting it fabricates documents the ground truth does not label,
   * while the repo vault's long authored sections genuinely need the split.
   */
  readonly atomMaxChars?: number | undefined;
  /**
   * Repo-relative path prefixes this instance MUST NOT ingest, matched exactly
   * as a domain rule's prefix is. It stays REPO-RELATIVE-ONLY even though a
   * corpus root may now be absolute: an absolute prefix is still refused by
   * name, so a tree reached through an absolute root cannot be partially
   * excluded — declare a narrower root instead.
   * Absent means nothing is excluded, so an existing profile walks the same
   * corpus it always did.
   */
  readonly excludePaths?: readonly string[] | undefined;
  /**
   * Type names the CLI retrieve path leaves out unless a caller asks for them.
   * It is a PRESENTATION default, not a corpus one: every such atom is still
   * ingested and still indexed, so a benchmark measures the full corpus.
   */
  readonly defaultExcludedTypes?: readonly string[] | undefined;
  /**
   * The RM3 feedback cell the CLI retrieve path expands with unless a caller
   * says otherwise. Like `defaultExcludedTypes` it is a RETRIEVE-TIME default,
   * never a corpus one: ingest, the port and every adapter ignore it, so the
   * bench — which calls the port directly — measures exactly what it always
   * measured. ABSENT means no feedback pass at all, so a profile that states
   * none retrieves byte for byte as before.
   */
  readonly defaultPrf?: PrfParams | undefined;
  /**
   * Repo-relative path of this instance's SUMMARY SIDECAR — the `source path →
   * summary` table ingest fills a document's summary from when the document
   * itself declares no `LLM-PRIMARY` comment. Absent means no sidecar, so a
   * profile that states none ingests byte for byte as before.
   */
  readonly summarySidecar?: string | undefined;
  /**
   * The analyzer chain this instance BUILDS ITS INDEX WITH. It is an
   * index-build default, not a retrieve-time one: the chain is STAMPED into the
   * index and the query side reads the stamp back, so query and index can never
   * disagree about how a term was analyzed — stating it here changes one build,
   * never one query in isolation. ABSENT means `DEFAULT_ANALYZER`, so an
   * existing profile builds the same index byte for byte.
   *
   * It is CORPUS-scoped for the same reason `atomMaxChars` is: a
   * language-specific chain is a property of the documents, not of the tool, and
   * one that pays on this corpus COSTS accuracy on another language's. A chain
   * measured on one vault MUST therefore be stated by that vault's profile
   * rather than promoted to the shipped default.
   */
  readonly defaultAnalyzer?: AnalyzerId | undefined;
  /**
   * How many first-pass candidates the CLI's rerank leg scores. Like
   * `defaultPrf` it is a RETRIEVE-TIME default and never a corpus one: ingest,
   * the port and the bench ignore it. ABSENT means `RERANK_K_INIT`, so an
   * existing profile reranks exactly the pool it always did.
   *
   * It is per-instance because the pool's cost is per-CORPUS: a small vault is
   * fully covered far below the shipped depth, and paying for 100 candidates it
   * does not have buys nothing.
   */
  readonly rerankPoolK?: number | undefined;
}

/**
 * The half a profile states as OPTIONAL keys: what it leaves out of the corpus
 * and of a result, and the feedback cell a result expands with. Every member is
 * absent-means-unchanged, which is what keeps an external profile working.
 */
type ProfileDefaults = Pick<
  IngestProfile,
  | 'excludePaths'
  | 'defaultExcludedTypes'
  | 'defaultPrf'
  | 'summarySidecar'
  | 'defaultAnalyzer'
  | 'rerankPoolK'
>;

/** The location half of a profile — what T-3 added to the vocabulary half. */
type ProfileLocations = Pick<
  IngestProfile,
  'repoRoot' | 'corpusRoots' | 'atomsDir' | 'indexPath' | 'goldIdsPath'
>;

/** Keys carrying authored rationale rather than data; every other key is unknown. */
const COMMENT_KEY_PREFIX = 'comment:';

const KNOWN_KEYS: readonly string[] = [
  'name',
  'domains',
  'types',
  'defaultType',
  'domainRules',
  'typeRules',
  'segmentRules',
  'repoRoot',
  'corpusRoots',
  'atomsDir',
  'indexPath',
  'goldIdsPath',
  'atomMaxChars',
  'excludePaths',
  'defaultExcludedTypes',
  'defaultPrf',
  'summarySidecar',
  'defaultAnalyzer',
  'rerankPoolK',
];

const fail = (source: string, detail: string): never => {
  throw new Error(`ingest profile "${source}" ${detail}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

/** Where a defect sits: the file that declared it and the field that carries it. */
interface FieldRef {
  readonly source: string;
  readonly where: string;
}

/** The file plus the vocabulary one rule list is checked against. */
interface RuleContext {
  readonly source: string;
  readonly vocabulary: readonly string[];
}

const stringField = (
  raw: Readonly<Record<string, unknown>>,
  key: string,
  ref: FieldRef
): string => {
  const value = raw[key];
  return isString(value) && value.length > 0
    ? value
    : fail(ref.source, `${ref.where} is missing or is not a non-empty string`);
};

const stringList = (
  raw: Readonly<Record<string, unknown>>,
  key: string,
  source: string
): readonly string[] => {
  const value = raw[key];
  return Array.isArray(value) && value.length > 0 && value.every(isString)
    ? value
    : fail(source, `field "${key}" is missing or is not a non-empty array of strings`);
};

/**
 * An optional location path, resolved against the DIRECTORY THE PROFILE LIVES
 * IN rather than the caller's shell: a profile is moved and copied as one file,
 * and a `process.cwd()`-relative location would point somewhere else for every
 * caller. An absolute value passes through `resolve` untouched.
 */
const optionalPath = (
  raw: Readonly<Record<string, unknown>>,
  key: string,
  source: string
): string | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  return isString(value) && value.length > 0
    ? resolve(dirname(source), value)
    : fail(source, `field "${key}" is present but is not a non-empty string`);
};

const optionalStringList = (
  raw: Readonly<Record<string, unknown>>,
  key: string,
  source: string
): readonly string[] | undefined =>
  raw[key] === undefined ? undefined : stringList(raw, key, source);

/**
 * An optional character count. A zero, a fraction or a string is REFUSED rather
 * than rounded or ignored: the value is a hard write-time cap, so a silently
 * corrected one would chunk a whole corpus to a size nobody authored.
 */
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const optionalPositiveInteger = (
  raw: Readonly<Record<string, unknown>>,
  key: string,
  source: string
): number | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  return isPositiveInteger(value)
    ? value
    : fail(source, `field "${key}" is "${String(value)}", not a positive whole number of characters`);
};

const ruleList = (
  raw: Readonly<Record<string, unknown>>,
  key: string,
  source: string
): readonly Readonly<Record<string, unknown>>[] => {
  const value = raw[key];
  return Array.isArray(value) && value.every(isRecord)
    ? value
    : fail(source, `field "${key}" is missing or is not an array of objects`);
};

/**
 * The closed-vocabulary check, applied to every label a rule names. The message
 * carries the offending value AND the vocabulary it must come from, because a
 * typo is only correctable when the author can see both.
 */
const member = (value: unknown, vocabulary: readonly string[], ref: FieldRef): string =>
  isString(value) && vocabulary.includes(value)
    ? value
    : fail(
        ref.source,
        `${ref.where} names "${String(value)}", outside the closed vocabulary — replace it with one of ${vocabulary.join(' | ')}`
      );

const domainRule = (
  raw: Readonly<Record<string, unknown>>,
  index: number,
  ctx: RuleContext
): ProfileDomainRule => ({
  prefix: expandPrefix(
    stringField(raw, 'prefix', { source: ctx.source, where: `domainRules[${index}].prefix` })
  ),
  domain: member(raw['domain'], ctx.vocabulary, {
    source: ctx.source,
    where: `domainRules[${index}].domain`,
  }),
});

const typeRule = (
  raw: Readonly<Record<string, unknown>>,
  index: number,
  ctx: RuleContext
): ProfileTypeRule => ({
  prefix: expandPrefix(
    stringField(raw, 'prefix', { source: ctx.source, where: `typeRules[${index}].prefix` })
  ),
  type: member(raw['type'], ctx.vocabulary, {
    source: ctx.source,
    where: `typeRules[${index}].type`,
  }),
});

const segmentRule = (
  raw: Readonly<Record<string, unknown>>,
  index: number,
  ctx: RuleContext
): ProfileSegmentRule => ({
  segment: stringField(raw, 'segment', {
    source: ctx.source,
    where: `segmentRules[${index}].segment`,
  }),
  type: member(raw['type'], ctx.vocabulary, {
    source: ctx.source,
    where: `segmentRules[${index}].type`,
  }),
});

/**
 * A path prefix is repo-relative by contract, so an absolute one or one walking
 * out through `..` is REFUSED rather than normalised: silently rebasing it would
 * exclude a directory nobody named, and the symptom is only missing atoms.
 */
const unsafePrefix = (value: string): boolean => value.startsWith('/') || value.includes('..');

/**
 * The ONE normalisation every path prefix passes through: `~/` expands to the
 * home directory and separators become forward slashes, so a prefix is compared
 * against a source path in exactly the form ingest names one. A relative prefix
 * is returned untouched, which is why every shipped profile matches as before.
 */
const expandPrefix = (value: string): string => expandUserPath(value).split(sep).join('/');


/** An empty member would prefix-match EVERY path, so it is refused, not dropped. */
const withoutEmptyMember = (
  values: readonly string[] | undefined,
  key: string,
  source: string
): readonly string[] | undefined =>
  values?.includes('') === true
    ? fail(source, `field "${key}" contains an empty string — every member must be non-empty`)
    : values;

const excludePathList = (
  raw: Readonly<Record<string, unknown>>,
  source: string
): readonly string[] | undefined => {
  const value = withoutEmptyMember(optionalStringList(raw, 'excludePaths', source), 'excludePaths', source);
  const offender = value?.find(unsafePrefix);
  return offender === undefined
    ? value
    : fail(
        source,
        `field "excludePaths" names "${offender}" — a prefix MUST be repo-relative, neither absolute nor containing ".."`
      );
};

/**
 * Checked against the profile's OWN `types`, by the same closed-vocabulary rule
 * every label obeys: a typo here would exclude nothing and read as a working
 * default, so the name is refused with the accepted vocabulary beside it.
 */
const defaultExcludedTypeList = (
  raw: Readonly<Record<string, unknown>>,
  source: string,
  types: readonly string[]
): readonly string[] | undefined =>
  optionalStringList(raw, 'defaultExcludedTypes', source)?.map((value, index) =>
    member(value, types, { source, where: `defaultExcludedTypes[${index}]` })
  );

/** One numeric member of `defaultPrf`: what it is called and what it accepts. */
interface PrfFieldSpec {
  readonly key: string;
  readonly accepts: (value: unknown) => value is number;
  readonly expected: string;
}

/** The share is a proportion, so anything outside [0, 1] is refused, not clamped. */
const isProportion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const prfField = (
  raw: Readonly<Record<string, unknown>>,
  source: string,
  spec: PrfFieldSpec
): number => {
  const value = raw[spec.key];
  return spec.accepts(value)
    ? value
    : fail(source, `field "defaultPrf.${spec.key}" is "${String(value)}", ${spec.expected}`);
};

const FB_DOCS_SPEC: PrfFieldSpec = {
  key: 'fbDocs',
  accepts: isPositiveInteger,
  expected: 'not a positive whole number of feedback documents',
};

const FB_TERMS_SPEC: PrfFieldSpec = {
  key: 'fbTerms',
  accepts: isPositiveInteger,
  expected: 'not a positive whole number of expansion terms',
};

const ALPHA_SPEC: PrfFieldSpec = {
  key: 'alpha',
  accepts: isProportion,
  expected: 'not a number from 0 (the query alone) to 1 (the expansion alone)',
};

/**
 * The optional retrieve-time feedback default. A malformed member is REFUSED
 * with the field named: a silently corrected knob would expand every served
 * query by an amount nobody authored, and the only symptom is a ranking.
 */
const defaultPrfOf = (
  raw: Readonly<Record<string, unknown>>,
  source: string
): PrfParams | undefined => {
  const value = raw['defaultPrf'];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return fail(source, 'field "defaultPrf" is present but is not an object stating fbDocs, fbTerms and alpha');
  }
  return {
    fbDocs: prfField(value, source, FB_DOCS_SPEC),
    fbTerms: prfField(value, source, FB_TERMS_SPEC),
    alpha: prfField(value, source, ALPHA_SPEC),
  };
};

/**
 * The sidecar location, repo-relative by the same contract every path prefix
 * obeys: an absolute path or one walking out through `..` is REFUSED rather
 * than normalised, because a rebased location reads as "no sidecar" and the
 * only symptom is a corpus that lost its summaries.
 */
const repoRelative = (value: string, source: string): string =>
  unsafePrefix(value)
    ? fail(
        source,
        `field "summarySidecar" names "${value}" — the path MUST be repo-relative, neither absolute nor containing ".."`
      )
    : value;

const summarySidecarOf = (
  raw: Readonly<Record<string, unknown>>,
  source: string
): string | undefined => {
  const value = raw['summarySidecar'];
  if (value === undefined) return undefined;
  return isString(value) && value.length > 0
    ? repoRelative(value, source)
    : fail(source, 'field "summarySidecar" is present but is not a non-empty string');
};

/** The chain ids a profile may name, listed in a refusal so a typo is correctable. */
const ANALYZER_IDS: readonly string[] = Object.keys(ANALYZERS);

const isAnalyzerId = (value: unknown): value is AnalyzerId =>
  isString(value) && ANALYZER_IDS.includes(value);

/**
 * The optional index-build chain. An unknown id is REFUSED with the offending
 * value and the known ids beside it: falling back to `DEFAULT_ANALYZER` would
 * build an index analyzed differently from the one the profile asked for, and
 * the only symptom is a corpus that quietly stops matching its own language.
 */
const defaultAnalyzerOf = (
  raw: Readonly<Record<string, unknown>>,
  source: string
): AnalyzerId | undefined => {
  const value = raw['defaultAnalyzer'];
  if (value === undefined) return undefined;
  return isAnalyzerId(value)
    ? value
    : fail(
        source,
        `field "defaultAnalyzer" is "${String(value)}", not a known analyzer chain — replace it with one of ${ANALYZER_IDS.join(' | ')}`
      );
};

/**
 * The optional rerank depth. A zero, a fraction or a string is REFUSED rather
 * than rounded or ignored: a silently corrected pool would rerank a depth
 * nobody asked for while the run reports the one the profile states.
 */
const rerankPoolKOf = (
  raw: Readonly<Record<string, unknown>>,
  source: string
): number | undefined => {
  const value = raw['rerankPoolK'];
  if (value === undefined) return undefined;
  return isPositiveInteger(value)
    ? value
    : fail(source, `field "rerankPoolK" is "${String(value)}", not a whole number of candidates of at least 1`);
};

const defaultsOf = (
  raw: Readonly<Record<string, unknown>>,
  source: string,
  types: readonly string[]
): ProfileDefaults => ({
  excludePaths: excludePathList(raw, source),
  defaultExcludedTypes: defaultExcludedTypeList(raw, source, types),
  defaultPrf: defaultPrfOf(raw, source),
  summarySidecar: summarySidecarOf(raw, source),
  defaultAnalyzer: defaultAnalyzerOf(raw, source),
  rerankPoolK: rerankPoolKOf(raw, source),
});

const locationsOf = (
  raw: Readonly<Record<string, unknown>>,
  source: string
): ProfileLocations => ({
  repoRoot: optionalPath(raw, 'repoRoot', source),
  corpusRoots: optionalStringList(raw, 'corpusRoots', source),
  atomsDir: optionalPath(raw, 'atomsDir', source),
  indexPath: optionalPath(raw, 'indexPath', source),
  goldIdsPath: optionalPath(raw, 'goldIdsPath', source),
});

const unknownKeys = (raw: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(raw).filter(key => !KNOWN_KEYS.includes(key) && !key.startsWith(COMMENT_KEY_PREFIX));

const assertKnownKeys = (raw: Readonly<Record<string, unknown>>, source: string): void => {
  const unknown = unknownKeys(raw);
  if (unknown.length > 0) {
    fail(
      source,
      `declares unknown key(s) ${unknown.join(', ')} — the profile accepts ${KNOWN_KEYS.join(', ')} plus "${COMMENT_KEY_PREFIX}*" rationale keys`
    );
  }
};

/**
 * Validate an already-parsed profile object. Every defect throws with the file
 * named, so the caller never has to guess which profile was wrong.
 */
export const parseIngestProfile = (raw: unknown, source: string): IngestProfile => {
  if (!isRecord(raw)) return fail(source, 'is not a JSON object');
  assertKnownKeys(raw, source);
  const domains = stringList(raw, 'domains', source);
  const types = stringList(raw, 'types', source);
  const domainCtx: RuleContext = { source, vocabulary: domains };
  const typeCtx: RuleContext = { source, vocabulary: types };
  return {
    name: stringField(raw, 'name', { source, where: 'field "name"' }),
    domains,
    types,
    defaultType: member(raw['defaultType'], types, { source, where: 'field "defaultType"' }),
    domainRules: ruleList(raw, 'domainRules', source).map((rule, i) => domainRule(rule, i, domainCtx)),
    typeRules: ruleList(raw, 'typeRules', source).map((rule, i) => typeRule(rule, i, typeCtx)),
    segmentRules: ruleList(raw, 'segmentRules', source).map((rule, i) => segmentRule(rule, i, typeCtx)),
    atomMaxChars: optionalPositiveInteger(raw, 'atomMaxChars', source),
    ...defaultsOf(raw, source, types),
    ...locationsOf(raw, source),
  };
};

const readProfileText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return fail(path, `cannot be read (${String(error)}) — restore the file; ingest MUST NOT fall back to built-in vocabularies`);
  }
};

const parseJson = (text: string, path: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(path, `is not valid JSON (${String(error)})`);
  }
};

/** Read and validate a profile file. Synchronous so module init can depend on it. */
export const loadIngestProfile = (path: string): IngestProfile =>
  parseIngestProfile(parseJson(readProfileText(path), path), path);

/**
 * Longest prefix first, so a nested root always outranks the broader one that
 * contains it: `find` then returns the FIRST — and therefore most specific —
 * match. Sorting is what enforces the rule; declaration order must not matter.
 */
const longestFirst = <T extends { readonly prefix: string }>(rules: readonly T[]): readonly T[] =>
  [...rules].sort((left, right) => right.prefix.length - left.prefix.length);

/**
 * The domain for a source path — repo-relative for an in-repo source, absolute
 * for one reached through an absolute or `~` corpus root — or `undefined` when
 * no declared root claims it (such a source is out of scope for ingest).
 */
export const domainForPath = (profile: IngestProfile, repoRelativePath: string): string | undefined =>
  longestFirst(profile.domainRules).find(rule => repoRelativePath.startsWith(rule.prefix))?.domain;

const segmentType = (profile: IngestProfile, repoRelativePath: string): string | undefined => {
  const segments = repoRelativePath.split('/');
  return profile.segmentRules.find(rule => segments.includes(rule.segment))?.type;
};

const prefixType = (profile: IngestProfile, repoRelativePath: string): string =>
  longestFirst(profile.typeRules).find(rule => repoRelativePath.startsWith(rule.prefix))?.type ??
  profile.defaultType;

/**
 * The type for a repo-relative source path. A segment rule OVERRIDES every
 * prefix rule; an unclaimed source is not out of scope, it keeps `defaultType`.
 */
export const typeForPath = (profile: IngestProfile, repoRelativePath: string): string =>
  segmentType(profile, repoRelativePath) ?? prefixType(profile, repoRelativePath);
