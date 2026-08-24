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

/**
 * The suite layers, from cheapest to most complete. A dataset belongs to as many
 * as apply — `smoke` is the sub-minute sanity set, `par` the BM25 Tier-1 suite,
 * `full` that plus the entries whose cost only the arm-bearing run earns back.
 */
export const LAYER_NAMES = ['smoke', 'par', 'full'] as const;

export type LayerName = (typeof LAYER_NAMES)[number];

export const LAYERS_TEXT = '"smoke", "par" or "full"';

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
  /**
   * Which layered runs touch this entry. REQUIRED, and `[]` is the way to say
   * "no layer" — an absent key would make an entry invisible to every layered
   * run while looking exactly like one nobody had classified yet.
   */
  readonly layers: readonly LayerName[];
}

/**
 * Where a `beir-local` entry's BEIR layout comes FROM when the repo carries the
 * ingredients rather than the layout: a directory of ingested atoms plus a
 * hand-authored golden set. Both paths are relative to the suite root, and both
 * are read-only — `fetch/vault.ts` projects them into `source` on every run.
 */
export interface VaultDerivationSource {
  readonly atoms: string;
  readonly golden: string;
}

/** A BEIR archive fetched from `source`, or a BEIR directory already at `source`. */
export interface BeirDataset extends DatasetBase {
  readonly format: 'beir-zip' | 'beir-local';
  readonly source: string;
  /** The qrels split to score — the `qrels/<split>.tsv` basename. */
  readonly qrels: string;
  /** Absent means `source` already holds the BEIR layout; present means derive it. */
  readonly derive?: VaultDerivationSource | undefined;
}

/**
 * Which of BRIGHT's two granularities of the SAME queries to score: `long` is
 * the whole web page (config `long_documents` + `gold_ids_long`), `passage` is
 * the gold passage inside it (config `documents` + `gold_ids`). A passage is
 * about one atom long, so `passage` measures block-level ranking with no
 * separate scoring path — and the gap to `long` is what chunking costs.
 */
export type BrightGranularity = 'long' | 'passage';

/** A BRIGHT domain split, materialised into BEIR layout by its fetcher. */
export interface BrightDataset extends DatasetBase {
  readonly format: 'bright';
  readonly split: string;
  /** Absent in the manifest means `long`, the granularity that shipped first. */
  readonly granularity: BrightGranularity;
}

/**
 * MILQA (SzegedAI, Hungarian Wikipedia QA) in its published SQuAD 2.0 layout,
 * converted into BEIR by `fetch/milqa.ts`. It is its own format rather than a
 * `beir-zip` because nothing about it is BEIR on the wire — two JSON split
 * files, an overlap between them, and a paragraph granularity this suite
 * chooses. `source` is the directory the two pinned split files hang under.
 */
export interface MilqaDataset extends DatasetBase {
  readonly format: 'milqa';
  readonly source: string;
  /** The qrels split to score — the `qrels/<split>.tsv` basename. */
  readonly qrels: string;
}

export type DatasetEntry = BeirDataset | BrightDataset | MilqaDataset;

const BEIR_FORMATS: readonly string[] = ['beir-zip', 'beir-local'];
const FORMATS_TEXT = '"beir-zip", "beir-local", "bright" or "milqa"';
const GRANULARITIES: readonly string[] = ['long', 'passage'];
const GRANULARITIES_TEXT = '"long" (whole pages) or "passage" (the gold passages inside them)';
const DEFAULT_GRANULARITY: BrightGranularity = 'long';

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

const isLayerName = (value: unknown): value is LayerName =>
  typeof value === 'string' && (LAYER_NAMES as readonly string[]).includes(value);

/** A layer name if it is one, `undefined` otherwise — the `--layer` flag's guard. */
export const resolveLayer = (value: string): LayerName | undefined =>
  isLayerName(value) ? value : undefined;

const layerOf = (value: unknown, where: string): LayerName =>
  isLayerName(value)
    ? value
    : fail(`${where} has an unknown layer ${JSON.stringify(value)}`, `use ${LAYERS_TEXT}`);

/**
 * Required on every entry, empty array allowed. An optional field with a default
 * would let a new entry join no layer by omission, and a layered run would then
 * measure less than the manifest describes without saying so.
 */
const layersOf = (
  record: Readonly<Record<string, unknown>>,
  where: string
): readonly LayerName[] => {
  const value = record['layers'];
  return Array.isArray(value)
    ? value.map((item: unknown) => layerOf(item, `${where}.layers`))
    : fail(
        `${where} has no "layers" array`,
        `add "layers": [] for an entry no layered run touches, or any of ${LAYERS_TEXT}`
      );
};

const baseOf = (record: Readonly<Record<string, unknown>>, where: string): DatasetBase => ({
  id: requireString(record, 'id', where),
  domain: requireString(record, 'domain', where),
  docShape: requireString(record, 'docShape', where),
  queryShape: optionalString(record, 'queryShape', where),
  atomMaxChars: optionalNumber(record, 'atomMaxChars', where),
  enabled: requireBoolean(record, 'enabled', where),
  layers: layersOf(record, where),
});

/** Both keys are required together: a derivation with only one half is a typo. */
const deriveOf = (
  record: Readonly<Record<string, unknown>>,
  where: string
): VaultDerivationSource | undefined => {
  const value = record['derive'];
  if (value === undefined) return undefined;
  return isRecord(value)
    ? {
        atoms: requireString(value, 'atoms', `${where}.derive`),
        golden: requireString(value, 'golden', `${where}.derive`),
      }
    : fail(
        `${where} has a non-object "derive"`,
        'use { "derive": { "atoms": "<atoms dir>", "golden": "<golden set json>" } }'
      );
};

const beirOf = (
  format: BeirDataset['format'],
  record: Readonly<Record<string, unknown>>,
  where: string
): BeirDataset => ({
  ...baseOf(record, where),
  format,
  source: requireString(record, 'source', where),
  qrels: requireString(record, 'qrels', where),
  derive: deriveOf(record, where),
});

const milqaOf = (
  record: Readonly<Record<string, unknown>>,
  where: string
): MilqaDataset => ({
  ...baseOf(record, where),
  format: 'milqa',
  source: requireString(record, 'source', where),
  qrels: requireString(record, 'qrels', where),
});

const isGranularity = (value: unknown): value is BrightGranularity =>
  typeof value === 'string' && GRANULARITIES.includes(value);

/** Absent means `long`: the eight page-level entries predate this field. */
const granularityOf = (
  record: Readonly<Record<string, unknown>>,
  where: string
): BrightGranularity => {
  const value = record['granularity'];
  if (value === undefined) return DEFAULT_GRANULARITY;
  return isGranularity(value)
    ? value
    : fail(
        `${where} has an invalid "granularity" ${JSON.stringify(value)}`,
        `use ${GRANULARITIES_TEXT}, or drop "granularity" for "${DEFAULT_GRANULARITY}"`
      );
};

const brightOf = (
  record: Readonly<Record<string, unknown>>,
  where: string
): BrightDataset => ({
  ...baseOf(record, where),
  format: 'bright',
  split: requireString(record, 'split', where),
  granularity: granularityOf(record, where),
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
  if (format === 'bright') return brightOf(record, where);
  return format === 'milqa'
    ? milqaOf(record, where)
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

/** The members of one layer, in manifest order. */
export const datasetsInLayer = (
  entries: readonly DatasetEntry[],
  layer: LayerName
): readonly DatasetEntry[] => entries.filter(entry => entry.layers.includes(layer));

/** The entries a run actually processes. */
export const enabledDatasets = (
  entries: readonly DatasetEntry[]
): readonly DatasetEntry[] => entries.filter(entry => entry.enabled);
