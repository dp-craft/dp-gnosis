/**
 * The `0ee258ea` lesson, encoded as a refusal.
 *
 * That commit changed atom ids — the measuring scale — and the before/after
 * nDCG numbers were chained anyway, because nothing in the tooling knew the
 * scale had moved. So this module does NOT subtract two runs whose provenance
 * differs. It names the field that changed instead, and a changed measuring
 * scale can never again masquerade as a quality change.
 *
 * A guarded field is one of two kinds, and the two demand OPPOSITE answers:
 *
 * | Kind | Field | What a change means |
 * |---|---|---|
 * | measuring scale | `atomMaxChars` | a different chunking, so a different ranking unit |
 * | measuring scale | `depth` | a different retrieval cut, which moves recall mechanically |
 * | measuring scale | `rerankPool` | a different CANDIDATE POOL the reranker scored, which moves what was reachable — guarded ONLY between two rows that both reranked |
 * | measuring scale | `corpusBytes` / `corpusLines` | a different corpus — the cheap checksum |
 * | treatment | `adapter` | a different engine path — the thing an A/B run exists to compare |
 * | treatment | `rerank` | a second-stage model in the loop, or not |
 * | treatment | `rerankProfile` / `rerankWeight` | a different FUSION rule over the same two orders — the WEIGHT guarded ONLY between two rows that both fused with RRF, since a replacement protocol has no weight term |
 * | treatment | `hybridWeight` | a different WEIGHT on the hybrid route's two LEGS — a second fusion |
 * | treatment | `rerankModel` | a different CROSS-ENCODER producing the reranked order |
 * | treatment | `rerankDocMaxChars` / `rerankExtract` | a different TEXT put in front of the reranker — how much of an atom body, and which part — guarded ONLY between two rows that both reranked |
 * | treatment | `tokenBudget` / `servedK` | a different SET PRESENTED to the consumer — the token cap, and the window it was charged over |
 * | treatment | `embedModel` | a different ENCODER behind the dense leg |
 * | treatment | `analyzer` | a different ANALYSIS chain in the index, so different terms |
 * | treatment | `fieldWeights` | a different `bm25()` WEIGHT per column, so a different ranking over one index |
 * | treatment | `enrichment` | a different number of atoms carrying ENRICHMENT text — the ingest-enrichment arm |
 * | treatment | `queryAdjacency` | a different QUERY expression — the phrase disjunct, or not |
 * | treatment | `provenanceMerge` | a different SCORING SEMANTICS — whether a deduped atom credits every source document whose body it represents |
 * | treatment | `prf` | the query was RM3-EXPANDED from its own first pass, or not |
 * | treatment | `prfDocs` / `prfTerms` / `prfAlpha` | a different RM3 term model over the same first pass — guarded ONLY between two rows that both expanded |
 * | treatment | `typeFilter` | a different CORPUS PROJECTION — the atom types the run could return at all |
 *
 * A moved SCALE is still refused: the two numbers are not on one axis and no
 * label can rescue them. A moved TREATMENT is the experiment, so it is compared
 * — but reported as an ARM COMPARISON, never as a like-for-like delta, because
 * the two arms differ by construction rather than by a regression.
 *
 * `gitSha` and `ts` are deliberately NOT guarded: a changed engine commit is
 * precisely the thing a delta is supposed to measure.
 */
import {
  DEFAULT_RERANK_PRESET,
  EMBED_MODEL_ID,
  HYBRID_FUSION,
  RERANK_FUSION_PRESETS,
  RERANK_MODEL_ID,
  type RerankFusion
} from '../../gnosis/src/config.js';
import { DEFAULT_PRF_PARAMS } from '../../gnosis/src/prf.js';
import { DEFAULT_ANALYZER } from '../../gnosis/src/query.js';
import {
  DEFAULT_FIELD_WEIGHTS_TEXT,
  type HistoryRow,
  NO_ENRICHMENT,
  NO_TYPE_FILTER
} from './report.js';

const DELTA_DIGITS = 4;

/**
 * Fields that change WHAT is measured; a move invalidates any subtraction.
 *
 * `atomCount` is the number of atoms actually INDEXED, which `corpusBytes` /
 * `corpusLines` cannot stand in for — those describe the SOURCE `corpus.jsonl`
 * and hold still across an ingest-rule change. At `6f87ca08` a dedupe dropped
 * 296 `vault` atoms under a byte-identical corpus and the subtraction reported
 * -0.0921, p=0.0005: corpus destruction dressed as a quality regression.
 */
export const SCALE_FIELDS = [
  'atomMaxChars',
  'depth',
  'rerankPool',
  'corpusBytes',
  'corpusLines',
  'atomCount',
] as const;

/** Fields that name the TREATMENT under measurement; a move IS the experiment. */
export const TREATMENT_FIELDS = [
  'adapter',
  'rerank',
  'rerankProfile',
  'rerankWeight',
  'rerankModel',
  'rerankDocMaxChars',
  'rerankExtract',
  'hybridWeight',
  'tokenBudget',
  'servedK',
  'embedModel',
  'analyzer',
  'fieldWeights',
  'enrichment',
  'queryAdjacency',
  'provenanceMerge',
  'prf',
  'prfDocs',
  'prfTerms',
  'prfAlpha',
  'typeFilter',
] as const;

export type ScaleField = (typeof SCALE_FIELDS)[number];
export type TreatmentField = (typeof TREATMENT_FIELDS)[number];
export type ProvenanceField = ScaleField | TreatmentField;

/** Every guarded field. Derived from the two kinds so neither can drift. */
export const PROVENANCE_FIELDS: readonly ProvenanceField[] = [
  ...SCALE_FIELDS,
  ...TREATMENT_FIELDS,
];

/** A guarded field that moved between the two runs, with both of its values. */
export interface ProvenanceChange {
  readonly field: ProvenanceField;
  readonly previous: HistoryRow[ProvenanceField];
  readonly latest: HistoryRow[ProvenanceField];
}

/**
 * The signed metric movement from the older run to the newer one. A recall
 * cutoff either run did not measure has NO delta — `undefined`, never a
 * subtraction against a missing value.
 */
export interface MetricDelta {
  readonly ndcg10: number;
  readonly recall10: number | undefined;
  readonly recall20: number | undefined;
  readonly recall100: number | undefined;
  readonly recall300: number | undefined;
  readonly recall1000: number | undefined;
  readonly mrr10: number;
}

/** A comparable pair: the delta is meaningful because provenance held still. */
export interface ComparisonDelta {
  readonly kind: 'delta';
  readonly dataset: string;
  readonly previous: HistoryRow;
  readonly latest: HistoryRow;
  readonly delta: MetricDelta;
}

/**
 * Two ARMS of one experiment: the measuring scale held still and a treatment
 * field moved on purpose, so the difference is attributable to the treatment
 * and to nothing else. Kept apart from `delta` so no reader can mistake a
 * between-arms difference for a regression on one arm.
 */
export interface ComparisonArmDelta {
  readonly kind: 'arm-delta';
  readonly dataset: string;
  readonly previous: HistoryRow;
  readonly latest: HistoryRow;
  readonly delta: MetricDelta;
  /** The treatment fields that differ — what the two arms actually are. */
  readonly arms: readonly ProvenanceChange[];
}

/** The refusal: the scale moved, so the numbers are not on the same axis. */
export interface ComparisonRefused {
  readonly kind: 'provenance-changed';
  readonly dataset: string;
  readonly previous: HistoryRow;
  readonly latest: HistoryRow;
  readonly changed: readonly ProvenanceChange[];
}

/** Fewer than two recorded runs for this dataset — nothing to subtract. */
export interface ComparisonMissing {
  readonly kind: 'insufficient-history';
  readonly dataset: string;
  readonly runs: number;
}

export type Comparison =
  | ComparisonDelta
  | ComparisonArmDelta
  | ComparisonRefused
  | ComparisonMissing;

/**
 * The doc window every reranked row was scored under from the reranker's
 * introduction until these two fields were stamped: 2000 characters of the
 * atom's HEAD. A HISTORICAL fact about rows ALREADY WRITTEN. MUST NOT be read
 * as the live window — that is `RERANK_DOC_MAX_CHARS` in the engine config and
 * `EXTRACT_STRATEGY` in `rerank.ts`, and both move.
 */
const LEGACY_RERANK_DOC_MAX_CHARS = 2000;
const LEGACY_RERANK_EXTRACT = 'head';

/**
 * The weight every RRF-fused rerank row carried from the reranker's
 * introduction until `RERANK_RRF_WEIGHT` moved to 0.75 — none of those rows
 * stamped the field, so absence on one means exactly this number. A HISTORICAL
 * fact about rows ALREADY WRITTEN. MUST NOT be read as the live weight: that is
 * `RERANK_RRF_WEIGHT` in the engine config, and it moves.
 */
const LEGACY_RERANK_RRF_WEIGHT = 0.5;

/**
 * What an ABSENT field means, for the fields where absence is not "unknown" but
 * a known older value. A row recorded before the analyzer was selectable was
 * built by `DEFAULT_ANALYZER` — the only chain that ever built one — so reading
 * it as unset would label every first comparison after this landed an ARM
 * COMPARISON against an arm that was never run. The engine's fts5 stamp resolves
 * an unstamped index by exactly this rule.
 *
 * `rerankModel` follows it: every row recorded before the model was selectable
 * was scored by `RERANK_MODEL_ID`, the only reranker the engine ever called.
 * `queryAdjacency` likewise: no row recorded before the flag existed applied the
 * adjacency phrase, so absence reads as OFF rather than as a moved treatment.
 *
 * `provenanceMerge` likewise, and it is the one field with no flag behind it: it
 * is a SEMANTICS VERSION. Before it landed, ingest kept a single source path on
 * the survivor of a byte-identical group and the rollup credited only the first
 * origin, so every dropped twin was a document no atom claimed. Every number on
 * a corpus holding duplicate bodies moved when that was fixed, so an absent
 * stamp reads as OFF and a pre-fix row against a post-fix one is labelled an ARM
 * COMPARISON rather than subtracted into a bookkeeping artefact.
 *
 * `typeFilter` likewise: every row recorded before the bench was aligned with
 * serving projected the FULL corpus, which is what `NO_TYPE_FILTER` names — so
 * an old row and an `--include-history` row compare equal, as they must, since
 * they measured the same atoms.
 *
 * `hybridWeight` likewise: every row recorded before the leg weight was
 * settable fused at `HYBRID_FUSION`'s weight, and it applies to every row alike,
 * so a non-hybrid pair still compares equal on it.
 *
 * `embedModel` likewise: every recorded dense row was embedded by
 * `EMBED_MODEL_ID`, the only encoder the engine ever called. It applies to every
 * row alike, so a lexical pair — which embedded nothing — still compares equal.
 *
 * `rerankWeight` likewise, but only where a weight EXISTS: every RRF-fused row
 * recorded before the field was stamped fused at `LEGACY_RERANK_RRF_WEIGHT`.
 * A `replace` protocol (`beir-ce`) has no weight term at all, which `appliesTo`
 * — not a default — is what answers.
 *
 * `prf` likewise: no row recorded before the flag existed expanded its query, so
 * absence reads as OFF rather than as a moved treatment. Its three knobs follow
 * the `rerankWeight` rule one step over — they exist only where an expansion
 * ran, which `appliesTo` answers, and an absent one on a row that DID expand
 * means the engine's `DEFAULT_PRF_PARAMS`, the only model a stamped row ever ran.
 *
 * `fieldWeights` and `enrichment` are the ingest-enrichment BACKFILL, and they
 * are a pair. Every row recorded before the enrichment columns existed read a
 * BODY-ONLY index — that is the only index the engine could build — and merged
 * no sidecar, because none existed. So an absent `fieldWeights` reads as
 * `DEFAULT_FIELD_WEIGHTS_TEXT` and an absent `enrichment` as `NO_ENRICHMENT`,
 * which is EXACTLY the treatment every one of those runs was measured at. An old
 * row and a new unenriched row therefore compare EQUAL on both, and only a run
 * that actually named a weight or merged a sidecar flips the ARM COMPARISON
 * label. Reading either as unset instead would relabel the whole recorded
 * history as an arm nobody ever ran.
 *
 * `tokenBudget` / `servedK` have NO default and MUST NOT be given one: absence
 * means no cap was applied, which is a real arm rather than an older value, so a
 * budgeted row against an unbudgeted one is the experiment.
 */
const FIELD_DEFAULTS: Partial<Record<ProvenanceField, string | number | boolean>> = {
  analyzer: DEFAULT_ANALYZER,
  fieldWeights: DEFAULT_FIELD_WEIGHTS_TEXT,
  enrichment: NO_ENRICHMENT,
  rerankModel: RERANK_MODEL_ID,
  hybridWeight: HYBRID_FUSION.rerankWeight,
  embedModel: EMBED_MODEL_ID,
  queryAdjacency: false,
  provenanceMerge: false,
  prf: false,
  prfDocs: DEFAULT_PRF_PARAMS.fbDocs,
  prfTerms: DEFAULT_PRF_PARAMS.fbTerms,
  prfAlpha: DEFAULT_PRF_PARAMS.alpha,
  rerankDocMaxChars: LEGACY_RERANK_DOC_MAX_CHARS,
  rerankExtract: LEGACY_RERANK_EXTRACT,
  rerankWeight: LEGACY_RERANK_RRF_WEIGHT,
  typeFilter: NO_TYPE_FILTER,
};

/**
 * The value `RERANK_K_INIT` held from its introduction (`e474419e`, the commit
 * that added `--rerank`) until `92d683e2` raised it to 100. A HISTORICAL fact
 * about rows ALREADY WRITTEN — every rerank row recorded before `rerankPool` was
 * stamped scored a pool floored at this number. MUST NOT be read as the live
 * floor: that is `RERANK_K_INIT` in the engine config, and it moves.
 */
const LEGACY_RERANK_K_INIT = 20;

/**
 * What an ABSENT `rerankPool` means, which only the ROW can answer: a BM25 row
 * reranked nothing and so has no pool at all, while a rerank row scored the
 * legacy floor over its own depth — the same `max(depth, k_init)` the CLI applied.
 */
const legacyRerankPool = (row: HistoryRow): number | undefined =>
  row.rerank ? Math.max(row.depth, LEGACY_RERANK_K_INIT) : undefined;

const defaultOf = (row: HistoryRow, field: ProvenanceField): HistoryRow[ProvenanceField] =>
  field === 'rerankPool' ? legacyRerankPool(row) : FIELD_DEFAULTS[field];

/**
 * The fields that describe a RERANKED row and nothing else — the pool it scored
 * over, and the text window it read. A BM25 row has none of them.
 */
const RERANK_ONLY_FIELDS: ReadonlySet<ProvenanceField> = new Set<ProvenanceField>([
  'rerankPool',
  'rerankDocMaxChars',
  'rerankExtract',
]);

/**
 * The fields that describe an EXPANDED row and nothing else — the term model the
 * RM3 pass built. A row that did not expand has none of them, so between it and
 * a PRF row they come into existence rather than move, and `prf` alone names
 * that flip — the same rule `RERANK_ONLY_FIELDS` states for the reranker.
 */
const PRF_ONLY_FIELDS: ReadonlySet<ProvenanceField> = new Set<ProvenanceField>([
  'prfDocs',
  'prfTerms',
  'prfAlpha',
]);

const presetOf = (name: string): RerankFusion | undefined =>
  (RERANK_FUSION_PRESETS as Readonly<Record<string, RerankFusion>>)[name];

/**
 * Whether this row's fusion HAS a weight term — the protocol is read from the
 * engine's own preset table, so a new preset needs no edit here. A row recorded
 * before the protocol was nameable ran the default one, which is RRF.
 */
const rrfFused = (row: HistoryRow): boolean =>
  row.rerank && presetOf(row.rerankProfile ?? DEFAULT_RERANK_PRESET)?.kind === 'rrf';

/**
 * Whether a field DESCRIBES this row at all. Only the rerank-only fields are
 * conditional: a BM25 row scored no pool and read no document, so between a BM25
 * row and a rerank row they do not MOVE, they come into existence — and that is
 * the `rerank` treatment itself, which already labels the pair an ARM COMPARISON.
 * Letting them fire there would name three fields for one flip, and would make
 * the pool's scale refusal swallow rerank-on-vs-off, the comparison this bench
 * exists to run. Between two rows that BOTH reranked they describe both rows,
 * and a move is reported.
 *
 * `rerankWeight` is the same rule one step narrower: a `replace` protocol has no
 * weight to move, so between it and an RRF row the weight comes into existence
 * and `rerankProfile` alone names that flip. The three RM3 knobs follow it
 * against `prf`.
 */
/** A row recorded before the flag existed expanded nothing (see {@link FIELD_DEFAULTS}). */
const prfExpanded = (row: HistoryRow): boolean => row.prf ?? false;

const appliesTo = (row: HistoryRow, field: ProvenanceField): boolean => {
  if (field === 'rerankWeight') return rrfFused(row);
  if (PRF_ONLY_FIELDS.has(field)) return prfExpanded(row);
  return RERANK_ONLY_FIELDS.has(field) ? row.rerank : true;
};

const valueOf = (row: HistoryRow, field: ProvenanceField): HistoryRow[ProvenanceField] =>
  row[field] === undefined ? defaultOf(row, field) : row[field];

const changedField = (
  previous: HistoryRow,
  latest: HistoryRow,
  field: ProvenanceField
): ProvenanceChange | undefined => {
  if (!appliesTo(previous, field) || !appliesTo(latest, field)) return undefined;
  const before = valueOf(previous, field);
  const after = valueOf(latest, field);
  return before === after ? undefined : { field, previous: before, latest: after };
};

const isChange = (change: ProvenanceChange | undefined): change is ProvenanceChange =>
  change !== undefined;

const changesIn = (
  previous: HistoryRow,
  latest: HistoryRow,
  fields: readonly ProvenanceField[]
): readonly ProvenanceChange[] =>
  fields.map(field => changedField(previous, latest, field)).filter(isChange);

/** Every guarded field that moved — all of them, so one report names them all. */
export const provenanceChanges = (
  previous: HistoryRow,
  latest: HistoryRow
): readonly ProvenanceChange[] => changesIn(previous, latest, PROVENANCE_FIELDS);

/** The measuring-scale moves only — the ones that make a pair incomparable. */
export const scaleChanges = (
  previous: HistoryRow,
  latest: HistoryRow
): readonly ProvenanceChange[] => changesIn(previous, latest, SCALE_FIELDS);

/** The treatment moves only — the ones that make a pair an EXPERIMENT. */
export const treatmentChanges = (
  previous: HistoryRow,
  latest: HistoryRow
): readonly ProvenanceChange[] => changesIn(previous, latest, TREATMENT_FIELDS);

/** Both sides must have measured it; otherwise there is nothing to subtract. */
const optionalDelta = (
  previous: number | undefined,
  latest: number | undefined
): number | undefined =>
  previous === undefined || latest === undefined ? undefined : latest - previous;

const deltaOf = (previous: HistoryRow, latest: HistoryRow): MetricDelta => ({
  ndcg10: latest.ndcg10 - previous.ndcg10,
  recall10: optionalDelta(previous.recall10, latest.recall10),
  recall20: optionalDelta(previous.recall20, latest.recall20),
  recall100: optionalDelta(previous.recall100, latest.recall100),
  recall300: optionalDelta(previous.recall300, latest.recall300),
  recall1000: optionalDelta(previous.recall1000, latest.recall1000),
  mrr10: latest.mrr10 - previous.mrr10,
});

const comparePair = (
  dataset: string,
  previous: HistoryRow,
  latest: HistoryRow
): Comparison => {
  if (scaleChanges(previous, latest).length > 0) {
    const changed = provenanceChanges(previous, latest);
    return { kind: 'provenance-changed', dataset, previous, latest, changed };
  }
  const arms = treatmentChanges(previous, latest);
  const delta = deltaOf(previous, latest);
  return arms.length > 0
    ? { kind: 'arm-delta', dataset, previous, latest, delta, arms }
    : { kind: 'delta', dataset, previous, latest, delta };
};

/**
 * The two most recent rows for `datasetId`, compared — or the reason they were
 * not. History is append-only, so "most recent" is simply the last two rows.
 */
export const compareLastTwo = (
  history: readonly HistoryRow[],
  datasetId: string
): Comparison => {
  const rows = history.filter(row => row.dataset === datasetId);
  const previous = rows.at(-2);
  const latest = rows.at(-1);
  return previous === undefined || latest === undefined
    ? { kind: 'insufficient-history', dataset: datasetId, runs: rows.length }
    : comparePair(datasetId, previous, latest);
};

/** One comparison per dataset in the record, in first-seen order. */
export const compareAll = (history: readonly HistoryRow[]): readonly Comparison[] =>
  [...new Set(history.map(row => row.dataset))].map(dataset =>
    compareLastTwo(history, dataset)
  );

const signed = (value: number): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(DELTA_DIGITS)}`;

/** A cutoff one side never measured is omitted, not printed as a zero movement. */
const optionalText = (label: string, value: number | undefined): string =>
  value === undefined ? '' : `${label} ${signed(value)}  `;

const metricsText = (comparison: ComparisonDelta | ComparisonArmDelta): string =>
  `nDCG@10 ${signed(comparison.delta.ndcg10)}  ` +
  optionalText('R@10', comparison.delta.recall10) +
  optionalText('R@20', comparison.delta.recall20) +
  optionalText('R@100', comparison.delta.recall100) +
  optionalText('R@300', comparison.delta.recall300) +
  optionalText('R@1000', comparison.delta.recall1000) +
  `MRR@10 ${signed(comparison.delta.mrr10)}  ` +
  `(${comparison.previous.gitSha} → ${comparison.latest.gitSha})`;

const deltaLine = (comparison: ComparisonDelta): string =>
  `${comparison.dataset}: ${metricsText(comparison)}`;

const changeText = (change: ProvenanceChange): string =>
  `${change.field} ${JSON.stringify(change.previous)} → ${JSON.stringify(change.latest)}`;

const refusalLine = (comparison: ComparisonRefused): string =>
  `${comparison.dataset}: NO DELTA REPORTED — the measurement changed: ` +
  `${comparison.changed.map(changeText).join(', ')}. ` +
  'Re-run both arms under one provenance before reading these numbers as quality.';

/**
 * The arm line leads with the label and the two arms, so the numbers are never
 * read before the reader knows they belong to two different treatments.
 */
const armLine = (comparison: ComparisonArmDelta): string =>
  `${comparison.dataset}: ARM COMPARISON — ${comparison.arms.map(changeText).join(', ')} — ` +
  `two TREATMENTS, not a like-for-like delta: ${metricsText(comparison)}`;

/** One line a human can act on, whichever outcome the comparison had. */
export const formatComparison = (comparison: Comparison): string => {
  if (comparison.kind === 'delta') return deltaLine(comparison);
  if (comparison.kind === 'arm-delta') return armLine(comparison);
  if (comparison.kind === 'provenance-changed') return refusalLine(comparison);
  return `${comparison.dataset}: only ${comparison.runs} recorded run — nothing to compare yet.`;
};
