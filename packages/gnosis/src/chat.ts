/**
 * The provider seam for GENERATION — the only place `enrich` learns how to
 * reach a model, and the only place a refusal to generate is worded.
 *
 * Three decisions live here and nowhere else.
 *
 * STRICT SCHEMA, never free text — every call carries
 * `response_format: {type: 'json_schema', strict: true}` and every answer is
 * parsed as JSON. A provider whose answer is not schema-shaped JSON REFUSES.
 * Falling back to parsing prose is FORBIDDEN (plan § 6): a six-field record
 * salvaged out of commentary is indexed as search text, and a wrong field is
 * indistinguishable from a right one once it is in a column.
 *
 * REFUSAL, never a partial record — the catalogue is checked BEFORE the call,
 * exactly as `rerank.ts` and `rephrase.ts` check it, so "server down", "model
 * not served" and "the call failed" stay three different messages naming three
 * different corrections. `enrich` stops on the first refusal; the sidecar is
 * append-only, so the run resumes where it stopped.
 *
 * A SEAM, not a client — `ChatProvider` is an interface with one HTTP
 * implementation. The embedded runtime (plan § 6, phase E6) is optional and
 * last; nothing above this file may know which one it is talking to.
 *
 * The message shape is `rephrase.ts`'s, deliberately: the two features fail
 * against the same server for the same three reasons, and a reader who has
 * fixed one has already read the other. `rephrase.ts` is NOT modified — its
 * cache, its guard and its prompt are a different contract that happens to
 * share an endpoint.
 */
import {
  ENRICH_MAX_TOKENS,
  ENRICH_MODEL_ENV_VAR,
  ENRICH_MODEL_ID,
  ENRICH_SEED,
  ENRICH_TEMPERATURE,
  ENRICH_TIMEOUT_MS,
  RERANK_DEFAULT_URL,
  RERANK_URL_ENV_VAR
} from './config.js';

/** The llama-swap model catalogue, per the OpenAI-compatible API. */
const MODELS_PATH = '/v1/models';

/** The chat endpoint the generation itself goes to. */
const CHAT_PATH = '/v1/chat/completions';

/**
 * One generation. `schema` is the JSON Schema the answer MUST satisfy and
 * `schemaName` is the name the server echoes back — both travel with the call
 * rather than being owned here, so this file holds no knowledge of what is
 * being extracted.
 */
export interface ChatRequest {
  readonly system: string;
  readonly user: string;
  readonly schema: object;
  readonly schemaName: string;
}

/**
 * The parsed JSON on success — `unknown`, because validating it against the
 * caller's schema is the caller's job and a cast here would be a lie. `usage`
 * rides along when the server reported one, so a pilot can read real token
 * counts instead of estimating them.
 */
export type ChatOutcome =
  | { readonly ok: true; readonly value: unknown; readonly usage?: unknown }
  | { readonly ok: false; readonly error: string };

/** One generator, named by the id every record it produces is stamped with. */
export interface ChatProvider {
  readonly id: string;
  readonly complete: (req: ChatRequest) => Promise<ChatOutcome>;
}

/** The base URL to call. The env override outranks the default, as a flag would. */
export const resolveChatUrl = (
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const declared = (env[RERANK_URL_ENV_VAR] ?? '').trim();
  return declared.length > 0 ? declared : RERANK_DEFAULT_URL;
};

/** The generator id to call under. The env override outranks the shipped id. */
export const resolveChatModel = (
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const declared = (env[ENRICH_MODEL_ENV_VAR] ?? '').trim();
  return declared.length > 0 ? declared : ENRICH_MODEL_ID;
};

/**
 * Where to generate, and under which id. The model travels WITH the URL because
 * every refusal message names both: a message naming the shipped id while
 * another was requested would send the reader to fix the wrong entry.
 */
interface Endpoint {
  readonly baseUrl: string;
  readonly model: string;
}

const request = (model: string): string =>
  `enrich: generator model "${model}" was requested`;

const requirement = (model: string): string =>
  ` — llama-swap MUST serve a chat model under the id "${model}"; `;

const RESUME =
  ', then re-run `enrich` — the sidecar is append-only, so the run resumes where it stopped.';

/** Server DOWN: the catalogue call itself did not complete. */
const unreachableMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} did not answer GET ${MODELS_PATH} (server down: ${cause})${requirement(endpoint.model)}start llama-swap on that address, or point ${RERANK_URL_ENV_VAR} at the host that serves it${RESUME}`;

/** Server UP, model absent: the catalogue answered and does not list the id. */
const notServedMessage = (endpoint: Endpoint, served: readonly string[]): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} answered GET ${MODELS_PATH} but does not serve it (model not served; it serves: ${served.join(', ') || 'nothing'})${requirement(endpoint.model)}add that model to the llama-swap config under exactly that id, or name a served one with ${ENRICH_MODEL_ENV_VAR}${RESUME}`;

/** The generation call failed after the catalogue passed — still a refusal. */
const callFailedMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} accepted GET ${MODELS_PATH} but the generation call failed (${cause})${requirement(endpoint.model)}check that the id names a CHAT model honouring response_format json_schema (a reranker answers /v1/models but not ${CHAT_PATH})${RESUME}`;

/**
 * An answer that is not JSON is a REFUSAL, never something to salvage. Stated as
 * a named cause so the message reads as a server-contract fault rather than a
 * transport one.
 */
const NOT_JSON = 'the model returned content that is not JSON — response_format was not honoured';

/** An empty answer is the same class of fault: nothing was generated. */
const EMPTY_CONTENT = 'the model returned no content';

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

/**
 * `strict: true` is the whole contract: the server constrains decoding to the
 * schema, so the answer is schema-valid or the call fails — there is no third
 * state to parse prose out of.
 *
 * `temperature` and `seed` are MEASURED, not tuned: at
 * {@link ENRICH_TEMPERATURE} with {@link ENRICH_SEED} and thinking disabled the
 * served model produced BYTE-IDENTICAL output on two consecutive runs. The
 * temperature is Doc2Query++'s, kept for question diversity; the seed is what
 * makes that diversity reproducible.
 *
 * `chat_template_kwargs.enable_thinking: false` is LOAD-BEARING, not a knob —
 * this gguf otherwise emits a reasoning block ahead of the answer, which the
 * strict decoder has no place to put.
 */
const chatBody = (model: string, req: ChatRequest): unknown => ({
  model,
  messages: [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: { name: req.schemaName, strict: true, schema: req.schema },
  },
  temperature: ENRICH_TEMPERATURE,
  seed: ENRICH_SEED,
  max_tokens: ENRICH_MAX_TOKENS,
  chat_template_kwargs: { enable_thinking: false },
});

const firstChoice = (payload: unknown): unknown =>
  isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;

const messageOf = (choice: unknown): unknown => (isRecord(choice) ? choice.message : undefined);

const messageContent = (payload: unknown): string => {
  const message = messageOf(firstChoice(payload));
  return isRecord(message) && typeof message.content === 'string' ? message.content : '';
};

const usageOf = (payload: unknown): unknown => (isRecord(payload) ? payload.usage : undefined);

type ChatResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly cause: string };

const fetchCompletion = async (endpoint: Endpoint, req: ChatRequest): Promise<ChatResult> => {
  try {
    const response = await fetch(`${endpoint.baseUrl}${CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody(endpoint.model, req)),
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
    });
    const text = await response.text();
    return response.ok
      ? { ok: true, payload: JSON.parse(text) }
      : { ok: false, cause: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
};

/** `undefined` for content that is not JSON — the caller turns that into a refusal. */
const parsedContent = (content: string): unknown | undefined => {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
};

const toOutcome = (endpoint: Endpoint, payload: unknown): ChatOutcome => {
  const content = messageContent(payload);
  if (content.trim().length === 0)
    return { ok: false, error: callFailedMessage(endpoint, EMPTY_CONTENT) };
  const value = parsedContent(content);
  return value === undefined
    ? { ok: false, error: callFailedMessage(endpoint, NOT_JSON) }
    : { ok: true, value, usage: usageOf(payload) };
};

const completeAt = async (endpoint: Endpoint, req: ChatRequest): Promise<ChatOutcome> => {
  const refusal = await catalogueRefusal(endpoint);
  if (refusal !== undefined) return { ok: false, error: refusal };
  const completion = await fetchCompletion(endpoint, req);
  return completion.ok
    ? toOutcome(endpoint, completion.payload)
    : { ok: false, error: callFailedMessage(endpoint, completion.cause) };
};

/**
 * The HTTP provider. Both options are omissible and each falls back to the same
 * resolution the CLI has always used, so a caller that states neither reaches
 * the shipped generator on the shipped address.
 */
export const createHttpChatProvider = (
  options: { readonly baseUrl?: string; readonly model?: string } = {}
): ChatProvider => {
  const endpoint: Endpoint = {
    baseUrl: options.baseUrl ?? resolveChatUrl(),
    model: options.model ?? resolveChatModel(),
  };
  return {
    id: endpoint.model,
    complete: async (req: ChatRequest): Promise<ChatOutcome> => await completeAt(endpoint, req),
  };
};
