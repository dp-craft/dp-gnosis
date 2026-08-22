import { readFileSync } from 'node:fs';

/**
 * The SUMMARY SIDECAR: a `source path → one-line summary` table kept BESIDE the
 * corpus instead of inside it, so a document needs no dp-gnosis-specific comment
 * to carry a summary. A foreign corpus — one this repo does not author and may
 * not modify — can therefore be summarized at all, which an in-source comment
 * makes impossible.
 *
 * It is a TRACKED file, so the writer's contract is byte-stability: sorted keys,
 * one shape, one trailing newline. A re-extraction over an unchanged corpus that
 * produced a different byte would make every diff over this file meaningless.
 *
 * Every defect is REFUSED with the shape it actually found. A silent fallback
 * here would ship a corpus whose documents carry no summary and emit no
 * diagnostic — the exact failure class this package treats as a defect: a
 * component that produced nothing, recorded as data.
 */

/** The one shape this module reads and writes; a file stating any other is refused. */
export const SUMMARY_SIDECAR_VERSION = 1;

/** The on-disk shape: a version stamp and a flat path → summary table. */
export interface SummarySidecarFile {
  readonly version: number;
  readonly summaries: Readonly<Record<string, string>>;
}

const INDENT = 2;
const NOT_FOUND = 'ENOENT';

const fail = (detail: string): never => {
  throw new Error(`summary sidecar ${detail}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fail(`is not valid JSON (${String(error)})`);
  }
};

const summariesOf = (parsed: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(parsed)) return fail(`is "${typeof parsed}", not a JSON object`);
  if (parsed['version'] !== SUMMARY_SIDECAR_VERSION) {
    return fail(`declares version "${String(parsed['version'])}", not ${SUMMARY_SIDECAR_VERSION}`);
  }
  const summaries = parsed['summaries'];
  return isRecord(summaries)
    ? summaries
    : fail(`field "summaries" is "${String(summaries)}", not an object of path → summary`);
};

const entryOf = ([path, value]: readonly [string, unknown]): readonly [string, string] =>
  typeof value === 'string'
    ? [path, value]
    : fail(`entry "${path}" is "${String(value)}", not a string`);

/**
 * Validate an already-read sidecar. Refusal is the whole point: an unparseable
 * file, an unknown version or one non-string value means the table cannot be
 * trusted, and using the readable half of it would summarize a corpus from an
 * artefact nobody wrote.
 */
export const parseSummarySidecar = (raw: string): ReadonlyMap<string, string> =>
  new Map(Object.entries(summariesOf(parseJson(raw))).map(entryOf));

const isMissing = (error: unknown): boolean =>
  isRecord(error) && error['code'] === NOT_FOUND;

const readSidecar = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/**
 * Read a sidecar by path. ABSENCE yields an empty map — a corpus that has not
 * been migrated yet is not a defect, and ingest behaves exactly as it did. Any
 * OTHER read error propagates: an unreadable file that exists is a defect, and
 * swallowing it would drop summaries silently.
 */
export const loadSummarySidecar = (path: string): ReadonlyMap<string, string> => {
  const raw = readSidecar(path);
  return raw === undefined ? new Map() : parseSummarySidecar(raw);
};

/** Code-unit order, not locale order: a locale-dependent sort is not byte-stable. */
const byKey = (left: readonly [string, string], right: readonly [string, string]): number =>
  left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1;

const sortedRecord = (summaries: ReadonlyMap<string, string>): Readonly<Record<string, string>> =>
  Object.fromEntries([...summaries].sort(byKey));

/**
 * The canonical serialization — SORTED keys, two-space JSON, one trailing
 * newline. The order is what makes the file byte-stable across runs: a Map
 * iterates in insertion order, so an unsorted write would reorder the whole
 * table whenever a corpus walk changed order, and every diff would be noise.
 */
export const serializeSummarySidecar = (summaries: ReadonlyMap<string, string>): string => {
  const file: SummarySidecarFile = {
    version: SUMMARY_SIDECAR_VERSION,
    summaries: sortedRecord(summaries),
  };
  return `${JSON.stringify(file, null, INDENT)}\n`;
};
