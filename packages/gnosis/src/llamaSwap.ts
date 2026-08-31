/**
 * The ONE llama-swap client. Five hops — `rerank`, `embed`, `chat` (enrich),
 * `rephrase` and `synthesize` — talk to the same OpenAI-compatible server, and
 * this file is the only place that knows how.
 *
 * WHAT LIVES HERE: the paths, the catalogue's wire shape and its parser, the
 * fetch plumbing, and the TIMEOUT POLICY. Nothing else. It was five private
 * copies of the same six declarations, and a fix applied to one of them (the
 * bounded catalogue) reached exactly one.
 *
 * WHAT DOES NOT LIVE HERE: a single word of any refusal. The five hops fail for
 * the same three reasons but they name three different corrections — a
 * `--rephrase` reader is told to drop the flag, an `enrich` reader is told the
 * sidecar resumes — so {@link catalogueRefusal} takes the hop's OWN builders and
 * this file only decides WHICH of them to call. Request bodies are the hop's
 * too: they carry measured decoding parameters, and one shared body would make
 * a change to any hop a change to all of them.
 *
 * It imports `config.ts` and node builtins and NOTHING else in this package —
 * `rerank.ts` imports this file, and the reverse edge would be a cycle.
 */
import { CATALOGUE_TIMEOUT_MS, NON_LOOPBACK_TIMEOUT_FLOOR_MS } from './config.js';

/** The llama-swap model catalogue, per the OpenAI-compatible API. */
export const MODELS_PATH = '/v1/models';

/** The chat endpoint the three generation hops post to. */
export const CHAT_PATH = '/v1/chat/completions';

/**
 * Where to call, and under which id. The model travels WITH the URL because
 * every refusal message names both: a message naming the shipped id while
 * another was requested would send the reader to fix the wrong entry.
 */
export interface Endpoint {
  readonly baseUrl: string;
  readonly model: string;
}

/**
 * What `GET /v1/models` answered: the served ids, or why the call did not
 * complete.
 */
export type Catalogue =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly cause: string };

export const causeOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/** Every `data[].id` the payload states; anything else in it is ignored. */
export const modelIds = (payload: unknown): readonly string[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []
  );
};

/** `undefined` is UNBOUNDED — the key is omitted rather than set to nothing. */
const timeoutInit = (timeoutMs: number | undefined): RequestInit =>
  timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) };

/** The hosts that name THIS machine, so a call to one crosses no network. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Lower-cased, brackets and all (`new URL` keeps them on a v6 literal). */
const hostOf = (baseUrl: string): string | undefined => {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * How long a SERVING call to `baseUrl` may take (owner decision D6,
 * 2026-08-31) — `undefined` for no ceiling at all.
 *
 * LOOPBACK is unbounded: the only thing that makes a local call slow is
 * llama-swap loading the model, and a ceiling there aborts the very work it was
 * waiting for (a measured 1 m 59 s cold load blew the 60 s abort this replaces).
 * Anything else is bounded, because a filtered host never completes its connect
 * — at the hop's own ceiling, or {@link NON_LOOPBACK_TIMEOUT_FLOOR_MS}, whichever
 * is longer.
 *
 * A URL that will not parse is bounded: it cannot be shown to be loopback, and
 * the safe direction for an unknown host is to come back.
 *
 * Pure — no I/O, no clock. It says how long, never whether to call.
 */
export const servingTimeoutMs = (baseUrl: string, hopCeilingMs: number): number | undefined => {
  const host = hostOf(baseUrl);
  return host !== undefined && LOOPBACK_HOSTS.includes(host)
    ? undefined
    : Math.max(hopCeilingMs, NON_LOOPBACK_TIMEOUT_FLOOR_MS);
};

/**
 * The abort half of a serving request's `init`, for a hop that owns its own
 * path and body (`embed` posts to `/v1/embeddings`). Spread, so an unbounded
 * call carries no `signal` KEY rather than an undefined one.
 */
export const servingInit = (baseUrl: string, ceilingMs: number): RequestInit =>
  timeoutInit(servingTimeoutMs(baseUrl, ceilingMs));

/**
 * The catalogue at `baseUrl`, always under {@link CATALOGUE_TIMEOUT_MS}. There
 * is no parameter: a hop that could opt out of the ceiling is exactly the hole
 * D6 closed.
 */
export const fetchCatalogue = async (baseUrl: string): Promise<Catalogue> => {
  try {
    const response = await fetch(`${baseUrl}${MODELS_PATH}`, timeoutInit(CATALOGUE_TIMEOUT_MS));
    const body = await response.text();
    return response.ok
      ? { ok: true, models: modelIds(JSON.parse(body)) }
      : { ok: false, cause: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
};

/**
 * The hop's own wording for the two catalogue faults. They are separate
 * functions because they take opposite corrections — start a server, versus
 * name a model the running one serves — and a hop that worded them alike would
 * send half its readers to the wrong fix.
 */
export interface RefusalMessages {
  readonly unreachable: (endpoint: Endpoint, cause: string) => string;
  readonly notServed: (endpoint: Endpoint, served: readonly string[]) => string;
}

/** `undefined` when the model is served; otherwise the message to refuse with. */
export const catalogueRefusal = async (
  endpoint: Endpoint,
  messages: RefusalMessages
): Promise<string | undefined> => {
  const catalogue = await fetchCatalogue(endpoint.baseUrl);
  if (!catalogue.ok) return messages.unreachable(endpoint, catalogue.cause);
  return catalogue.models.includes(endpoint.model)
    ? undefined
    : messages.notServed(endpoint, catalogue.models);
};

/** The parsed response body, or the cause naming why there is none. */
export type PostOutcome =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly cause: string };

/**
 * One `POST /v1/chat/completions`, carrying the D6 timeout policy for the hop's
 * `ceilingMs`. The BODY is the caller's, serialised untouched: the three
 * generation hops send three different decoding configurations, each of them
 * measured, and none of them may move because another one did.
 */
export const postChat = async (
  endpoint: Endpoint,
  body: unknown,
  ceilingMs: number
): Promise<PostOutcome> => {
  try {
    const response = await fetch(`${endpoint.baseUrl}${CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...servingInit(endpoint.baseUrl, ceilingMs),
    });
    const text = await response.text();
    return response.ok
      ? { ok: true, payload: JSON.parse(text) }
      : { ok: false, cause: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
};

const firstChoice = (payload: unknown): unknown =>
  isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;

const messageOf = (choice: unknown): unknown => (isRecord(choice) ? choice.message : undefined);

/** The `choices[0].message.content` of a chat answer, `''` when there is none. */
export const messageContent = (payload: unknown): string => {
  const message = messageOf(firstChoice(payload));
  return isRecord(message) && typeof message.content === 'string' ? message.content : '';
};
