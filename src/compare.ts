/**
 * The `0ee258ea` lesson, encoded as a refusal.
 *
 * That commit changed atom ids — the measuring scale — and the before/after
 * nDCG numbers were chained anyway, because nothing in the tooling knew the
 * scale had moved. So this module does NOT subtract two runs whose provenance
 * differs. It names the field that changed instead, and a changed measuring
 * scale can never again masquerade as a quality change.
 *
 * The guarded fields are the ones that alter what is being measured rather than
 * how well the engine does it:
 *
 * | Field | What a change means |
 * |---|---|
 * | `atomMaxChars` | a different chunking, so a different ranking unit |
 * | `adapter` | a different engine path |
 * | `depth` | a different retrieval cut, which moves recall mechanically |
 * | `rerank` | a second-stage model in the loop, or not |
 * | `corpusBytes` / `corpusLines` | a different corpus — the cheap checksum |
 *
 * `gitSha` and `ts` are deliberately NOT guarded: a changed engine commit is
 * precisely the thing a delta is supposed to measure.
 */
import type { HistoryRow } from './report.js';

const DELTA_DIGITS = 4;

/** The fields whose change invalidates a delta. Order fixes the report's order. */
export const PROVENANCE_FIELDS = [
  'atomMaxChars',
  'adapter',
  'depth',
  'rerank',
  'corpusBytes',
  'corpusLines',
] as const;

export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

/** A guarded field that moved between the two runs, with both of its values. */
export interface ProvenanceChange {
  readonly field: ProvenanceField;
  readonly previous: HistoryRow[ProvenanceField];
  readonly latest: HistoryRow[ProvenanceField];
}

/** The signed metric movement from the older run to the newer one. */
export interface MetricDelta {
  readonly ndcg10: number;
  readonly recall10: number;
  readonly recall100: number;
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

export type Comparison = ComparisonDelta | ComparisonRefused | ComparisonMissing;

const changedField = (
  previous: HistoryRow,
  latest: HistoryRow,
  field: ProvenanceField
): ProvenanceChange | undefined =>
  previous[field] === latest[field]
    ? undefined
    : { field, previous: previous[field], latest: latest[field] };

const isChange = (change: ProvenanceChange | undefined): change is ProvenanceChange =>
  change !== undefined;

/** Every guarded field that moved — all of them, so one report names them all. */
export const provenanceChanges = (
  previous: HistoryRow,
  latest: HistoryRow
): readonly ProvenanceChange[] =>
  PROVENANCE_FIELDS.map(field => changedField(previous, latest, field)).filter(isChange);

const deltaOf = (previous: HistoryRow, latest: HistoryRow): MetricDelta => ({
  ndcg10: latest.ndcg10 - previous.ndcg10,
  recall10: latest.recall10 - previous.recall10,
  recall100: latest.recall100 - previous.recall100,
  mrr10: latest.mrr10 - previous.mrr10,
});

const comparePair = (
  dataset: string,
  previous: HistoryRow,
  latest: HistoryRow
): Comparison => {
  const changed = provenanceChanges(previous, latest);
  return changed.length > 0
    ? { kind: 'provenance-changed', dataset, previous, latest, changed }
    : { kind: 'delta', dataset, previous, latest, delta: deltaOf(previous, latest) };
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

const deltaLine = (comparison: ComparisonDelta): string =>
  `${comparison.dataset}: nDCG@10 ${signed(comparison.delta.ndcg10)}  ` +
  `R@10 ${signed(comparison.delta.recall10)}  ` +
  `R@100 ${signed(comparison.delta.recall100)}  ` +
  `MRR@10 ${signed(comparison.delta.mrr10)}  ` +
  `(${comparison.previous.gitSha} → ${comparison.latest.gitSha})`;

const changeText = (change: ProvenanceChange): string =>
  `${change.field} ${JSON.stringify(change.previous)} → ${JSON.stringify(change.latest)}`;

const refusalLine = (comparison: ComparisonRefused): string =>
  `${comparison.dataset}: NO DELTA REPORTED — the measurement changed: ` +
  `${comparison.changed.map(changeText).join(', ')}. ` +
  'Re-run both arms under one provenance before reading these numbers as quality.';

/** One line a human can act on, whichever outcome the comparison had. */
export const formatComparison = (comparison: Comparison): string => {
  if (comparison.kind === 'delta') return deltaLine(comparison);
  if (comparison.kind === 'provenance-changed') return refusalLine(comparison);
  return `${comparison.dataset}: only ${comparison.runs} recorded run — nothing to compare yet.`;
};
