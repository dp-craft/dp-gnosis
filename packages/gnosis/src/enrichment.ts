/**
 * The ENRICHMENT SIDECAR: model-written descriptions of an atom, kept BESIDE the
 * vault rather than inside it, so an atom's bytes stay exactly what `ingest`
 * wrote. The vault therefore remains reproducible from its corpus alone, and an
 * enrichment pass can be re-run, discarded or replayed without touching a single
 * `.md` file.
 *
 * SHAPE — JSONL, one record per line, APPEND-ONLY. Deliberately not the single
 * JSON object `summarySidecar.ts` writes: an enrichment run costs a local model
 * minutes per hundred atoms, so it MUST be resumable after an interruption, and
 * a whole-file rewrite per record cannot be resumed from — a run killed mid-write
 * leaves a truncated object that parses as nothing at all. Appending one line
 * means the worst an interruption can cost is that ONE line, and every line
 * written before it is still readable.
 *
 * RESUME semantics follow from that: a later record for an atom id WINS. A re-run
 * appends rather than rewrites, so the tail of the file is the current answer.
 *
 * MALFORMED LINES are SKIPPED and COUNTED, never thrown — the one deliberate
 * divergence from `summarySidecar.ts`, which refuses its whole file. That
 * sidecar is small, hand-reviewable and TRACKED; this one is a generated log
 * that can reach tens of thousands of lines, and a single truncated tail line —
 * the exact artefact an interrupted append leaves behind — MUST NOT brick a
 * later index build. The count is REPORTED on stderr rather than swallowed:
 * "produced nothing, recorded as data" is this package's recurring failure
 * class, and a silently dropped record is that failure in miniature.
 *
 * STALENESS is keyed on the atom BODY, the PROMPT version and the MODEL id.
 * Nothing else can change what the model would answer: the body is the input,
 * the prompt is the instruction, and the model is the function. `docKey` records
 * WHICH SOURCE the atom came from so a record can be attributed after the fact;
 * it is carried, not compared, because a document may be moved without changing
 * a single atom body.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The record shape this module reads and writes; a line stating any other is skipped. */
export const ENRICHMENT_SIDECAR_VERSION = 1;

/**
 * Bumped whenever the enrichment system prompt changes. It is half of the
 * freshness key: the same body under a different instruction is a different
 * answer, and reusing the old one would attribute this prompt's output to text
 * it never saw.
 */
export const ENRICHMENT_PROMPT_VERSION = 1;

/** What the generator produces for one atom. `entities` is deterministic, not model-written. */
export interface EnrichmentFields {
  readonly short: string;
  readonly long: string;
  readonly doc_description: string;
  readonly keywords: readonly string[];
  readonly entities: readonly string[];
  readonly questions: readonly string[];
}

/** One sidecar line: the fields, plus everything needed to judge them stale. */
export interface EnrichmentRecord extends EnrichmentFields {
  /** {@link atomKeyOf} of the atom body the model actually read. */
  readonly key: string;
  /** {@link docKeyOf} of the source path the atom was cut from. Carried, not compared. */
  readonly docKey: string;
  readonly variant: 'solo' | 'neighbour';
  readonly unit: 'atom';
  /** The atom's frontmatter id — the join key an index build uses. */
  readonly id: string;
  /** Atoms-dir-relative `.md` path. */
  readonly source: string;
  readonly promptVersion: number;
  readonly model: string;
}

const HASH = 'sha256';
const NOT_FOUND = 'ENOENT';
const VARIANTS: readonly string[] = ['solo', 'neighbour'];
const UNIT = 'atom';

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const sha256 = (value: string): string => createHash(HASH).update(value, 'utf8').digest('hex');

/**
 * The freshness key: the atom BODY, hashed. Hashed rather than stored so the
 * sidecar never carries a second copy of the vault — the same reason the fts5
 * index holds no bodies.
 */
export const atomKeyOf = (body: string): string => sha256(body);

/** The provenance key: which SOURCE document an atom was cut from. */
export const docKeyOf = (sourcePath: string): string => sha256(sourcePath);

/**
 * Field order as written, and therefore as compared. Fixed here rather than left
 * to `JSON.stringify`'s insertion order: a record assembled in a different order
 * would serialize to different bytes for identical content, and every diff over
 * an append-only log would then be noise.
 */
const RECORD_KEYS = [
  'docKey',
  'doc_description',
  'entities',
  'id',
  'key',
  'keywords',
  'long',
  'model',
  'promptVersion',
  'questions',
  'short',
  'source',
  'unit',
  'variant',
] as const;

const sortedRecord = (record: EnrichmentRecord): Readonly<Record<string, unknown>> =>
  Object.fromEntries(RECORD_KEYS.map(key => [key, record[key]]));

/**
 * The canonical serialization: SORTED keys, ONE line, one trailing newline. The
 * sort is what makes a re-run over an unchanged corpus byte-identical, which is
 * the only way a diff over this file means anything.
 */
export const serializeEnrichmentRecord = (record: EnrichmentRecord): string =>
  `${JSON.stringify(sortedRecord(record))}\n`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const STRING_KEYS = ['key', 'docKey', 'id', 'source', 'short', 'long', 'doc_description', 'model'];
const LIST_KEYS = ['keywords', 'entities', 'questions'];

const hasTextFields = (value: Readonly<Record<string, unknown>>): boolean =>
  STRING_KEYS.every(key => typeof value[key] === 'string') &&
  LIST_KEYS.every(key => isStringArray(value[key]));

const hasProvenanceFields = (value: Readonly<Record<string, unknown>>): boolean =>
  typeof value['promptVersion'] === 'number' &&
  value['unit'] === UNIT &&
  VARIANTS.includes(String(value['variant']));

/** Every field of the closed shape, checked before a record is built from it. */
const hasFields = (value: Readonly<Record<string, unknown>>): boolean =>
  hasTextFields(value) && hasProvenanceFields(value);

const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asList = (value: unknown): readonly string[] => (isStringArray(value) ? [...value] : []);
const asCount = (value: unknown): number => (typeof value === 'number' ? value : 0);
const asVariant = (value: unknown): 'solo' | 'neighbour' =>
  value === 'neighbour' ? 'neighbour' : 'solo';

/**
 * Read the six generated fields off an ALREADY-VALIDATED object. The fallbacks
 * are unreachable — {@link hasFields} gated them — and exist so the record is
 * BUILT from checked values rather than cast into shape: a blanket assertion
 * would let a future field arrive typed but absent.
 */
const fieldsOf = (value: Readonly<Record<string, unknown>>): EnrichmentFields => ({
  short: asString(value['short']),
  long: asString(value['long']),
  doc_description: asString(value['doc_description']),
  keywords: asList(value['keywords']),
  entities: asList(value['entities']),
  questions: asList(value['questions']),
});

const recordOf = (value: Readonly<Record<string, unknown>>): EnrichmentRecord => ({
  ...fieldsOf(value),
  key: asString(value['key']),
  docKey: asString(value['docKey']),
  variant: asVariant(value['variant']),
  unit: UNIT,
  id: asString(value['id']),
  source: asString(value['source']),
  promptVersion: asCount(value['promptVersion']),
  model: asString(value['model']),
});

/**
 * One line -> one record, or `undefined`. It NEVER throws: the caller is a build
 * that must survive a truncated tail, and an exception here would turn a partial
 * log into an unusable one.
 */
export const parseEnrichmentLine = (line: string): EnrichmentRecord | undefined => {
  const parsed = parseJson(line);
  return isRecord(parsed) && hasFields(parsed) ? recordOf(parsed) : undefined;
};

const readLines = (path: string): readonly string[] | undefined => {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch (error) {
    if (isRecord(error) && error['code'] === NOT_FOUND) return undefined;
    throw error;
  }
};

/** A blank tail line is the newline every well-formed file ends with, not a defect. */
const isBlank = (line: string): boolean => line.trim().length === 0;

/**
 * The dropped-line report. Written to stderr rather than returned, because the
 * public surface is the map and a caller that ignores a count would hide the
 * one fact worth knowing: records were read as data and were not.
 */
const reportSkipped = (path: string, skipped: number): void => {
  if (skipped > 0) {
    process.stderr.write(
      `enrichment sidecar ${path}: SKIPPED ${skipped} malformed line(s) — those atoms are indexed without enrichment.\n`
    );
  }
};

/**
 * Read a sidecar by path, keyed by atom id. ABSENCE yields an EMPTY map: a vault
 * that has never been enriched is not a defect, and an index built over it is
 * exactly the index that was always built.
 *
 * A LATER record for an id overwrites an earlier one — the append-only resume
 * rule, applied by iterating in file order and letting the last write stand.
 */
export const loadEnrichmentSidecar = (path: string): ReadonlyMap<string, EnrichmentRecord> => {
  const lines = readLines(path);
  if (lines === undefined) return new Map();
  const parsed = lines.filter(line => !isBlank(line)).map(parseEnrichmentLine);
  reportSkipped(path, parsed.filter(record => record === undefined).length);
  return new Map(parsed.filter(isDefined).map(record => [record.id, record]));
};

/**
 * Is this record still an answer about THIS text, under THIS instruction, from
 * THIS model? All three must hold. Any one of them changing means the model
 * would answer differently, and reusing the record would publish one model's
 * output under another's name.
 */
export const isEnrichmentFresh = (
  record: EnrichmentRecord,
  bodyKey: string,
  promptVersion: number,
  model: string
): boolean =>
  record.key === bodyKey && record.promptVersion === promptVersion && record.model === model;
