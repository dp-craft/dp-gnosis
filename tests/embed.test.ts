/**
 * The embedding client and its sidecar cache — the dense leg's only network hop.
 *
 * No live server is required: `fetch` is stubbed, so both llama-swap calls
 * (`GET /v1/models` and `POST /v1/embeddings`) are answered in-process. The two
 * things under test are the ones that fail SILENTLY in production if wrong: the
 * text put on the wire must be the RAW body (a stemmed body embeds without
 * error and simply underperforms), and every fault must REFUSE rather than
 * yield a zero / random / dropped vector.
 */
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EMBED_MODEL_ID } from '../src/config.js';
import { embedTexts } from '../src/embed.js';
import {
  createEmbeddingCache,
  embeddingCacheDir,
  embeddingCacheKey
} from '../src/embedCache.js';

const RAW_TEXTS = [
  'The Zestful Retrieval of a Document, and How BM25 Ranks It',
  'Chocolate cake: cream the butter with the sugar.',
] as const;

interface Call {
  readonly url: string;
  readonly body: unknown;
}

interface EmbeddingEntry {
  readonly index: number;
  readonly embedding: readonly number[];
}

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const inputOf = (body: unknown): readonly string[] =>
  (body as { readonly input: readonly string[] }).input;

/** One deterministic vector per input position, so a swap is visible. */
const vectorFor = (position: number): readonly number[] => [position, position + 0.5];

/** Answers both llama-swap endpoints; `entries` shapes the `data` array. */
const stubServer = (
  models: readonly string[],
  entries: (texts: readonly string[]) => readonly EmbeddingEntry[]
): Call[] => {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
      const body = init?.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ url, body });
      if (url.endsWith('/v1/models')) return okResponse({ data: models.map(id => ({ id })) });
      return okResponse({ data: entries(inputOf(body)) });
    }
  );
  return calls;
};

/** Best case, but returned in REVERSE order — `index` is the only ordering source. */
const reversedEntries = (texts: readonly string[]): readonly EmbeddingEntry[] =>
  texts.map((_text, position) => ({ index: position, embedding: vectorFor(position) })).reverse();

const embedCalls = (calls: readonly Call[]): readonly Call[] =>
  calls.filter(call => call.url.endsWith('/v1/embeddings'));

const cachePath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'gnosis-embed-')), 'atoms.lance');

describe('embedTexts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the RAW text to /v1/embeddings under the configured model id', async () => {
    const calls = stubServer([EMBED_MODEL_ID], reversedEntries);

    const outcome = await embedTexts(RAW_TEXTS);

    expect(outcome.ok).toBe(true);
    const posted = embedCalls(calls)[0];
    expect(posted?.url).toBe('http://127.0.0.1:9292/v1/embeddings');
    expect(posted?.body).toEqual({ model: EMBED_MODEL_ID, input: [...RAW_TEXTS] });
  });

  it('returns vectors in INPUT order even when data comes back out of order', async () => {
    stubServer([EMBED_MODEL_ID], reversedEntries);

    const outcome = await embedTexts(RAW_TEXTS);

    expect(outcome).toEqual({ ok: true, vectors: [vectorFor(0), vectorFor(1)] });
  });

  it('refuses when the server is down, naming the model and the URL', async () => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const outcome = await embedTexts(RAW_TEXTS);

    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? '' : outcome.error;
    expect(error).toContain(`"${EMBED_MODEL_ID}"`);
    expect(error).toContain('http://127.0.0.1:9292');
    expect(error).toContain('server down');
  });

  it('refuses when the server is up but does not serve the model', async () => {
    stubServer(['bge-reranker-v2-m3'], reversedEntries);

    const outcome = await embedTexts(RAW_TEXTS);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error).toContain('bge-reranker-v2-m3');
  });

  it('refuses a response that omits a text rather than dropping the document', async () => {
    stubServer([EMBED_MODEL_ID], texts => reversedEntries(texts).slice(1));

    const outcome = await embedTexts(RAW_TEXTS);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error).toContain('2');
  });
});

describe('the embedding cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keys an entry by sha256 of the RAW body, under the model id', async () => {
    const indexPath = await cachePath();
    const digest = createHash('sha256').update(RAW_TEXTS[0], 'utf8').digest('hex');

    expect(embeddingCacheKey(RAW_TEXTS[0])).toBe(digest);
    expect(embeddingCacheDir(indexPath, EMBED_MODEL_ID)).toBe(
      `${indexPath}.embed-cache/${EMBED_MODEL_ID}`
    );
  });

  it('serves a second call from disk without touching the server', async () => {
    const cache = createEmbeddingCache(await cachePath(), EMBED_MODEL_ID);
    const calls = stubServer([EMBED_MODEL_ID], reversedEntries);

    const first = await embedTexts(RAW_TEXTS, { cache });
    const second = await embedTexts(RAW_TEXTS, { cache });

    expect(second).toEqual(first);
    expect(embedCalls(calls)).toHaveLength(1);
  });

  it('embeds only the texts the cache misses', async () => {
    const cache = createEmbeddingCache(await cachePath(), EMBED_MODEL_ID);
    const calls = stubServer([EMBED_MODEL_ID], reversedEntries);

    await embedTexts([RAW_TEXTS[0]], { cache });
    await embedTexts(RAW_TEXTS, { cache });

    expect(inputOf(embedCalls(calls)[1]?.body)).toEqual([RAW_TEXTS[1]]);
  });

  it('MISSES when the model id changes rather than serving another model vectors', async () => {
    const indexPath = await cachePath();
    const calls = stubServer([EMBED_MODEL_ID, 'other-embed'], reversedEntries);

    await embedTexts(RAW_TEXTS, { cache: createEmbeddingCache(indexPath, EMBED_MODEL_ID) });
    await embedTexts(RAW_TEXTS, {
      cache: createEmbeddingCache(indexPath, 'other-embed'),
      model: 'other-embed',
    });

    expect(embedCalls(calls)).toHaveLength(2);
    expect(inputOf(embedCalls(calls)[1]?.body)).toEqual([...RAW_TEXTS]);
  });

  it('MUST NOT write a cache entry when the call refused', async () => {
    const cache = createEmbeddingCache(await cachePath(), EMBED_MODEL_ID);
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const refused = await embedTexts(RAW_TEXTS, { cache });

    expect(refused.ok).toBe(false);
    expect(await cache.get(RAW_TEXTS[0])).toBeUndefined();
  });
});
