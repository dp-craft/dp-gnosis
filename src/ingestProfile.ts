import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

/** One mechanical assignment rule: repo-relative path prefix → domain. */
export interface ProfileDomainRule {
  readonly prefix: string;
  readonly domain: string;
}

/** One mechanical assignment rule: repo-relative path prefix → type. */
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
  /** Repo-relative roots this instance ingests — its corpus SCOPE. */
  readonly corpusRoots?: readonly string[] | undefined;
  /** Where this instance's atoms are written and read. */
  readonly atomsDir?: string | undefined;
  /** Where this instance's index is built; a DIRECTORY for lancedb. */
  readonly indexPath?: string | undefined;
}

/** The location half of a profile — what T-3 added to the vocabulary half. */
type ProfileLocations = Pick<
  IngestProfile,
  'repoRoot' | 'corpusRoots' | 'atomsDir' | 'indexPath'
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
  prefix: stringField(raw, 'prefix', { source: ctx.source, where: `domainRules[${index}].prefix` }),
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
  prefix: stringField(raw, 'prefix', { source: ctx.source, where: `typeRules[${index}].prefix` }),
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

const locationsOf = (
  raw: Readonly<Record<string, unknown>>,
  source: string
): ProfileLocations => ({
  repoRoot: optionalPath(raw, 'repoRoot', source),
  corpusRoots: optionalStringList(raw, 'corpusRoots', source),
  atomsDir: optionalPath(raw, 'atomsDir', source),
  indexPath: optionalPath(raw, 'indexPath', source),
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
 * The domain for a repo-relative source path, or `undefined` when no declared
 * root claims it (such a source is out of scope for ingest).
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
