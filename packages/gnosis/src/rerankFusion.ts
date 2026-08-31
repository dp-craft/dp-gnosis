/**
 * The rerank FUSION arithmetic — the MODEL only. PURE: no I/O, no HTTP, no
 * clock, no probe. It takes ranks and a preset and returns a fused order.
 *
 * WHY it lives apart from `rerank.ts`: `prf.ts` states the rule this file
 * follows — "the arithmetic below is what a later sweep tunes and what a test
 * can pin exactly, while the adapter around it is SQLite and disk. Separating
 * them is what lets the model be hand-checked." The same holds here: an 11-point
 * offline re-fusion of recorded runs is how this weight surface was mapped
 * (handbook/GNOSIS-GUIDE.md), while `rerank.ts` around it is a wire client, a
 * GGUF loader and a memoised probe.
 *
 * ONE OWNER: every fusion in the engine is scored here. `rerank.ts` uses the
 * reranker↔first-pass form (`fuseRanking`) and `adapters/lanceDbDenseAdapter.ts`
 * uses the union form (`fuseLegs`); both reduce to the same `rrfTerm`, so a
 * weight change cannot reach one route and miss the other. A second fusion
 * anywhere is a second, invisible ranking.
 *
 * `rerank.ts` re-exports this file's public surface, so an existing call site
 * that imports fusion from there is unchanged.
 */
import {
  DEFAULT_RERANK_PRESET,
  RERANK_FUSION_PRESETS,
  RERANK_PRESET_NAMES,
  type RerankFusion,
  type RerankPresetName
} from './config.js';

/** One fused entry: the first-pass item and the score that reordered it. */
export interface FusedItem<T> {
  readonly item: T;
  readonly score: number;
}

type RrfFusion = Extract<RerankFusion, { readonly kind: 'rrf' }>;

const rrfTerm = (rrfK: number, weight: number, rank: number | undefined): number =>
  rank === undefined ? 0 : weight / (rrfK + rank);

/**
 * The two 1-based ranks RRF scores. BOTH are optional because a two-leg fusion
 * has candidates that only one leg returned; the rerank path simply never
 * passes `undefined` for `firstPass`, since every candidate came from it.
 */
interface RrfRanks {
  readonly rerank: number | undefined;
  readonly firstPass: number | undefined;
}

/** One candidate's two 1-based ranks, plus how many the reranker returned. */
interface Ranks extends RrfRanks {
  /** `undefined` when the reranker did not return this candidate. */
  readonly rerank: number | undefined;
  readonly firstPass: number;
  readonly returned: number;
}

const rrfScore = (fusion: RrfFusion, ranks: RrfRanks): number =>
  rrfTerm(fusion.rrfK, fusion.rerankWeight, ranks.rerank) +
  rrfTerm(fusion.rrfK, 1 - fusion.rerankWeight, ranks.firstPass);

/**
 * The replacement score is `1/rank` over the EMITTED order: the fusion sees
 * ranks, not the cross-encoder's raw relevance scores, and a score that did not
 * produce the order it is printed beside would misread in a TREC run file. An
 * index the reranker did not return sorts below every one it did.
 */
const replacementScore = (ranks: Ranks): number =>
  1 / (ranks.rerank ?? ranks.returned + ranks.firstPass);

const fusedScore = (fusion: RerankFusion, ranks: Ranks): number =>
  fusion.kind === 'rrf' ? rrfScore(fusion, ranks) : replacementScore(ranks);

/**
 * Combines the reranked order with the first-pass order under `fusion`.
 *
 * `rerankOrder` lists FIRST-PASS INDICES best-first. An index the reranker did
 * not return is kept — scored from the first pass alone under `rrf`, appended
 * in first-pass order under `replace` — rather than dropped: a candidate that
 * reached the reranker was already retrieved, and losing it here would silently
 * shrink the result.
 */
export const fuseRanking = <T>(
  firstPass: readonly T[],
  rerankOrder: readonly number[],
  fusion: RerankFusion
): readonly FusedItem<T>[] => {
  const rerankRank = new Map(rerankOrder.map((index, position) => [index, position + 1]));
  const scored = firstPass.map((item, index) => ({
    item,
    score: fusedScore(fusion, {
      rerank: rerankRank.get(index),
      firstPass: index + 1,
      returned: rerankOrder.length,
    }),
  }));
  return [...scored].sort((left, right) => right.score - left.score);
};

/**
 * Two ranked orders over ONE pool: `items` is the union, and each leg lists the
 * indices into it that IT returned, best-first. An index a leg did not return
 * contributes nothing from that leg — which is what makes this a union fusion
 * rather than a reordering of one list.
 */
export interface RankedLegs<T> {
  readonly items: readonly T[];
  /** The leg carrying `1 - rerankWeight` — the lexical leg for the hybrid route. */
  readonly primary: readonly number[];
  /** The leg carrying `rerankWeight` — the dense leg for the hybrid route. */
  readonly secondary: readonly number[];
}

const rrfOrRefuse = (fusion: RerankFusion): RrfFusion => {
  if (fusion.kind !== 'rrf') {
    throw new Error(
      'rerank fusion: two-leg fusion is defined for an RRF preset only; a replacement preset ' +
        'would discard one leg entirely, which is not a hybrid.'
    );
  }
  return fusion;
};

const rankOf = (order: readonly number[]): ReadonlyMap<number, number> =>
  new Map(order.map((index, position) => [index, position + 1]));

/**
 * Fuses TWO ranked legs under the same RRF arithmetic `fuseRanking` uses — the
 * hybrid route reuses this file's scoring rather than owning a second fusion.
 * `fuseRanking` is the reranker↔first-pass form, where every candidate is in the
 * first pass by construction; this is the union form, where neither leg is.
 */
export const fuseLegs = <T>(
  legs: RankedLegs<T>,
  fusion: RerankFusion
): readonly FusedItem<T>[] => {
  const rrf = rrfOrRefuse(fusion);
  const primary = rankOf(legs.primary);
  const secondary = rankOf(legs.secondary);
  const scored = legs.items.map((item, index) => ({
    item,
    score: rrfScore(rrf, { rerank: secondary.get(index), firstPass: primary.get(index) }),
  }));
  return [...scored].sort((left, right) => right.score - left.score);
};

/** `undefined` when `name` is not a preset — the caller decides how to refuse. */
const presetOf = (name: string): RerankFusion | undefined =>
  (RERANK_PRESET_NAMES as readonly string[]).includes(name)
    ? RERANK_FUSION_PRESETS[name as RerankPresetName]
    : undefined;

const presetOrRefuse = (name: string): RerankFusion => {
  const preset = presetOf(name);
  if (preset !== undefined) return preset;
  throw new Error(
    `rerank fusion: unknown preset "${name}" — known presets are ${RERANK_PRESET_NAMES.join(', ')}.`
  );
};

const weighted = (fusion: RerankFusion, rerankWeight: number): RerankFusion => {
  if (fusion.kind !== 'rrf') {
    throw new Error(
      `rerank fusion: a weight override applies only to an RRF preset; "beir-ce" has no weight term.`
    );
  }
  return { ...fusion, rerankWeight };
};

/** A raw numeric override on top of a named preset — the parameters stay measurable. */
export interface RerankFusionOverrides {
  readonly rerankWeight?: number | undefined;
}

/**
 * The fusion a NAME selects, with any raw override applied. An unknown name is
 * a usage error, not a fallback to the default: silently reranking under the
 * shipped protocol when `beir-ce` was asked for would publish the wrong number
 * under the right label.
 */
export const resolveRerankFusion = (
  name: string = DEFAULT_RERANK_PRESET,
  overrides: RerankFusionOverrides = {}
): RerankFusion => {
  const preset = presetOrRefuse(name);
  const { rerankWeight } = overrides;
  return rerankWeight === undefined ? preset : weighted(preset, rerankWeight);
};
