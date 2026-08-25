/**
 * `src/chat.ts` — the generation provider seam.
 *
 * No live server: `fetch` is stubbed, so both llama-swap calls
 * (`GET /v1/models` and `POST /v1/chat/completions`) are answered in-process.
 *
 * Three properties are asserted hardest, because each one is a silent failure
 * if it slips: the call carries `response_format json_schema strict` (without
 * it the answer is prose and the sidecar fills with paraphrase); the measured
 * sampling cell travels unchanged (0.8 / seed 11 / thinking off is what made
 * two runs byte-identical); and a non-JSON answer REFUSES rather than being
 * salvaged.
 */
import type { ChatRequest } from '../src/chat.js';
import { createHttpChatProvider, resolveChatModel, resolveChatUrl } from '../src/chat.js';
import {
  ENRICH_MAX_TOKENS,
  ENRICH_MODEL_ENV_VAR,
  ENRICH_MODEL_ID,
  ENRICH_SEED,
  ENRICH_TEMPERATURE,
  RERANK_DEFAULT_URL
} from '../src/config.js';

const SCHEMA = { type: 'object', additionalProperties: false, properties: {} };

const REQUEST: ChatRequest = {
  system: 'you are an indexing extractor',
  user: 'PATH: a.md\nTITLE: A\nSECTIONS: (none)\n\nFRAGMENT:\nbody',
  schema: SCHEMA,
  schemaName: 'atom_enrichment',
};

interface Call {
  readonly url: string;
  readonly body: unknown;
}

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const completion = (content: string): unknown => ({
  choices: [{ message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 832, completion_tokens: 400 },
});

/** Answers both endpoints and records every call with its parsed body. */
const stubServer = (models: readonly string[], content: string): Call[] => {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }): Promise<unknown> => {
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return url.endsWith('/v1/models')
      ? okResponse({ data: models.map(id => ({ id })) })
      : okResponse(completion(content));
  });
  return calls;
};

const chatBodyOf = (calls: readonly Call[]): Record<string, unknown> =>
  (calls.find(call => call.url.endsWith('/v1/chat/completions'))?.body ?? {}) as Record<
    string,
    unknown
  >;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('endpoint resolution mirrors the rewriter, deliberately', () => {
  it('falls back to the shipped reranker address when no override is set', () => {
    expect(resolveChatUrl({})).toBe(RERANK_DEFAULT_URL);
  });

  it('lets the env override outrank the default, as a flag would', () => {
    expect(resolveChatUrl({ DP_GNOSIS_RERANK_URL: 'http://elsewhere:1234' })).toBe(
      'http://elsewhere:1234'
    );
  });

  it('defaults to the shipped generator id', () => {
    expect(resolveChatModel({})).toBe(ENRICH_MODEL_ID);
  });

  it('honours the generator env override', () => {
    expect(resolveChatModel({ [ENRICH_MODEL_ENV_VAR]: 'other-model' })).toBe('other-model');
  });
});

describe('the strict-schema contract travels on every call', () => {
  it('carries response_format json_schema with strict true and the caller schema', async () => {
    const calls = stubServer(['gen'], '{"short":"s"}');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(outcome.ok).toBe(true);
    expect(chatBodyOf(calls).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'atom_enrichment', strict: true, schema: SCHEMA },
    });
  });

  it('carries the MEASURED sampling cell — 0.8, seed 11, thinking disabled', async () => {
    const calls = stubServer(['gen'], '{"short":"s"}');
    await createHttpChatProvider({ baseUrl: 'http://stub', model: 'gen' }).complete(REQUEST);
    const body = chatBodyOf(calls);
    expect(body.temperature).toBe(ENRICH_TEMPERATURE);
    expect(body.seed).toBe(ENRICH_SEED);
    expect(body.max_tokens).toBe(ENRICH_MAX_TOKENS);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('sends the system and user messages verbatim, in that order', async () => {
    const calls = stubServer(['gen'], '{"short":"s"}');
    await createHttpChatProvider({ baseUrl: 'http://stub', model: 'gen' }).complete(REQUEST);
    expect(chatBodyOf(calls).messages).toEqual([
      { role: 'system', content: REQUEST.system },
      { role: 'user', content: REQUEST.user },
    ]);
  });

  it('checks the catalogue BEFORE the generation call', async () => {
    const calls = stubServer(['gen'], '{"short":"s"}');
    await createHttpChatProvider({ baseUrl: 'http://stub', model: 'gen' }).complete(REQUEST);
    expect(calls.map(call => call.url)).toEqual([
      'http://stub/v1/models',
      'http://stub/v1/chat/completions',
    ]);
  });
});

describe('a served model answers with parsed JSON and its usage', () => {
  it('returns the parsed object, never the raw string', async () => {
    stubServer(['gen'], '{"short":"one line","keywords":["a","b"]}');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(outcome).toMatchObject({
      ok: true,
      value: { short: 'one line', keywords: ['a', 'b'] },
    });
  });

  it('carries the server usage through, so a pilot reads real token counts', async () => {
    stubServer(['gen'], '{"short":"s"}');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(outcome.ok && outcome.usage).toEqual({ prompt_tokens: 832, completion_tokens: 400 });
  });

  it('names the model it was constructed with, so a record is stamped with it', () => {
    expect(createHttpChatProvider({ baseUrl: 'http://stub', model: 'gen' }).id).toBe('gen');
  });
});

describe('every refusal names its own correction', () => {
  it('refuses a model the catalogue does not serve, listing what it does', async () => {
    stubServer(['someone-else'], '{"short":"s"}');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('model not served');
    expect(!outcome.ok && outcome.error).toContain('someone-else');
  });

  it('refuses an unreachable server as SERVER DOWN, a different fault', async () => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new Error('connect ECONNREFUSED');
    });
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.error).toContain('server down');
    expect(!outcome.ok && outcome.error).toContain('ECONNREFUSED');
  });

  it('REFUSES content that is not JSON — it never salvages prose', async () => {
    stubServer(['gen'], 'Sure! Here is the summary of the fragment.');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('response_format was not honoured');
  });

  it('refuses empty content rather than reporting an empty record', async () => {
    stubServer(['gen'], '   ');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.error).toContain('returned no content');
  });

  it('says the sidecar resumes, so a caller knows the run is not lost', async () => {
    stubServer(['someone-else'], '{}');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.error).toContain('append-only');
  });
});

describe('a refusal states its CLASS, so a caller retries only what a retry can fix', () => {
  it('classes content that is not JSON as a DECODE failure', async () => {
    stubServer(['gen'], 'Sure! Here is the summary of the fragment.');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.kind).toBe('decode');
  });

  it('classes empty content as a DECODE failure — nothing decoded', async () => {
    stubServer(['gen'], '   ');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.kind).toBe('decode');
  });

  it('classes an unreachable server as TRANSPORT — no seed fixes an outage', async () => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new Error('connect ECONNREFUSED');
    });
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.kind).toBe('transport');
  });

  it('classes a model the catalogue does not serve as TRANSPORT', async () => {
    stubServer(['someone-else'], '{"short":"s"}');
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.kind).toBe('transport');
  });

  it('classes an HTTP error on the generation call as TRANSPORT', async () => {
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> =>
      url.endsWith('/v1/models')
        ? okResponse({ data: [{ id: 'gen' }] })
        : { ok: false, status: 500, text: async (): Promise<string> => 'boom' }
    );
    const outcome = await createHttpChatProvider({
      baseUrl: 'http://stub',
      model: 'gen',
    }).complete(REQUEST);
    expect(!outcome.ok && outcome.kind).toBe('transport');
    expect(!outcome.ok && outcome.error).toContain('HTTP 500');
  });
});

describe('the seed travels WITH the request, so a caller can bump it', () => {
  it('sends the stated seed instead of the shipped one', async () => {
    const calls = stubServer(['gen'], '{"short":"s"}');
    await createHttpChatProvider({ baseUrl: 'http://stub', model: 'gen' }).complete({
      ...REQUEST,
      seed: ENRICH_SEED + 2,
    });
    expect(chatBodyOf(calls).seed).toBe(ENRICH_SEED + 2);
  });

  it('falls back to the shipped seed when the request states none', async () => {
    const calls = stubServer(['gen'], '{"short":"s"}');
    await createHttpChatProvider({ baseUrl: 'http://stub', model: 'gen' }).complete(REQUEST);
    expect(chatBodyOf(calls).seed).toBe(ENRICH_SEED);
  });
});
