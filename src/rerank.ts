/**
 * The SERVING-path reranker: `retrieve --rerank`, opt-in.
 *
 * Two decisions live here and nowhere else.
 *
 * FUSION, not replacement — the reranked order is RRF-fused with the first-pass
 * order (`src/config.ts`, `RERANK_RRF_K` / `RERANK_RRF_WEIGHT`), because pure
 * reranking measurably regresses MRR while the fused cell improves every
 * metric. A future edit that makes the first-pass term unreachable is a quality
 * regression, not a simplification. The `beir-ce` preset does drop it, but only
 * for a caller that asks for it BY NAME, to reproduce the published BEIR
 * BM25+CE protocol; the default is and stays `shipped`.
 *
 * REFUSAL, not fallback — an endpoint that is down, or up without the model, is
 * reported as a usage failure. Returning unreranked atoms under `--rerank`
 * would make a quality flag lie about what produced the ranking, and no caller
 * could tell the two rankings apart afterwards.
 *
 * The HTTP client is `bench/reranker.ts`'s: one client, one wire format.
 */
import { createRerankerClient, extractDoc, type RerankResult } from './bench/reranker.js';
import {
  DEFAULT_RERANK_PRESET,
  RERANK_DEFAULT_URL,
  RERANK_DOC_MAX_CHARS,
  RERANK_FUSION_PRESETS,
  RERANK_MODEL_ID,
  RERANK_PRESET_NAMES,
  RERANK_URL_ENV_VAR,
  type RerankFusion,
  type RerankPresetName
} from './config.js';
import type { RetrievedAtom } from './port.js';

/** The measured extraction: the atom's HEAD, `RERANK_DOC_MAX_CHARS` wide. */
const EXTRACT_STRATEGY = 'head';

/**
 * Client-side chunking limit, mirroring `DEFAULT_RERANKERS`' `maxBatchTokens`
 * for this model — it is the physical batch llama.cpp serves it with, so a
 * larger request is rejected on the wire rather than ranked.
 */
const MAX_BATCH_TOKENS = 8000;

/** One HTTP call's ceiling. A reranker pass is a foreground CLI wait. */
const TIMEOUT_MS = 60000;

/** The llama-swap model catalogue, per the OpenAI-compatible API. */
const MODELS_PATH = '/v1/models';

/** The base URL to query. The env override outranks the default, as a flag would. */
export const resolveRerankUrl = (
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const declared = (env[RERANK_URL_ENV_VAR] ?? '').trim();
  return declared.length > 0 ? declared : RERANK_DEFAULT_URL;
};

/** One fused entry: the first-pass item and the score that reordered it. */
export interface FusedItem<T> {
  readonly item: T;
  readonly score: number;
}

type RrfFusion = Extract<RerankFusion, { readonly kind: 'rrf' }>;

const rrfTerm = (rrfK: number, weight: number, rank: number | undefined): number =>
  rank === undefined ? 0 : weight / (rrfK + rank);

/** One candidate's two 1-based ranks, plus how many the reranker returned. */
interface Ranks {
  /** `undefined` when the reranker did not return this candidate. */
  readonly rerank: number | undefined;
  readonly firstPass: number;
  readonly returned: number;
}

const rrfScore = (fusion: RrfFusion, ranks: Ranks): number =>
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
  readonly rerankWeight?: number;
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

/** What `rerankAtoms` hands back: a new order, or a message naming the fault. */
export type RerankOutcome =
  | { readonly ok: true; readonly atoms: readonly RetrievedAtom[] }
  | { readonly ok: false; readonly error: string };

/**
 * Where to score, and under which id. The model travels WITH the URL because
 * every refusal message names both: a message that named the shipped id while
 * another was requested would send the reader to fix the wrong entry.
 */
interface Endpoint {
  readonly baseUrl: string;
  readonly model: string;
}

const request = (model: string): string =>
  `retrieve --rerank: reranker model "${model}" was requested`;

const requirement = (model: string): string =>
  ` — llama-swap MUST serve a reranker under the id "${model}"; `;

const DROP = ', or drop --rerank to retrieve without reranking.';

/** Server DOWN: the catalogue call itself did not complete. */
const unreachableMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} did not answer GET ${MODELS_PATH} (server down: ${cause})${requirement(endpoint.model)}start llama-swap on that address, or point ${RERANK_URL_ENV_VAR} at the host that serves it, then re-run${DROP}`;

/** Server UP, model absent: the catalogue answered and does not list the id. */
const notServedMessage = (endpoint: Endpoint, served: readonly string[]): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} answered GET ${MODELS_PATH} but does not serve it (model not served; it serves: ${served.join(', ') || 'nothing'})${requirement(endpoint.model)}add that model to the llama-swap config under exactly that id, then re-run${DROP}`;

/** The rerank call failed after the catalogue passed — still a refusal. */
const callFailedMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} accepted GET ${MODELS_PATH} but the rerank call failed (${cause})${requirement(endpoint.model)}check that the id names a RERANKER (a chat model answers /v1/models but not /v1/rerank), then re-run${DROP}`;

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const modelIds = (payload: unknown): readonly string[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []
  );
};

type Catalogue =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly cause: string };

const fetchCatalogue = async (baseUrl: string): Promise<Catalogue> => {
  try {
    const response = await fetch(`${baseUrl}${MODELS_PATH}`);
    const body = await response.text();
    return response.ok
      ? { ok: true, models: modelIds(JSON.parse(body)) }
      : { ok: false, cause: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
};

/** `undefined` when the model is served; otherwise the message to refuse with. */
const catalogueRefusal = async (endpoint: Endpoint): Promise<string | undefined> => {
  const catalogue = await fetchCatalogue(endpoint.baseUrl);
  if (!catalogue.ok) return unreachableMessage(endpoint, catalogue.cause);
  return catalogue.models.includes(endpoint.model)
    ? undefined
    : notServedMessage(endpoint, catalogue.models);
};

type ScoreResult =
  | { readonly ok: true; readonly results: readonly RerankResult[] }
  | { readonly ok: false; readonly error: string };

const scoreDocuments = async (
  endpoint: Endpoint,
  query: string,
  atoms: readonly RetrievedAtom[]
): Promise<ScoreResult> => {
  const client = createRerankerClient(
    endpoint.baseUrl,
    endpoint.model,
    TIMEOUT_MS,
    MAX_BATCH_TOKENS
  );
  const documents = atoms.map(atom =>
    extractDoc(atom.body, EXTRACT_STRATEGY, RERANK_DOC_MAX_CHARS)
  );
  try {
    return { ok: true, results: await client.rerank(query, documents) };
  } catch (error) {
    return { ok: false, error: callFailedMessage(endpoint, causeOf(error)) };
  }
};

const bestFirst = (results: readonly RerankResult[]): readonly number[] =>
  [...results].sort((left, right) => right.relevanceScore - left.relevanceScore).map(r => r.index);

/**
 * What a caller may vary. All three are omissible and each defaults to what the
 * CLI has always done, so an existing two-argument call is unchanged.
 *
 * `model` names the cross-encoder to score with. A caller measuring a second
 * reranker MUST pass it AND record it: two models produce two different
 * rankings, and a run that does not carry the id cannot be told from one that
 * used another model. An unserved id still REFUSES — a wrong model must never
 * degrade into the first-pass order.
 */
export interface RerankOptions {
  readonly baseUrl?: string;
  readonly fusion?: RerankFusion;
  readonly model?: string;
}

/** The env-resolved URL, the shipped preset and the shipped model id. */
const resolved = (options: RerankOptions): Required<RerankOptions> => ({
  baseUrl: options.baseUrl ?? resolveRerankUrl(),
  fusion: options.fusion ?? RERANK_FUSION_PRESETS[DEFAULT_RERANK_PRESET],
  model: options.model ?? RERANK_MODEL_ID,
});

/**
 * Reorder `atoms` by the fused ranking, carrying the FUSED score on each atom —
 * the score a caller reads must be the one that produced the order it reads.
 */
export const rerankAtoms = async (
  query: string,
  atoms: readonly RetrievedAtom[],
  options: RerankOptions = {}
): Promise<RerankOutcome> => {
  const { baseUrl, fusion, model } = resolved(options);
  const endpoint: Endpoint = { baseUrl, model };
  const refusal = await catalogueRefusal(endpoint);
  if (refusal !== undefined) return { ok: false, error: refusal };
  const scored = await scoreDocuments(endpoint, query, atoms);
  if (!scored.ok) return { ok: false, error: scored.error };
  const fused = fuseRanking(atoms, bestFirst(scored.results), fusion);
  return { ok: true, atoms: fused.map(entry => ({ ...entry.item, score: entry.score })) };
};
