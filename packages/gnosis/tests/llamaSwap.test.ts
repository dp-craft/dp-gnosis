/**
 * The ONE llama-swap client, and the five hops that ride it.
 *
 * Two things are locked here.
 *
 * THE REFUSAL WORDING, BYTE FOR BYTE. `chat`, `rephrase`, `synthesize`, `embed`
 * and `rerank` each word their own "server down" and "model not served" message,
 * and only the transport underneath them is shared. These pins capture the exact
 * literal each hop emits TODAY, so a refactor that re-wires the two builders —
 * or swaps one for the other — fails here instead of silently sending a reader
 * to fix the wrong entry.
 *
 * THE TIMEOUT POLICY (owner decision D6, 2026-08-31). Every catalogue GET is
 * bounded at `CATALOGUE_TIMEOUT_MS`; a serving call is UNBOUNDED against a
 * loopback host and floored at `NON_LOOPBACK_TIMEOUT_FLOOR_MS` against any
 * other. No live server is required: `fetch` is stubbed and its `init` inspected.
 */
import { createHttpChatProvider } from '../src/chat.js';
import { CATALOGUE_TIMEOUT_MS, NON_LOOPBACK_TIMEOUT_FLOOR_MS } from '../src/config.js';
import { embedTexts } from '../src/embed.js';
import { servingTimeoutMs } from '../src/llamaSwap.js';
import { rephraseQuery } from '../src/rephrase.js';
import { rerankAtoms } from '../src/rerank.js';
import { synthesizeAnswer } from '../src/synthesize.js';

const URL_BASE = 'http://127.0.0.1:9292';
const MODEL = 'pin-model';
const OTHER = 'some-reranker';

/** A query with no exact rare term, so `rephrase` actually reaches the server. */
const RAW_QUERY = 'zestful retrieval';

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const failResponse = (status: number, body: string): unknown => ({
  ok: false,
  status,
  text: async (): Promise<string> => body,
});

const stubFetch = (handler: (url: string, init: RequestInit | undefined) => unknown): Call[] => {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
};

/** Server DOWN — the catalogue call itself does not complete. */
const stubDown = (): Call[] =>
  stubFetch(() => {
    throw new TypeError('fetch failed');
  });

/** Server UP, serving exactly `models`; every other path answers HTTP 500. */
const stubServing = (models: readonly string[]): Call[] =>
  stubFetch(url =>
    url.endsWith('/v1/models')
      ? okResponse({ data: models.map(id => ({ id })) })
      : failResponse(500, 'boom')
  );

const CHAT_REQUEST = {
  system: 'system',
  user: 'user',
  schema: { type: 'object' },
  schemaName: 'pin',
} as const;

/** Each hop reduced to one call that returns its refusal message, or ''. */
const HOPS = {
  rephrase: async (): Promise<string> => {
    const outcome = await rephraseQuery(RAW_QUERY, { baseUrl: URL_BASE, model: MODEL });
    return outcome.ok ? '' : outcome.error;
  },
  synthesize: async (): Promise<string> => {
    const outcome = await synthesizeAnswer('q', 'pack', { baseUrl: URL_BASE, model: MODEL });
    return outcome.ok ? '' : outcome.error;
  },
  chat: async (): Promise<string> => {
    const provider = createHttpChatProvider({ baseUrl: URL_BASE, model: MODEL });
    const outcome = await provider.complete(CHAT_REQUEST);
    return outcome.ok ? '' : outcome.error;
  },
  embed: async (): Promise<string> => {
    const outcome = await embedTexts(['text'], { baseUrl: URL_BASE, model: MODEL });
    return outcome.ok ? '' : outcome.error;
  },
  rerank: async (): Promise<string> => {
    const outcome = await rerankAtoms('q', [], {
      baseUrl: URL_BASE,
      model: MODEL,
      backend: 'http',
    });
    return outcome.ok ? '' : outcome.error;
  },
} as const;

type HopName = keyof typeof HOPS;

const HOP_NAMES: readonly HopName[] = ['rephrase', 'synthesize', 'chat', 'embed', 'rerank'];

const UNREACHABLE: Readonly<Record<HopName, string>> = {
  rephrase:
    'search --rephrase: rewriter model "pin-model" was requested; the server at http://127.0.0.1:9292 did not answer GET /v1/models (server down: fetch failed) — llama-swap MUST serve a chat model under the id "pin-model"; start llama-swap on that address, or point DP_GNOSIS_RERANK_URL at the host that serves it, then re-run, or drop --rephrase to retrieve with the query as typed.',
  synthesize:
    'ask --synthesize: synthesiser model "pin-model" was requested; the server at http://127.0.0.1:9292 did not answer GET /v1/models (server down: fetch failed) — llama-swap MUST serve a chat model under the id "pin-model"; start llama-swap on that address, or point DP_GNOSIS_RERANK_URL at the host that serves it, then re-run, or drop --synthesize to take the knowledge pack alone.',
  chat:
    'enrich: generator model "pin-model" was requested; the server at http://127.0.0.1:9292 did not answer GET /v1/models (server down: fetch failed) — llama-swap MUST serve a chat model under the id "pin-model"; start llama-swap on that address, or point DP_GNOSIS_RERANK_URL at the host that serves it, then re-run `enrich` — the sidecar is append-only, so the run resumes where it stopped.',
  embed:
    'embed: embedding model "pin-model" was requested; the server at http://127.0.0.1:9292 did not answer GET /v1/models (server down: fetch failed) — llama-swap MUST serve an embedding model under the id "pin-model"; start llama-swap on that address, or point DP_GNOSIS_EMBED_URL at the host that serves it, then re-run.',
  rerank:
    'search --rerank: reranker model "pin-model" was requested; the server at http://127.0.0.1:9292 did not answer GET /v1/models (server down: fetch failed) — llama-swap MUST serve a reranker under the id "pin-model"; start llama-swap on that address, or point DP_GNOSIS_RERANK_URL at the host that serves it, then re-run, or drop --rerank to retrieve without reranking.',
};

const NOT_SERVED: Readonly<Record<HopName, string>> = {
  rephrase:
    'search --rephrase: rewriter model "pin-model" was requested; the server at http://127.0.0.1:9292 answered GET /v1/models but does not serve it (model not served; it serves: some-reranker) — llama-swap MUST serve a chat model under the id "pin-model"; add that model to the llama-swap config under exactly that id, or name a served one with DP_GNOSIS_LLM_MODEL, then re-run, or drop --rephrase to retrieve with the query as typed.',
  synthesize:
    'ask --synthesize: synthesiser model "pin-model" was requested; the server at http://127.0.0.1:9292 answered GET /v1/models but does not serve it (model not served; it serves: some-reranker) — llama-swap MUST serve a chat model under the id "pin-model"; add that model to the llama-swap config under exactly that id, or name a served one with DP_GNOSIS_SYNTHESIZE_MODEL, then re-run, or drop --synthesize to take the knowledge pack alone.',
  chat:
    'enrich: generator model "pin-model" was requested; the server at http://127.0.0.1:9292 answered GET /v1/models but does not serve it (model not served; it serves: some-reranker) — llama-swap MUST serve a chat model under the id "pin-model"; add that model to the llama-swap config under exactly that id, or name a served one with DP_GNOSIS_ENRICH_MODEL, then re-run `enrich` — the sidecar is append-only, so the run resumes where it stopped.',
  embed:
    'embed: embedding model "pin-model" was requested; the server at http://127.0.0.1:9292 answered GET /v1/models but does not serve it (model not served; it serves: some-reranker) — llama-swap MUST serve an embedding model under the id "pin-model"; add that model to the llama-swap config under exactly that id, then re-run.',
  rerank:
    'search --rerank: reranker model "pin-model" was requested; the server at http://127.0.0.1:9292 answered GET /v1/models but does not serve it (model not served; it serves: some-reranker) — llama-swap MUST serve a reranker under the id "pin-model"; add that model to the llama-swap config under exactly that id, then re-run, or drop --rerank to retrieve without reranking.',
};

/** The POST failed AFTER the catalogue passed — the third, distinct message. */
const CALL_FAILED: Readonly<Record<'rephrase' | 'synthesize' | 'chat' | 'embed', string>> = {
  rephrase:
    'search --rephrase: rewriter model "pin-model" was requested; the server at http://127.0.0.1:9292 accepted GET /v1/models but the rewrite call failed (HTTP 500) — llama-swap MUST serve a chat model under the id "pin-model"; check that the id names a CHAT model (a reranker answers /v1/models but not /v1/chat/completions), then re-run, or drop --rephrase to retrieve with the query as typed.',
  synthesize:
    'ask --synthesize: synthesiser model "pin-model" was requested; the server at http://127.0.0.1:9292 accepted GET /v1/models but the synthesis call failed (HTTP 500) — llama-swap MUST serve a chat model under the id "pin-model"; check that the id names a CHAT model (a reranker answers /v1/models but not /v1/chat/completions), then re-run, or drop --synthesize to take the knowledge pack alone.',
  chat:
    'enrich: generator model "pin-model" was requested; the server at http://127.0.0.1:9292 accepted GET /v1/models but the generation call failed (HTTP 500) — llama-swap MUST serve a chat model under the id "pin-model"; check that the id names a CHAT model honouring response_format json_schema (a reranker answers /v1/models but not /v1/chat/completions), then re-run `enrich` — the sidecar is append-only, so the run resumes where it stopped.',
  embed:
    'embed: embedding model "pin-model" was requested; the server at http://127.0.0.1:9292 accepted GET /v1/models but the embedding call failed (HTTP 500: boom) — llama-swap MUST serve an embedding model under the id "pin-model"; check that the id names an EMBEDDING model, then re-run.',
};

describe('the refusal wording each hop owns', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(HOP_NAMES)('%s words "server down" exactly as it does today', async hop => {
    stubDown();
    expect(await HOPS[hop]()).toBe(UNREACHABLE[hop]);
  });

  it.each(HOP_NAMES)('%s words "model not served" exactly as it does today', async hop => {
    stubServing([OTHER]);
    expect(await HOPS[hop]()).toBe(NOT_SERVED[hop]);
  });

  it.each(['rephrase', 'synthesize', 'chat', 'embed'] as const)(
    '%s words a failed call after a passing catalogue exactly as it does today',
    async hop => {
      stubServing([MODEL]);
      expect(await HOPS[hop]()).toBe(CALL_FAILED[hop]);
    }
  );
});

describe('servingTimeoutMs — owner decision D6, 2026-08-31', () => {
  it.each([
    'http://127.0.0.1:9292',
    'http://localhost:9292',
    'http://[::1]:9292',
    'http://LOCALHOST:9292',
  ])('leaves a serving call to %s UNBOUNDED', baseUrl => {
    expect(servingTimeoutMs(baseUrl, 60000)).toBeUndefined();
  });

  it('floors a non-loopback host at the two-minute floor', () => {
    expect(servingTimeoutMs('http://10.255.255.1:9292', 60000)).toBe(NON_LOOPBACK_TIMEOUT_FLOOR_MS);
  });

  it('keeps a hop ceiling that already exceeds the floor', () => {
    expect(servingTimeoutMs('http://example.invalid:9292', 600_000)).toBe(600_000);
  });

  it('bounds an unparseable URL rather than waiting forever on it', () => {
    expect(servingTimeoutMs('not a url', 60000)).toBe(NON_LOOPBACK_TIMEOUT_FLOOR_MS);
  });
});

describe('the catalogue GET is bounded in every hop — owner decision D6, 2026-08-31', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(HOP_NAMES)('%s carries an AbortSignal on GET /v1/models', async hop => {
    const calls = stubDown();
    await HOPS[hop]();
    const catalogue = calls.find(call => call.url.endsWith('/v1/models'));

    expect(catalogue).toBeDefined();
    expect(catalogue?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds the SERVING-path catalogue check too, which used to pass none', async () => {
    const calls = stubDown();
    await HOPS.rerank();

    expect(calls[0]?.url).toBe(`${URL_BASE}/v1/models`);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('states the ceiling as five seconds', () => {
    expect(CATALOGUE_TIMEOUT_MS).toBe(5000);
  });
});
