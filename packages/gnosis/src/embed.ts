/**
 * The embedding client — the dense leg's only network hop, mirroring
 * `rerank.ts`: HTTP to llama-swap's OpenAI-compatible `/v1/embeddings`, zero
 * npm dependencies, and REFUSAL rather than fallback.
 *
 * EMBED THE RAW BODY. The text handed here is the atom body verbatim — never
 * `stemText`. Stemming is correct for BM25 and WRONG for a transformer: a
 * vector column built from stemmed text embeds without any error and silently
 * underperforms, which is exactly the failure class this project keeps getting
 * burned by. The query is embedded raw for the same reason.
 *
 * REFUSAL, not fallback — a server that is down, a server that does not serve
 * the model, and a response that is missing a text are all reported as usage
 * failures. A zero vector, a random vector, or a skipped document would each
 * produce a well-formed index carrying no signal, and nothing downstream could
 * tell it from a real one.
 *
 * Repeated calls go through the sidecar cache (`embedCache.ts`) when the caller
 * passes one; a fully-cached call makes no request at all.
 */
import {
  EMBED_DEFAULT_URL,
  EMBED_MODEL_ID,
  EMBED_URL_ENV_VAR
} from './config.js';
import type { EmbeddingCache } from './embedCache.js';

/** One HTTP call's ceiling. An embedding pass is a foreground wait. */
const TIMEOUT_MS = 60000;

/** The llama-swap model catalogue, per the OpenAI-compatible API. */
const MODELS_PATH = '/v1/models';

/** The embedding endpoint, per the OpenAI-compatible API. */
const EMBEDDINGS_PATH = '/v1/embeddings';

/** How much of a failed response body a refusal quotes back. */
const ERROR_BODY_MAX_CHARS = 300;

/** The base URL to embed at. The env override outranks the default, as a flag would. */
export const resolveEmbedUrl = (
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const declared = (env[EMBED_URL_ENV_VAR] ?? '').trim();
  return declared.length > 0 ? declared : EMBED_DEFAULT_URL;
};

/** Where to embed, and under which id — every refusal message names both. */
interface Endpoint {
  readonly baseUrl: string;
  readonly model: string;
}

const request = (model: string): string => `embed: embedding model "${model}" was requested`;

const requirement = (model: string): string =>
  ` — llama-swap MUST serve an embedding model under the id "${model}"; `;

/** Server DOWN: the catalogue call itself did not complete. */
const unreachableMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} did not answer GET ${MODELS_PATH} (server down: ${cause})${requirement(endpoint.model)}start llama-swap on that address, or point ${EMBED_URL_ENV_VAR} at the host that serves it, then re-run.`;

/** Server UP, model absent: the catalogue answered and does not list the id. */
const notServedMessage = (endpoint: Endpoint, served: readonly string[]): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} answered GET ${MODELS_PATH} but does not serve it (model not served; it serves: ${served.join(', ') || 'nothing'})${requirement(endpoint.model)}add that model to the llama-swap config under exactly that id, then re-run.`;

/** The embedding call failed after the catalogue passed — still a refusal. */
const callFailedMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} accepted GET ${MODELS_PATH} but the embedding call failed (${cause})${requirement(endpoint.model)}check that the id names an EMBEDDING model, then re-run.`;

const incompleteCause = (expected: number): string =>
  `the response did not return an embedding for all ${String(expected)} texts`;

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const isNumberArray = (value: unknown): value is readonly number[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'number');

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

/** One `data` entry: its input POSITION and the vector for it. */
const entryPair = (entry: unknown): readonly (readonly [number, readonly number[]])[] =>
  isRecord(entry) && typeof entry.index === 'number' && isNumberArray(entry.embedding)
    ? [[entry.index, entry.embedding]]
    : [];

/** `index` is the ONLY ordering source — the server does not guarantee an order. */
const embeddingsByIndex = (payload: unknown): ReadonlyMap<number, readonly number[]> => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return new Map();
  return new Map(payload.data.flatMap(entryPair));
};

/** `undefined` unless every input position came back — a gap is a refusal, not a drop. */
const orderedVectors = (
  payload: unknown,
  expected: number
): readonly (readonly number[])[] | undefined => {
  const byIndex = embeddingsByIndex(payload);
  const ordered = Array.from({ length: expected }, (_unused, index) => index).flatMap(index => {
    const vector = byIndex.get(index);
    return vector === undefined ? [] : [vector];
  });
  return ordered.length === expected ? ordered : undefined;
};

/** The vectors, or the message naming why there are none. */
export type EmbedOutcome =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[] }
  | { readonly ok: false; readonly error: string };

const postEmbeddings = async (endpoint: Endpoint, texts: readonly string[]): Promise<unknown> => {
  const response = await fetch(`${endpoint.baseUrl}${EMBEDDINGS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: endpoint.model, input: [...texts] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, ERROR_BODY_MAX_CHARS)}`);
  }
  return JSON.parse(body);
};

/** The catalogue gate, then the call itself. Both faults refuse. */
const fetchVectors = async (
  endpoint: Endpoint,
  texts: readonly string[]
): Promise<EmbedOutcome> => {
  const refusal = await catalogueRefusal(endpoint);
  if (refusal !== undefined) return { ok: false, error: refusal };
  try {
    const vectors = orderedVectors(await postEmbeddings(endpoint, texts), texts.length);
    return vectors === undefined
      ? { ok: false, error: callFailedMessage(endpoint, incompleteCause(texts.length)) }
      : { ok: true, vectors };
  } catch (error) {
    return { ok: false, error: callFailedMessage(endpoint, causeOf(error)) };
  }
};

/** What a caller may vary; each defaults to the shipped configuration. */
export interface EmbedOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  /** The sidecar for the index these vectors are being built for. */
  readonly cache?: EmbeddingCache;
}

const lookup = async (
  cache: EmbeddingCache | undefined,
  texts: readonly string[]
): Promise<readonly (readonly number[] | undefined)[]> =>
  await Promise.all(texts.map(async text => await cache?.get(text)));

const store = async (
  cache: EmbeddingCache | undefined,
  texts: readonly string[],
  vectors: readonly (readonly number[])[]
): Promise<void> => {
  if (cache === undefined) return;
  await Promise.all(
    texts.flatMap((text, index) => {
      const vector = vectors[index];
      return vector === undefined ? [] : [cache.put(text, vector)];
    })
  );
};

const positionsOf = (cached: readonly (readonly number[] | undefined)[]): readonly number[] =>
  cached.flatMap((vector, position) => (vector === undefined ? [position] : []));

/** Cache hits in place, freshly embedded vectors back at the positions they came from. */
const merged = (
  cached: readonly (readonly number[] | undefined)[],
  positions: readonly number[],
  fresh: readonly (readonly number[])[]
): readonly (readonly number[])[] => {
  const byPosition = new Map(
    positions.flatMap((position, index) => {
      const vector = fresh[index];
      return vector === undefined ? [] : [[position, vector] as const];
    })
  );
  return cached.flatMap((vector, position) => {
    const resolved = vector ?? byPosition.get(position);
    return resolved === undefined ? [] : [resolved];
  });
};

const endpointOf = (options: EmbedOptions): Endpoint => ({
  baseUrl: options.baseUrl ?? resolveEmbedUrl(),
  model: options.model ?? EMBED_MODEL_ID,
});

/**
 * Embeds `texts` — RAW, in input order, one vector per text or none at all.
 *
 * With a cache, only the misses reach the wire and the fresh vectors are
 * written back; a refused call writes nothing, so a later run re-embeds rather
 * than reading a vector no server ever produced.
 */
export const embedTexts = async (
  texts: readonly string[],
  options: EmbedOptions = {}
): Promise<EmbedOutcome> => {
  const endpoint = endpointOf(options);
  const cached = await lookup(options.cache, texts);
  const positions = positionsOf(cached);
  const misses = positions.flatMap(position => texts.slice(position, position + 1));
  if (misses.length === 0) return { ok: true, vectors: merged(cached, positions, []) };
  const fresh = await fetchVectors(endpoint, misses);
  if (!fresh.ok) return fresh;
  await store(options.cache, misses, fresh.vectors);
  return { ok: true, vectors: merged(cached, positions, fresh.vectors) };
};
