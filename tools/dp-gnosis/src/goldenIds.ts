/**
 * The union of every atom id ANY golden set judges — the tie-break input the
 * ingest dedupe needs so a byte-identical group keeps the copy the measuring
 * instrument names.
 *
 * Deliberately LENIENT where `goldenSet.ts` is strict: that loader validates
 * the one artefact a benchmark scores against and MUST refuse a defect, while
 * this reader only breaks ties BETWEEN byte-identical copies. An id from an
 * unrelated golden set therefore cannot change which CONTENT is ingested, so a
 * superset is safe by construction and an unreadable or unrecognised file is
 * skipped rather than thrown — ingest with no gold behaves exactly as before.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GOLDEN_DIR } from './paths.js';

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

/** A missing, unreadable or malformed file MUST NOT fail an ingest. */
const idsOfFile = (goldenDir: string, name: string): readonly string[] => {
  try {
    return idsOfDocument(readFileSync(join(goldenDir, name), 'utf8'));
  } catch {
    return [];
  }
};

/** Sorted, so the enumeration order cannot vary with the filesystem. */
const goldenSetFiles = (goldenDir: string): readonly string[] => {
  try {
    return readdirSync(goldenDir)
      .filter(name => name.startsWith(GOLDEN_SET_PREFIX) && name.endsWith(JSON_SUFFIX))
      .sort();
  } catch {
    return [];
  }
};

/** Every judged atom id across every golden set in the directory, deduplicated and sorted. */
export const loadJudgedAtomIds = (goldenDir: string = GOLDEN_DIR): readonly string[] =>
  [...new Set(goldenSetFiles(goldenDir).flatMap(name => idsOfFile(goldenDir, name)))].sort();
