/**
 * Offline RRF forecast over ALREADY-RECORDED runs — the pure half.
 *
 * It answers one question without spending a second of GPU: if the `fts5`,
 * `linear` and `fts5+prf` arms already on disk were FUSED instead of chosen
 * between, what would the fused arm have scored? Every ranking here is read
 * from a persisted `.trec`; nothing retrieves, indexes or reranks.
 *
 * Three rules it inherits rather than restates:
 *
 * 1. **The fusion arithmetic is the engine's**, `score(d) = w/(K + rank_a) +
 *    (1−w)/(K + rank_b)` at `K = RERANK_RRF_K`, extended to N legs by giving
 *    each leg its own share. A leg that never retrieved `d` contributes ZERO,
 *    not a synthetic tail rank — an invented rank is a measurement the run
 *    never made.
 * 2. **Provenance-match first.** Two published conclusions in this project died
 *    to a hand-rolled join that skipped it (GUIDE § Landmines), so every
 *    `PROVENANCE_FIELDS` entry except the ones the experiment deliberately
 *    varies MUST be equal across the legs, and a drift REFUSES by name.
 * 3. **Every score comes from `score.ts` / `metrics.ts`**, the modules
 *    `pytrec_eval` attests. A second formula here could drift from the one the
 *    recorded runs were measured with.
 *
 * And one guard it adds: each leg's `.trec` is re-scored against the qrels ON
 * DISK and must reproduce its RECORDED nDCG@10. A run that no longer reproduces
 * is not evidence, and a forecast built on it forecasts nothing.
 */
import { cell } from './cli/shared.js';
import { PROVENANCE_FIELDS, type ProvenanceField } from './compare.js';
import type { Qrel } from './metrics.js';
import type { HistoryRow } from './report.js';
import { type DatasetScore, scoreDataset } from './score.js';

/** The engine's RRF constant (`packages/gnosis/src/config.ts:RERANK_RRF_K`), restated for an offline fuse. */
export const RERANK_RRF_K = 20;

/** The depth every fusable leg was retrieved to, and the depth a fusion is truncated to. */
export const FUSE_DEPTH = 100;

/** The weight the FIRST leg carries; the second carries `1 − w`. */
export const FUSE_WEIGHTS: readonly number[] = [0.3, 0.5, 0.7];

/** The three-way forecast is uniform — no weight is claimed for it, so none is invented. */
export const THREE_WAY_SHARE = 1 / 3;

/** How far a re-scored leg may sit from its recorded nDCG@10 before it is not the same run. */
export const REPRODUCTION_TOLERANCE = 1e-9;

/** Below this a per-topic difference is a TIE, not a win — see `headToHead`. */
export const TIE_TOLERANCE = 1e-9;

const DIGITS = 4;

/**
 * The fields the forecast deliberately VARIES across its legs: the adapter and
 * the whole PRF treatment. Everything else in `PROVENANCE_FIELDS` must hold
 * still, or the legs describe different measurements and fusing them fuses
 * nothing.
 */
export const FUSE_VARIED_FIELDS: readonly ProvenanceField[] = [
  'adapter',
  'prf',
  'prfDocs',
  'prfTerms',
  'prfAlpha',
];

/** Every field the legs MUST agree on. Derived, so it cannot drift from `compare.ts`. */
export const FUSE_GUARDED_FIELDS: readonly ProvenanceField[] = PROVENANCE_FIELDS.filter(
  field => !FUSE_VARIED_FIELDS.includes(field)
);

/** One leg: a recorded row and the rankings its `.trec` holds. */
export interface Leg {
  readonly label: string;
  readonly row: HistoryRow;
  readonly rankings: ReadonlyMap<string, readonly string[]>;
}

/** One leg's value for a guarded field, labelled so a drift names who disagreed. */
export interface LegValue {
  readonly label: string;
  readonly value: string;
}

/** A guarded field whose value is not the same on every leg. */
export interface ProvenanceDrift {
  readonly field: ProvenanceField;
  readonly values: readonly LegValue[];
}

/** An absent field is ABSENT, never `0` — it must not compare equal to a measured zero. */
const describeValue = (row: HistoryRow, field: ProvenanceField): string => {
  const value = row[field];
  return value === undefined || value === null ? '(absent)' : String(value);
};

const fieldValues = (
  legs: readonly Leg[],
  field: ProvenanceField
): readonly LegValue[] =>
  legs.map(leg => ({ label: leg.label, value: describeValue(leg.row, field) }));

const isDrifted = (drift: ProvenanceDrift): boolean =>
  new Set(drift.values.map(item => item.value)).size > 1;

/** Every guarded field that moved between the legs, with each leg's value. */
export const provenanceDrift = (legs: readonly Leg[]): readonly ProvenanceDrift[] =>
  FUSE_GUARDED_FIELDS.map(field => ({ field, values: fieldValues(legs, field) })).filter(
    isDrifted
  );

const describeDrift = (drift: ProvenanceDrift): string =>
  `${drift.field}: ${drift.values.map(item => `${item.label}=${item.value}`).join(', ')}`;

/** `error.cause` when the legs handed to a fusion did not measure the same thing. */
export const FUSE_PROVENANCE_DRIFT_CAUSE = 'dp-gnosis-bench/fuse-forecast-provenance-drift';

/** `error.cause` when a leg's persisted `.trec` no longer yields its recorded number. */
export const FUSE_NO_REPRODUCE_CAUSE = 'dp-gnosis-bench/fuse-forecast-leg-not-reproduced';

/**
 * REFUSE a set of legs that do not describe the same measurement. The message
 * names every drifted field and every leg's value — a bare "provenance differs"
 * is what let the two dead conclusions through.
 */
export const assertProvenanceMatch = (legs: readonly Leg[]): void => {
  const drift = provenanceDrift(legs);
  if (drift.length === 0) return;
  throw new Error(
    `dp-gnosis-bench: the fusion legs do not share provenance — ${drift.length} field(s) drifted:` +
      `\n  ${drift.map(describeDrift).join('\n  ')}`,
    { cause: FUSE_PROVENANCE_DRIFT_CAUSE }
  );
};

/**
 * The rankings keyed by the QRELS topic set, not by the run file: a topic that
 * retrieved nothing has no line in the `.trec` and would otherwise be silently
 * dropped from the mean — the convention `metrics.ts` is attested under.
 */
export const alignedRankings = (
  qrels: ReadonlyMap<string, Qrel>,
  run: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly string[]> =>
  new Map([...qrels.keys()].map(queryId => [queryId, run.get(queryId) ?? []]));

/** REFUSE a leg whose persisted `.trec` no longer reproduces the number it recorded. */
export const assertReproduces = (label: string, recorded: number, recomputed: number): void => {
  if (Math.abs(recorded - recomputed) <= REPRODUCTION_TOLERANCE) return;
  throw new Error(
    `dp-gnosis-bench: leg "${label}" no longer reproduces its recorded nDCG@10 — ` +
      `recorded ${recorded.toFixed(DIGITS)} vs re-scored ${recomputed.toFixed(DIGITS)}. ` +
      'A run that no longer reproduces is not evidence.',
    { cause: FUSE_NO_REPRODUCE_CAUSE }
  );
};

/**
 * One fused document and the RRF score that placed it. EXPORTED because a
 * caller that fuses live retrievals (`run.ts` `--fuse-legs`) has to carry the
 * fused score onto the atom it hands downstream: the per-leg BM25 score no
 * longer describes the order it is printed beside.
 */
export interface Scored {
  readonly docId: string;
  readonly score: number;
}

/** Score descending; an exact tie breaks on the id, so the fusion is deterministic. */
const byScoreThenId = (left: Scored, right: Scored): number =>
  right.score - left.score || left.docId.localeCompare(right.docId);

const rankMap = (ranking: readonly string[]): ReadonlyMap<string, number> =>
  new Map(ranking.map((docId, index) => [docId, index + 1]));

/** A leg that never retrieved the document contributes NOTHING — never a synthetic rank. */
const contribution = (rank: number | undefined, weight: number): number =>
  rank === undefined ? 0 : weight / (RERANK_RRF_K + rank);

const fusedScore = (
  ranks: readonly ReadonlyMap<string, number>[],
  weights: readonly number[],
  docId: string
): number =>
  ranks.reduce(
    (total, map, index) => total + contribution(map.get(docId), weights[index] ?? 0),
    0
  );

/**
 * Weighted RRF over the UNION of the given rankings, 1-based ranks, truncated to
 * `depth`, WITH the score each fused id was placed by. N legs, because the
 * three-way forecast is the same arithmetic with a third share rather than a
 * second rule.
 *
 * The scores are exposed rather than dropped so a live fusion can stamp them on
 * the atoms it returns. This is a WIDENING of `rrfFuse`, never a second
 * implementation: `rrfFuse` is now its projection, so the offline forecast and
 * an online route cannot compute two different fusions.
 */
export const rrfScored = (
  rankings: readonly (readonly string[])[],
  weights: readonly number[],
  depth: number = FUSE_DEPTH
): readonly Scored[] => {
  const ranks = rankings.map(rankMap);
  const union = [...new Set(rankings.flat())];
  return union
    .map(docId => ({ docId, score: fusedScore(ranks, weights, docId) }))
    .sort(byScoreThenId)
    .slice(0, depth);
};

/** The fused ORDER alone — `rrfScored` projected onto its ids. */
export const rrfFuse = (
  rankings: readonly (readonly string[])[],
  weights: readonly number[],
  depth: number = FUSE_DEPTH
): readonly string[] => rrfScored(rankings, weights, depth).map(entry => entry.docId);

/** Fuse per topic, over the topic set the legs were aligned to. */
export const fuseRankings = (
  legs: readonly ReadonlyMap<string, readonly string[]>[],
  weights: readonly number[],
  queryIds: readonly string[]
): ReadonlyMap<string, readonly string[]> =>
  new Map(
    queryIds.map(queryId => [queryId, rrfFuse(legs.map(leg => leg.get(queryId) ?? []), weights)])
  );

/** One arm of the forecast — a single recorded leg, or a fusion of them. */
export interface ForecastArm {
  readonly label: string;
  readonly score: DatasetScore;
}

/** Which legs a fusion combines, and the share each carries. */
export interface FusionSpec {
  readonly label: string;
  readonly legs: readonly number[];
  readonly weights: readonly number[];
}

const pairSpec = (labels: readonly string[], first: number, weight: number): FusionSpec => ({
  label: `${labels[first] ?? ''}⊕${labels[1] ?? ''} w=${weight}`,
  legs: [first, 1],
  weights: [weight, 1 - weight],
});

const threeWaySpec = (labels: readonly string[]): FusionSpec => ({
  label: `${labels.join('⊕')} uniform`,
  legs: [0, 1, 2],
  weights: [THREE_WAY_SHARE, THREE_WAY_SHARE, THREE_WAY_SHARE],
});

/**
 * Every fusion the forecast reports: `fts5⊕linear` and `(fts5+prf)⊕linear` at
 * each weight, then the uniform three-way. Leg 1 (`linear`) is the partner in
 * both pairs, so `w` always names the FIRST leg's share.
 */
export const fusionSpecs = (labels: readonly string[]): readonly FusionSpec[] => [
  ...FUSE_WEIGHTS.map(weight => pairSpec(labels, 0, weight)),
  ...FUSE_WEIGHTS.map(weight => pairSpec(labels, 2, weight)),
  threeWaySpec(labels),
];

/** Everything the report needs, already read off disk. */
export interface ForecastInput {
  readonly dataset: string;
  /** The three legs in order: `fts5`, `linear`, `fts5+prf`. */
  readonly legs: readonly Leg[];
  readonly qrels: ReadonlyMap<string, Qrel>;
}

const legScore = (leg: Leg, qrels: ReadonlyMap<string, Qrel>): DatasetScore =>
  scoreDataset(alignedRankings(qrels, leg.rankings), qrels, FUSE_DEPTH);

/**
 * Each leg re-scored from its persisted `.trec`, REFUSING any leg that no longer
 * reproduces its recorded number.
 */
export const legArms = (input: ForecastInput): readonly ForecastArm[] =>
  input.legs.map(leg => {
    const score = legScore(leg, input.qrels);
    assertReproduces(leg.label, leg.row.ndcg10, score.mean.ndcg10);
    return { label: leg.label, score };
  });

const fusionArm = (input: ForecastInput, spec: FusionSpec): ForecastArm => {
  const aligned = input.legs.map(leg => alignedRankings(input.qrels, leg.rankings));
  const chosen = spec.legs.map(index => aligned[index] ?? new Map());
  const fused = fuseRankings(chosen, spec.weights, [...input.qrels.keys()]);
  return { label: spec.label, score: scoreDataset(fused, input.qrels, FUSE_DEPTH) };
};

/** The single legs, then every fusion — the table's row order. */
export const forecastArms = (input: ForecastInput): readonly ForecastArm[] => {
  assertProvenanceMatch(input.legs);
  const labels = input.legs.map(leg => leg.label);
  return [...legArms(input), ...fusionSpecs(labels).map(spec => fusionArm(input, spec))];
};

/** A per-topic complementarity count on nDCG@10 — the claim is never the mean. */
export interface HeadToHead {
  readonly left: string;
  readonly right: string;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
}

type Outcome = 'win' | 'loss' | 'tie';

const outcomeOf = (left: number, right: number): Outcome => {
  if (Math.abs(left - right) <= TIE_TOLERANCE) return 'tie';
  return left > right ? 'win' : 'loss';
};

const ndcgByTopic = (score: DatasetScore): ReadonlyMap<string, number> =>
  new Map(score.perTopic.map(topic => [topic.queryId, topic.metrics.ndcg10]));

const requireScore = (byTopic: ReadonlyMap<string, number>, queryId: string): number => {
  const value = byTopic.get(queryId);
  if (value === undefined) {
    throw new Error(`dp-gnosis-bench: topic "${queryId}" is missing from the compared arm`);
  }
  return value;
};

const countOf = (outcomes: readonly Outcome[], wanted: Outcome): number =>
  outcomes.filter(outcome => outcome === wanted).length;

/** Per-topic win / loss / tie of `left` against `right` on nDCG@10. */
export const headToHead = (left: ForecastArm, right: ForecastArm): HeadToHead => {
  const rightByTopic = ndcgByTopic(right.score);
  const outcomes = left.score.perTopic.map(topic =>
    outcomeOf(topic.metrics.ndcg10, requireScore(rightByTopic, topic.queryId))
  );
  return {
    left: left.label,
    right: right.label,
    wins: countOf(outcomes, 'win'),
    losses: countOf(outcomes, 'loss'),
    ties: countOf(outcomes, 'tie'),
  };
};

const armRow = (arm: ForecastArm): string =>
  `| ${arm.label} | ${cell(arm.score.mean.ndcg10)} | ${cell(arm.score.mean.recall100)} |`;

const headToHeadRow = (pair: HeadToHead): string =>
  `| ${pair.left} vs ${pair.right} | ${pair.wins} | ${pair.losses} | ${pair.ties} |`;

/** The two complementarity pairs the plan names: each `fts5` variant against `linear`. */
export const headToHeadPairs = (arms: readonly ForecastArm[]): readonly HeadToHead[] => {
  const [fts5, linear, prf] = arms;
  return fts5 === undefined || linear === undefined || prf === undefined
    ? []
    : [headToHead(fts5, linear), headToHead(prf, linear)];
};

const armSection = (arms: readonly ForecastArm[]): readonly string[] => [
  '| arm | nDCG@10 | R@100 |',
  '| --- | --- | --- |',
  ...arms.map(armRow),
];

const pairSection = (arms: readonly ForecastArm[]): readonly string[] => [
  '| pair (per-topic nDCG@10) | win | loss | tie |',
  '| --- | --- | --- | --- |',
  ...headToHeadPairs(arms).map(headToHeadRow),
];

/**
 * The whole per-dataset forecast as markdown — pure, so every guard above is
 * assertable without a results directory, a dataset on disk, or a GPU.
 */
export const forecastReport = (input: ForecastInput): readonly string[] => {
  const arms = forecastArms(input);
  return [
    `### ${input.dataset} — offline RRF forecast (K=${RERANK_RRF_K}, depth ${FUSE_DEPTH})`,
    '',
    ...armSection(arms),
    '',
    ...pairSection(arms),
  ];
};
