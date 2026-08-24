/**
 * The union of every atom id a golden set judges — the tie-break input the
 * ingest dedupe needs so a byte-identical group keeps the copy the measuring
 * instrument names.
 *
 * THIS FEEDS PRODUCTION INGEST DEDUPE, so it is not an analysis helper. When a
 * duplicate group is byte-identical, the ids read here decide WHICH COPY
 * SURVIVES, and scoring is document-level — so a missing or unreadable gold
 * source does not lose a few ids, it re-points which SOURCE FILE counts as
 * gold, silently, on a run that otherwise exits 0.
 *
 * That is why this refuses instead of returning empty: an empty result is
 * indistinguishable from "no document is judged", and the only symptom of the
 * confusion is a corpus that quietly stopped holding the documents the golden
 * set measures. The caller that asked for NOTHING is the only one allowed
 * silence, and it expresses that by not calling here at all.
 *
 * ONE tolerance survives, deliberately: a golden-set document whose SHAPE this
 * reader does not recognise (no `queries` array — `golden-set.v1.atom-sources.json`
 * is a bare array of atom records) judges nothing. It is a superset reader, so
 * an unrecognised sibling cannot change which CONTENT is ingested, only how a
 * tie is broken; refusing it would refuse the shipped golden directory itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every golden set is `golden-set*.json`; new versions land regularly, so none is named. */
const GOLDEN_SET_PREFIX = 'golden-set';
const JSON_SUFFIX = '.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idsOfQuery = (value: unknown): readonly string[] => {
  const ids = isRecord(value) ? value['relevantAtomIds'] : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
};

/** A document whose shape this reader does not recognise judges nothing. */
const idsOfDocument = (text: string): readonly string[] => {
  const value: unknown = JSON.parse(text);
  const queries = isRecord(value) ? value['queries'] : undefined;
  return Array.isArray(queries) ? queries.flatMap(idsOfQuery) : [];
};

/** The refusal names the FILE and the defect, so the correction needs no guessing. */
const fileError = (path: string, error: unknown): Error =>
  new Error(`gold source file "${path}" cannot be read as a golden set (${String(error)})`);

const idsOfFile = (path: string): readonly string[] => {
  try {
    return idsOfDocument(readFileSync(path, 'utf8'));
  } catch (error) {
    throw fileError(path, error);
  }
};

const isGoldenSetName = (name: string): boolean =>
  name.startsWith(GOLDEN_SET_PREFIX) && name.endsWith(JSON_SUFFIX);

/** Sorted, so the enumeration order cannot vary with the filesystem. */
const goldenSetFiles = (goldenDir: string): readonly string[] =>
  readdirSync(goldenDir)
    .filter(isGoldenSetName)
    .sort()
    .map(name => join(goldenDir, name));

/** A directory contributes its golden sets; a file contributes itself. */
const sourceFiles = (goldSource: string): readonly string[] =>
  statSync(goldSource).isDirectory() ? goldenSetFiles(goldSource) : [goldSource];

const sourceError = (goldSource: string, error: unknown): Error =>
  new Error(
    `ingest: the gold source "${goldSource}" cannot be read (${String(error)}) — restore it, ` +
      'name another with --gold-ids <dir|file>, or remove "goldIdsPath" from the profile to ' +
      'ingest with no gold tie-break; ingest MUST NOT dedupe against a gold set it could not read'
  );

/**
 * Every judged atom id under `goldSource`, deduplicated and sorted. The source
 * is REQUIRED and stated by the caller: there is no default, because a default
 * is precisely how this input became invisible.
 */
export const loadJudgedAtomIds = (goldSource: string): readonly string[] => {
  try {
    return [...new Set(sourceFiles(goldSource).flatMap(idsOfFile))].sort();
  } catch (error) {
    throw sourceError(goldSource, error);
  }
};
