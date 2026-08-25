/**
 * WHAT the reranker is shown — the doc window and the extraction strategy.
 *
 * Both were fixed constants baked into the one `extractDoc` call, so a width arm
 * could not be measured at all. They are now `RerankOptions` fields, and the
 * assertions below pin the two properties that matter: an UNSET call sends the
 * byte-identical text every recorded run was scored on, and a SET call sends the
 * window it named. A default that drifted would re-base every recorded row
 * without a provenance change, which is the failure class handbook/GNOSIS-GUIDE.md
 * § Landmines is built around.
 *
 * No live server: `fetch` is stubbed, and the documents the client posted are
 * captured verbatim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RERANK_DOC_MAX_CHARS, RERANK_FUSION_PRESETS, RERANK_MODEL_ID } from '../src/config.js';
import type { RetrievedAtom } from '../src/port.js';
import { EXTRACT_STRATEGY, rerankAtoms, type RerankOptions } from '../src/rerank.js';

/** Long enough that every window under test truncates it, and position-readable. */
const BODY_CHARS = 12000;

const BODY = Array.from({ length: BODY_CHARS }, (_, index) => String(index % 10)).join('');

const atom = (id: string): RetrievedAtom => ({
  id,
  title: id,
  domain: 'docs',
  type: 'knowledge',
  body: BODY,
  score: 1,
  sourcePath: `atoms/${id}.md`,
  originPaths: [`doc/${id}.md`],
});

const ATOMS: readonly RetrievedAtom[] = [atom('a'), atom('b')];

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

/** Every document text posted to `/v1/rerank`, in request order. */
const posted: string[] = [];

const stubServer = (): void => {
  posted.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
    if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
    const request = JSON.parse(String(init?.body ?? '{}')) as { documents?: string[] };
    posted.push(...(request.documents ?? []));
    return okResponse({ results: (request.documents ?? []).map((_, index) => ({ index, relevance_score: 1 - index })) });
  });
};

const sentDocuments = async (options: RerankOptions): Promise<readonly string[]> => {
  stubServer();
  const outcome = await rerankAtoms('zestful retrieval', ATOMS, {
    fusion: RERANK_FUSION_PRESETS.shipped,
    ...options,
  });
  expect(outcome.ok).toBe(true);
  return [...posted];
};

describe('the reranker doc window', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the shipped constants, so an unset call is bit-identical', async () => {
    const documents = await sentDocuments({});

    expect(EXTRACT_STRATEGY).toBe('head');
    expect(RERANK_DOC_MAX_CHARS).toBe(2000);
    expect(documents).toHaveLength(ATOMS.length);
    expect(documents[0]).toBe(BODY.slice(0, RERANK_DOC_MAX_CHARS));
  });

  it('sends the WIDTH a caller names, not the constant', async () => {
    const documents = await sentDocuments({ rerankDocMaxChars: 4000 });

    expect(documents[0]).toBe(BODY.slice(0, 4000));
  });

  it('sends the EXTRACTION a caller names, head and tail around an ellipsis', async () => {
    const documents = await sentDocuments({ rerankExtract: 'headtail' });

    const half = RERANK_DOC_MAX_CHARS / 2;
    expect(documents[0]).toBe(`${BODY.slice(0, half)}\n...\n${BODY.slice(-half)}`);
  });

  it('combines the two, so a width arm can vary both at once', async () => {
    const documents = await sentDocuments({ rerankDocMaxChars: 4000, rerankExtract: 'headtail' });

    expect(documents[0]).toBe(`${BODY.slice(0, 2000)}\n...\n${BODY.slice(-2000)}`);
  });
});
