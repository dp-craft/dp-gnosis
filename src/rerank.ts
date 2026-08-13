/**
 * The SERVING-path reranker: `retrieve --rerank`, opt-in.
 *
 * Two decisions live here and nowhere else.
 *
 * FUSION, not replacement — the reranked order is RRF-fused with the first-pass
 * order (`src/config.ts`, `RERANK_RRF_K` / `RERANK_RRF_WEIGHT`), because pure
 * reranking measurably regresses MRR while the fused cell improves every
 * metric. A future edit that drops the first-pass term is a quality regression,
 * not a simplification.
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
  RERANK_DEFAULT_URL,
  RERANK_DOC_MAX_CHARS,
  RERANK_MODEL_ID,
  RERANK_RRF_K,
  RERANK_RRF_WEIGHT,
  RERANK_URL_ENV_VAR
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

const rrfTerm = (weight: number, rank: number | undefined): number =>
  rank === undefined ? 0 : weight / (RERANK_RRF_K + rank);

/**
 * Reciprocal-rank fusion of the reranked order with the first-pass order.
 *
 * `rerankOrder` lists FIRST-PASS INDICES best-first. An index the reranker did
 * not return keeps its first-pass term alone rather than being dropped: a
 * candidate that reached the reranker was already retrieved, and losing it here
 * would silently shrink the result.
 */
export const fuseByRrf = <T>(
  firstPass: readonly T[],
  rerankOrder: readonly number[]
): readonly FusedItem<T>[] => {
  const rerankRank = new Map(rerankOrder.map((index, position) => [index, position + 1]));
  const scored = firstPass.map((item, index) => ({
    item,
    score:
      rrfTerm(RERANK_RRF_WEIGHT, rerankRank.get(index)) +
      rrfTerm(1 - RERANK_RRF_WEIGHT, index + 1),
  }));
  return [...scored].sort((left, right) => right.score - left.score);
};

/** What `rerankAtoms` hands back: a new order, or a message naming the fault. */
export type RerankOutcome =
  | { readonly ok: true; readonly atoms: readonly RetrievedAtom[] }
  | { readonly ok: false; readonly error: string };

const REQUEST = `retrieve --rerank: reranker model "${RERANK_MODEL_ID}" was requested`;

const REQUIREMENT = ` — llama-swap MUST serve a reranker under the id "${RERANK_MODEL_ID}"; `;

const DROP = ', or drop --rerank to retrieve without reranking.';

/** Server DOWN: the catalogue call itself did not complete. */
const unreachableMessage = (baseUrl: string, cause: string): string =>
  `${REQUEST}; the server at ${baseUrl} did not answer GET ${MODELS_PATH} (server down: ${cause})${REQUIREMENT}start llama-swap on that address, or point ${RERANK_URL_ENV_VAR} at the host that serves it, then re-run${DROP}`;

/** Server UP, model absent: the catalogue answered and does not list the id. */
const notServedMessage = (baseUrl: string, served: readonly string[]): string =>
  `${REQUEST}; the server at ${baseUrl} answered GET ${MODELS_PATH} but does not serve it (model not served; it serves: ${served.join(', ') || 'nothing'})${REQUIREMENT}add that model to the llama-swap config under exactly that id, then re-run${DROP}`;

/** The rerank call failed after the catalogue passed — still a refusal. */
const callFailedMessage = (baseUrl: string, cause: string): string =>
  `${REQUEST}; the server at ${baseUrl} accepted GET ${MODELS_PATH} but the rerank call failed (${cause})${REQUIREMENT}check that the id names a RERANKER (a chat model answers /v1/models but not /v1/rerank), then re-run${DROP}`;

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
const catalogueRefusal = async (baseUrl: string): Promise<string | undefined> => {
  const catalogue = await fetchCatalogue(baseUrl);
  if (!catalogue.ok) return unreachableMessage(baseUrl, catalogue.cause);
  return catalogue.models.includes(RERANK_MODEL_ID)
    ? undefined
    : notServedMessage(baseUrl, catalogue.models);
};

type ScoreResult =
  | { readonly ok: true; readonly results: readonly RerankResult[] }
  | { readonly ok: false; readonly error: string };

const scoreDocuments = async (
  baseUrl: string,
  query: string,
  atoms: readonly RetrievedAtom[]
): Promise<ScoreResult> => {
  const client = createRerankerClient(baseUrl, RERANK_MODEL_ID, TIMEOUT_MS, MAX_BATCH_TOKENS);
  const documents = atoms.map(atom =>
    extractDoc(atom.body, EXTRACT_STRATEGY, RERANK_DOC_MAX_CHARS)
  );
  try {
    return { ok: true, results: await client.rerank(query, documents) };
  } catch (error) {
    return { ok: false, error: callFailedMessage(baseUrl, causeOf(error)) };
  }
};

const bestFirst = (results: readonly RerankResult[]): readonly number[] =>
  [...results].sort((left, right) => right.relevanceScore - left.relevanceScore).map(r => r.index);

/**
 * Reorder `atoms` by the fused ranking, carrying the FUSED score on each atom —
 * the score a caller reads must be the one that produced the order it reads.
 */
export const rerankAtoms = async (
  query: string,
  atoms: readonly RetrievedAtom[],
  baseUrl: string = resolveRerankUrl()
): Promise<RerankOutcome> => {
  const refusal = await catalogueRefusal(baseUrl);
  if (refusal !== undefined) return { ok: false, error: refusal };
  const scored = await scoreDocuments(baseUrl, query, atoms);
  if (!scored.ok) return { ok: false, error: scored.error };
  const fused = fuseByRrf(atoms, bestFirst(scored.results));
  return { ok: true, atoms: fused.map(entry => ({ ...entry.item, score: entry.score })) };
};
