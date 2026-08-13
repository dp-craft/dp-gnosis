/**
 * Oversize handling in the reranker client.
 *
 * Both silent-loss paths (dropped document, halved single document) MUST be
 * hard errors — a benchmark that silently scores less text than it was given
 * reports a number for an experiment that never ran.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRerankerClient, RerankOversizeError } from '../src/bench/reranker.js';

interface StubResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

const respond = (r: StubResponse) => ({
  ok: r.ok,
  status: r.status,
  text: async (): Promise<string> => r.body,
});

const okBody = (scores: readonly number[]): string =>
  JSON.stringify({ results: scores.map((s, i) => ({ index: i, relevance_score: s })) });

const MISSING_STUB: StubResponse = { ok: false, status: 500, body: 'no stub configured' };

const stubFetch = (responses: readonly StubResponse[]) => {
  const fetchMock = vi.fn(async (_url: string, _init: { body: string }): Promise<unknown> => {
    const index = Math.min(fetchMock.mock.calls.length - 1, responses.length - 1);
    return respond(responses[index] ?? MISSING_STUB);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const bodyOf = (fetchMock: ReturnType<typeof stubFetch>, call: number): { documents: string[]; top_n: number } => {
  const args = fetchMock.mock.calls[call];
  return JSON.parse(args ? args[1].body : '{}');
};

describe('reranker oversize handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should throw RerankOversizeError naming index, estimate and limit when a document cannot fit the context', async () => {
    stubFetch([{ ok: true, status: 200, body: okBody([0.5]) }]);
    const client = createRerankerClient('http://x', 'm', 1000, 50);

    const error = await client.rerank('q', ['ok', 'x'.repeat(400)]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankOversizeError);
    const oversize = error as RerankOversizeError;
    expect(oversize.documentIndex).toBe(1);
    expect(oversize.estimatedTokens).toBe(111);
    expect(oversize.limitTokens).toBe(50);
    expect(oversize.message).toContain('1');
    expect(oversize.message).toContain('111');
    expect(oversize.message).toContain('50');
  });

  it('should throw with the server message and not retry when a single document overflows the server context', async () => {
    const fetchMock = stubFetch([{ ok: false, status: 400, body: 'error: exceed_context_size for slot 0' }]);
    const client = createRerankerClient('http://x', 'm', 1000, 4096);

    const error = await client.rerank('q', ['a short doc']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('exceed_context_size');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should still halve the batch and merge results when a multi-document request overflows', async () => {
    const fetchMock = stubFetch([
      { ok: false, status: 400, body: 'exceed_context_size' },
      { ok: true, status: 200, body: okBody([0.9]) },
      { ok: true, status: 200, body: okBody([0.1]) },
    ]);
    const client = createRerankerClient('http://x', 'm', 1000, 4096);

    const results = await client.rerank('q', ['left doc', 'right doc']);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results).toEqual([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.1 },
    ]);
  });

  it('should send exactly the single chunk the batching decision produced', async () => {
    const fetchMock = stubFetch([{ ok: true, status: 200, body: okBody([0.7, 0.3]) }]);
    const client = createRerankerClient('http://x', 'm', 1000, 4096);

    await client.rerank('q', ['doc one', 'doc two']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock, 0).documents).toEqual(['doc one', 'doc two']);
    expect(bodyOf(fetchMock, 0).top_n).toBe(2);
  });
});
