/**
 * `datasets.json` — schema and loader.
 *
 * The manifest is the flexibility seam: adding a dataset is one entry, no code.
 * Three formats cover everything — `beir-zip` (download + unzip), `beir-local`
 * (a directory already on disk, including a hand-labelled markdown corpus) and
 * `bright` (HuggingFace rows API).
 *
 * `domain`, `docShape` and `queryShape` are REPORT metadata. They MUST NOT flow
 * into an ingest profile: `tools/dp-gnosis/src/config.ts` freezes the domain and
 * type vocabularies, and an atom carrying an unknown domain is dropped at index
 * time with no error. See `corpus.ts` for the vocabulary actually used.
 *
 * Every rejection names the fix, because the manifest is edited by hand.
 */
import { readFileSync } from 'node:fs';

/** Fields every entry carries, whatever its format. */
export interface DatasetBase {
  readonly id: string;
  /** Report metadata only — never an ingest-profile domain. */
  readonly domain: string;
  readonly docShape: string;
  readonly queryShape?: string | undefined;
  /** Per-corpus atom cap; absent means the shipped `ATOM_MAX_CHARS`. */
  readonly atomMaxChars?: number | undefined;
  readonly enabled: boolean;
}

/** A BEIR archive fetched from `source`, or a BEIR directory already at `source`. */
export interface BeirDataset extends DatasetBase {
  readonly format: 'beir-zip' | 'beir-local';
  readonly source: string;
  /** The qrels split to score — the `qrels/<split>.tsv` basename. */
  readonly qrels: string;
}

/** A BRIGHT domain split, materialised into BEIR layout by its fetcher. */
export interface BrightDataset extends DatasetBase {
  readonly format: 'bright';
  readonly split: string;
}

export type DatasetEntry = BeirDataset | BrightDataset;

const BEIR_FORMATS: readonly string[] = ['beir-zip', 'beir-local'];
const FORMATS_TEXT = '"beir-zip", "beir-local" or "bright"';

const fail = (problem: string, fix: string): never => {
  throw new Error(`datasets.json: ${problem} — ${fix}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string
): string => {
  const value = record[key];
  return typeof value === 'string' && value.length > 0
    ? value
    : fail(`${where} has no "${key}"`, `add a non-empty string "${key}" to that entry`);
};

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string
): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string'
    ? value
    : fail(`${where} has a non-string "${key}"`, `quote it, or drop "${key}" entirely`);
};

const optionalNumber = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string
): number | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(`${where} has a non-numeric "${key}"`, `use a plain number, or drop "${key}"`);
};

const requireBoolean = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string
): boolean => {
  const value = record[key];
  return typeof value === 'boolean'
    ? value
    : fail(`${where} has no boolean "${key}"`, `set "${key}" to true or false`);
};

const baseOf = (record: Readonly<Record<string, unknown>>, where: string): DatasetBase => ({
  id: requireString(record, 'id', where),
  domain: requireString(record, 'domain', where),
  docShape: requireString(record, 'docShape', where),
  queryShape: optionalString(record, 'queryShape', where),
  atomMaxChars: optionalNumber(record, 'atomMaxChars', where),
  enabled: requireBoolean(record, 'enabled', where),
});

const beirOf = (
  format: BeirDataset['format'],
  record: Readonly<Record<string, unknown>>,
  where: string
): BeirDataset => ({
  ...baseOf(record, where),
  format,
  source: requireString(record, 'source', where),
  qrels: requireString(record, 'qrels', where),
});

const brightOf = (
  record: Readonly<Record<string, unknown>>,
  where: string
): BrightDataset => ({
  ...baseOf(record, where),
  format: 'bright',
  split: requireString(record, 'split', where),
});

const isBeirFormat = (format: string): format is BeirDataset['format'] =>
  BEIR_FORMATS.includes(format);

const toEntry = (raw: unknown, index: number): DatasetEntry => {
  const where = `datasets[${index}]`;
  const record = isRecord(raw)
    ? raw
    : fail(`${where} is not an object`, 'make it a JSON object with id/format/domain fields');
  const format = requireString(record, 'format', where);
  if (isBeirFormat(format)) return beirOf(format, record, where);
  return format === 'bright'
    ? brightOf(record, where)
    : fail(`${where} has unknown format "${format}"`, `use ${FORMATS_TEXT}`);
};

/** Validate a parsed `datasets.json` body into typed entries. */
export const parseManifest = (raw: unknown): readonly DatasetEntry[] => {
  const record = isRecord(raw)
    ? raw
    : fail('the root value is not an object', 'wrap the entries in { "datasets": [ ... ] }');
  const list = record['datasets'];
  return Array.isArray(list)
    ? list.map(toEntry)
    : fail('the root has no "datasets" array', 'add a "datasets": [ ... ] key');
};

/** Read and validate the manifest at `path`. */
export const loadManifest = (path: string): readonly DatasetEntry[] =>
  parseManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown);

/** The entries a run actually processes. */
export const enabledDatasets = (
  entries: readonly DatasetEntry[]
): readonly DatasetEntry[] => entries.filter(entry => entry.enabled);
