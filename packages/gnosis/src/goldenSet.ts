/**
 * Loader + validator for the FROZEN golden relevance set.
 *
 * Why it refuses loudly instead of skipping a bad row: a `relevantAtomIds`
 * entry that no longer exists in the corpus is unreachable for EVERY adapter,
 * so it inflates every adapter's miss rate by exactly the same amount. The
 * comparison still "works" and the absolute numbers are all quietly wrong —
 * the failure is invisible in the report and survives every re-run. A hard
 * throw at load time is the only point where it is still cheap to see.
 *
 * The schema is validated by hand rather than by a schema library: this package
 * has no approved runtime validator dependency (COMMON.md §IX), and the shape
 * is small and closed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseAtom } from './atom.js';
import { atomsDir as defaultAtomsDir, GOLDEN_SET_PATH } from './paths.js';

/**
 * The closed axis vocabulary. Each axis isolates one retrieval regime, so a
 * benchmark can report WHERE an adapter loses rather than one blended number.
 */
export const GOLDEN_AXES = [
  'exact-keyword',
  'inflected-form',
  'multi-word-phrase',
  'rare-technical-token',
  'synonym',
  'domain-filtered',
  'production-shaped-long-form',
] as const;

/** A member of the closed axis vocabulary. */
export type GoldenAxis = (typeof GOLDEN_AXES)[number];

/** One golden query and its authored relevance judgement. */
export interface GoldenQuery {
  readonly id: string;
  readonly axis: GoldenAxis;
  readonly query: string;
  /** `null` = unfiltered; otherwise only same-`x_domain` atoms may be relevant. */
  readonly domain: string | null;
  /**
   * `null` = unfiltered; otherwise only same-`type` atoms may be relevant.
   *
   * Deliberately OPTIONAL in the document, unlike `domain`: the frozen v1
   * artefact predates the field, and an artefact is frozen precisely so it is
   * never rewritten. An absent field therefore reads as `null` (unfiltered),
   * which is exactly what those queries meant.
   */
  readonly type: string | null;
  readonly relevantAtomIds: readonly string[];
  readonly rationale: string;
}

/**
 * The PRE-REGISTERED interpretability floor. `recallResolution` is `1/queries`
 * — the smallest change one flipped query can produce in mean recall. It is
 * recorded in the artefact so a later reader cannot retro-fit a threshold to a
 * result they already saw.
 */
export interface MinimumMeaningfulDifference {
  readonly queries: number;
  readonly recallResolution: number;
  readonly statement: string;
}

/** The whole frozen artefact. */
export interface GoldenSet {
  readonly version: number;
  readonly frozenAt: string;
  readonly corpusAtomCount: number;
  readonly minimumMeaningfulDifference: MinimumMeaningfulDifference;
  readonly queries: readonly GoldenQuery[];
}

const ATOM_EXTENSION = '.md';
/** Float slack for the `recallResolution === 1/queries` identity. */
const RESOLUTION_EPSILON = 1e-9;

const fail = (message: string): never => {
  throw new Error(`golden set: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const isAxis = (value: unknown): value is GoldenAxis => GOLDEN_AXES.some(axis => axis === value);

const requireString = (record: Record<string, unknown>, key: string, where: string): string => {
  const value = record[key];
  return typeof value === 'string' && value.length > 0
    ? value
    : fail(`${where}: field "${key}" MUST be a non-empty string`);
};

const requireNumber = (record: Record<string, unknown>, key: string, where: string): number => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(`${where}: field "${key}" MUST be a finite number`);
};

const requireDomain = (record: Record<string, unknown>, where: string): string | null => {
  const value = record['domain'];
  return value === null || typeof value === 'string'
    ? value
    : fail(`${where}: field "domain" MUST be a string or null (an absent field is not null)`);
};

/** Absent reads as `null` — the frozen v1 artefact declares no `type` at all. */
const readType = (record: Record<string, unknown>, where: string): string | null => {
  const value = record['type'];
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? null
      : fail(`${where}: field "type" MUST be a string or null when present`);
};

const requireAxis = (record: Record<string, unknown>, where: string): GoldenAxis => {
  const value = record['axis'];
  return isAxis(value)
    ? value
    : fail(`${where}: field "axis" MUST be one of ${GOLDEN_AXES.join(' | ')}`);
};

const requireAtomIds = (record: Record<string, unknown>, where: string): readonly string[] => {
  const value = record['relevantAtomIds'];
  return isStringArray(value) && value.length > 0
    ? value
    : fail(`${where}: field "relevantAtomIds" MUST be a non-empty array of strings`);
};

const parseQuery = (value: unknown, index: number): GoldenQuery => {
  const where = `queries[${index}]`;
  const record = isRecord(value) ? value : fail(`${where} MUST be an object`);
  return {
    id: requireString(record, 'id', where),
    axis: requireAxis(record, where),
    query: requireString(record, 'query', where),
    domain: requireDomain(record, where),
    type: readType(record, where),
    relevantAtomIds: requireAtomIds(record, where),
    rationale: requireString(record, 'rationale', where),
  };
};

const parseMmd = (value: unknown): MinimumMeaningfulDifference => {
  const where = 'minimumMeaningfulDifference';
  const record = isRecord(value) ? value : fail(`${where} MUST be an object`);
  return {
    queries: requireNumber(record, 'queries', where),
    recallResolution: requireNumber(record, 'recallResolution', where),
    statement: requireString(record, 'statement', where),
  };
};

/** The declared query count and resolution MUST describe the shipped query list. */
const checkMmdConsistency = (set: GoldenSet): GoldenSet => {
  const { queries, recallResolution } = set.minimumMeaningfulDifference;
  const counted = queries === set.queries.length;
  const resolved = queries > 0 && Math.abs(recallResolution - 1 / queries) <= RESOLUTION_EPSILON;
  return counted && resolved
    ? set
    : fail(
        `minimumMeaningfulDifference MUST state queries=${set.queries.length} and recallResolution=${1 / set.queries.length}`
      );
};

const checkUniqueIds = (set: GoldenSet): GoldenSet => {
  const ids = set.queries.map(query => query.id);
  return new Set(ids).size === ids.length ? set : fail('query ids MUST be unique');
};

const requireQueryList = (record: Record<string, unknown>): readonly unknown[] => {
  const value = record['queries'];
  return Array.isArray(value) && value.length > 0
    ? value
    : fail('document: field "queries" MUST be a non-empty array');
};

/** Parse and structurally validate a golden-set document. Throws on any defect. */
export const parseGoldenSet = (text: string): GoldenSet => {
  const value: unknown = JSON.parse(text);
  const record = isRecord(value) ? value : fail('document MUST be a JSON object');
  return checkUniqueIds(
    checkMmdConsistency({
      version: requireNumber(record, 'version', 'document'),
      frozenAt: requireString(record, 'frozenAt', 'document'),
      corpusAtomCount: requireNumber(record, 'corpusAtomCount', 'document'),
      minimumMeaningfulDifference: parseMmd(record['minimumMeaningfulDifference']),
      queries: requireQueryList(record).map(parseQuery),
    })
  );
};

/**
 * The set of ids the corpus actually declares. Read from each atom's `id`
 * frontmatter field rather than from its filename: the filename is a rendering
 * convention, the frontmatter is the contract every adapter indexes by.
 */
export const readCorpusAtomIds = (atomsDir: string = defaultAtomsDir()): ReadonlySet<string> =>
  new Set(
    readdirSync(atomsDir)
      .filter(name => name.endsWith(ATOM_EXTENSION))
      .map(name => parseAtom(readFileSync(join(atomsDir, name), 'utf8')))
      .flatMap(result => (result.ok ? [result.atom.frontmatter.id] : []))
  );

/** Throw naming every `relevantAtomIds` entry the corpus does not declare. */
export const validateGoldenSetAgainstCorpus = (
  set: GoldenSet,
  corpusIds: ReadonlySet<string>
): void => {
  const missing = set.queries.flatMap(query =>
    query.relevantAtomIds.filter(id => !corpusIds.has(id)).map(id => `${query.id} → ${id}`)
  );
  return missing.length === 0
    ? undefined
    : fail(`relevantAtomIds absent from the corpus (${missing.length}): ${missing.join(', ')}`);
};

/** Read and structurally validate the golden set — corpus check NOT included. */
export const loadGoldenSet = (path: string = GOLDEN_SET_PATH): GoldenSet =>
  parseGoldenSet(readFileSync(path, 'utf8'));

/** The only entry point a benchmark may use: structurally valid AND corpus-resolvable. */
export const loadVerifiedGoldenSet = (
  path: string = GOLDEN_SET_PATH,
  atomsDir: string = defaultAtomsDir()
): GoldenSet => {
  const set = loadGoldenSet(path);
  validateGoldenSetAgainstCorpus(set, readCorpusAtomIds(atomsDir));
  return set;
};
