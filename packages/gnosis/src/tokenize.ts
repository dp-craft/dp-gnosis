/**
 * Real-token counting against the model llama-swap is already serving.
 *
 * Why HTTP rather than a bundled tokenizer: the only count that binds is the
 * one the SERVED model produces, and a bundled vocabulary drifts from it the
 * moment the served model changes. Verified live 2026-08-19 (ADR-037):
 * `POST <baseUrl>/upstream/<model>/tokenize` with `{"content":"..."}` answers
 * `200 {"tokens":[...]}`. The root route `POST /tokenize` is **404** — the
 * `/upstream/<model>/` prefix is required and is not optional decoration.
 *
 * Every failure is DATA here: a non-200, a body that is not the documented
 * shape, and a dead socket each come back as `{ ok: false, reason }` with the
 * reason naming the condition. Nothing throws, and nothing falls back to the
 * byte estimator — a silent fallback would report a byte bound as a token count.
 */

import { TOKENIZE_MODEL_ID } from './config.js';
import { resolveRerankUrl } from './rerank.js';

/** A count, or the named reason there is none. */
export type TokenCountResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: string };

/** The `fetch` surface this module uses, so a test supplies its own. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the counter needs to reach a served model. */
export interface TokenCounterOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: FetchLike;
}

/** A probed counter: `probe` proves the route answers, `count` measures text. */
export interface TokenCounter {
  /** The endpoint every call goes to, quoted verbatim by every refusal. */
  readonly url: string;
  /** One cheap round trip that proves the route exists before a run depends on it. */
  readonly probe: () => Promise<TokenCountResult>;
  readonly count: (text: string) => Promise<TokenCountResult>;
}

/** The one shortest text a probe can ask about; its count is never used. */
const PROBE_TEXT = 'probe';

/** The full route, prefix included — the piece whose omission returns 404. */
export const tokenizeUrl = (baseUrl: string, model: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/upstream/${model}/tokenize`;

/** The documented success body: `{ tokens: [...] }`, and nothing else counts. */
const countOfBody = (body: unknown): number | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const tokens = (body as { readonly tokens?: unknown }).tokens;
  return Array.isArray(tokens) ? tokens.length : undefined;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readCount = async (response: Response, url: string): Promise<TokenCountResult> => {
  if (!response.ok) {
    return { ok: false, reason: `${url} answered HTTP ${response.status}` };
  }
  const body: unknown = await response.json();
  const count = countOfBody(body);
  return count === undefined
    ? { ok: false, reason: `${url} answered without a "tokens" array` }
    : { ok: true, count };
};

const post = async (
  fetchImpl: FetchLike,
  url: string,
  text: string
): Promise<TokenCountResult> => {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    return await readCount(response, url);
  } catch (error: unknown) {
    return { ok: false, reason: `${url} is unreachable — ${errorText(error)}` };
  }
};

/**
 * A counter bound to one endpoint. Counting is one call per text and is left
 * SEQUENTIAL by the caller: a retrieve budgets at most ~100 atoms, and a
 * parallel burst against a single-slot llama-swap buys nothing.
 */
const resolveUrl = (options: TokenCounterOptions): string =>
  tokenizeUrl(options.baseUrl ?? resolveRerankUrl(), options.model ?? TOKENIZE_MODEL_ID);

export const createTokenCounter = (options: TokenCounterOptions = {}): TokenCounter => {
  const url = resolveUrl(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    url,
    probe: async () => await post(fetchImpl, url, PROBE_TEXT),
    count: async (text: string) => await post(fetchImpl, url, text),
  };
};
