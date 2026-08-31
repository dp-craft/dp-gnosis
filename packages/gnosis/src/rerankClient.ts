/**
 * The `/v1/rerank` WIRE CLIENT — one client, one wire format, shared by the
 * serving path (`rerank.ts`) and the benchmark (`bench/reranker.ts`).
 *
 * WHY it lives at the engine root: the sharing was always right — two clients
 * would be two request shapes, two chunking rules and two ways to read a
 * `relevance_score` — but the DIRECTION was wrong. `rerank.ts` used to import it
 * from `bench/`, so the served ranking depended on a directory whose name
 * declares it measurement infrastructure, and a bench-motivated edit could
 * silently alter what a user is served. The dependency now runs engine → bench
 * and never the reverse: `bench/reranker.ts` re-exports from here.
 *
 * ONE OWNER: the request body, the oversize refusal, the context-overflow
 * bisect and the document extraction are defined here and nowhere else. What
 * the reranker is SHOWN (`extractDoc`) belongs with the client that sends it —
 * the text and the wire call are one treatment, and the bench stamps them as
 * one.
 *
 * The nDCG metric and the model catalogue stay in `bench/reranker.ts`: they are
 * measurement, not serving, and nothing on the served path reads them.
 */

import { estimateTokens } from './budget.js';

/** One reranker result: original document index and its relevance score. */
export interface RerankResult {
  readonly index: number;
  readonly relevanceScore: number;
}

/** Document extraction strategy for context management. */
export type ExtractStrategy = 'head' | 'tail' | 'headtail' | 'maxfit' | 'full';

/** Strip lone UTF-16 surrogates that break JSON serialization — removes both halves of broken pairs. */
const sanitizeText = (text: string): string => text.replace(/[\uD800-\uDFFF]/g, '');

/**
 * Extract text from a document snippet according to a strategy.
 * - head: first N characters
 * - tail: last N characters
 * - headtail: first N/2 + last N/2 with ellipsis separator
 * - maxfit: first N characters (same as head, semantically means "max that fits")
 * - full: no truncation
 */
export const extractDoc = (
  snippet: string,
  strategy: ExtractStrategy,
  maxChars: number
): string => {
  if (strategy === 'full') return sanitizeText(snippet);
  if (snippet.length <= maxChars) return sanitizeText(snippet);
  switch (strategy) {
    case 'head':
    case 'maxfit':
      return sanitizeText(snippet.slice(0, maxChars));
    case 'tail':
      return sanitizeText(snippet.slice(-maxChars));
    case 'headtail': {
      const half = Math.floor(maxChars / 2);
      return sanitizeText(snippet.slice(0, half) + '\n...\n' + snippet.slice(-half));
    }
    default:
      return sanitizeText(snippet);
  }
};

/**
 * A document cannot fit the reranker context even alone (query + doc > limit).
 *
 * Thrown rather than skipped: a dropped document never reaches the reranker,
 * so the benchmark would silently score fewer atoms than it was handed.
 *
 * A class, not a factory: it is an `Error` subclass, and `instanceof` is what
 * every catch site discriminates it by.
 */
export class RerankOversizeError extends Error {
  readonly documentIndex: number;
  readonly estimatedTokens: number;
  readonly limitTokens: number;

  constructor(documentIndex: number, estimatedTokens: number, limitTokens: number) {
    super(
      `Rerank document ${documentIndex} needs ~${estimatedTokens} tokens with the query, ` +
        `over the ${limitTokens}-token context limit`
    );
    this.name = 'RerankOversizeError';
    this.documentIndex = documentIndex;
    this.estimatedTokens = estimatedTokens;
    this.limitTokens = limitTokens;
  }
}

/** Guard: a document that cannot fit alone MUST fail the run, never be dropped. */
const assertDocumentFits = (index: number, requiredTokens: number, maxTokens: number): void => {
  if (requiredTokens > maxTokens) {
    throw new RerankOversizeError(index, requiredTokens, maxTokens);
  }
};

/**
 * Chunk documents so each batch fits within the reranker's context window.
 * Rerankers have small training contexts (512–8192). The query + all docs
 * must fit in one context, so we split into batches and merge by score.
 */
const chunkDocuments = (
  query: string,
  documents: readonly string[],
  maxTokens: number,
  maxDocs: number = Infinity
): readonly { offset: number; chunk: readonly string[] }[] => {
  const queryTokens = estimateTokens(query);
  const overhead = 10; // special tokens per doc
  const chunks: { offset: number; chunk: string[] }[] = [];
  let currentChunk: string[] = [];
  let currentTokens = queryTokens;
  let offset = 0;

  for (const doc of documents) {
    const docTokens = estimateTokens(doc) + overhead;
    if (currentChunk.length >= maxDocs || (currentChunk.length > 0 && currentTokens + docTokens > maxTokens)) {
      chunks.push({ offset, chunk: currentChunk });
      offset += currentChunk.length;
      currentChunk = [];
      currentTokens = queryTokens;
    }
    // Docs too large to fit even alone (query + doc > maxTokens) are a hard error
    assertDocumentFits(offset + currentChunk.length, queryTokens + docTokens, maxTokens);
    currentChunk.push(doc);
    currentTokens += docTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push({ offset, chunk: currentChunk });
  }

  return chunks;
};

/** The one thing a client does: score `documents` against `query`. */
export type RerankerClient = Readonly<{
  rerank: (query: string, documents: readonly string[]) => Promise<RerankResult[]>;
}>;

/**
 * HTTP reranker client factory — auto-chunks to fit context windows.
 *
 * `timeoutMs` accepts `null` for NO abort at all (owner decision D6,
 * 2026-08-31): a loopback llama-swap loading a model on demand was measured at
 * 1 m 59 s, past the 60 s default, and aborting there kills the very load the
 * call is waiting for. Every existing caller passes a number or omits it, so
 * the default and the bench's recorded measurement config are unchanged.
 */
export const createRerankerClient = (
  baseUrl: string,
  modelId: string,
  timeoutMs: number | null = 60000,
  maxContextTokens: number = 4096,
  maxDocsPerChunk: number = Infinity
): RerankerClient => {
  const singleRerank = async (
    query: string,
    documents: readonly string[],
    baseIndex: number
  ): Promise<RerankResult[]> => {
    const controller = new AbortController();
    const timeout = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/v1/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          query,
          documents: [...documents],
          top_n: documents.length,
        }),
        signal: controller.signal,
      });

      const responseText = await response.text();
      if (!response.ok) {
        // On context overflow, retry with half the docs — a single doc is a hard error
        if (response.status === 400 && responseText.includes('exceed_context_size')) {
          clearTimeout(timeout);
          if (documents.length <= 1) {
            throw new Error(
              `Rerank context overflow on a single document (index ${baseIndex}): ${responseText.slice(0, 300)}`
            );
          }
          const mid = Math.floor(documents.length / 2);
          const left = await singleRerank(query, documents.slice(0, mid), baseIndex);
          const right = await singleRerank(query, documents.slice(mid), baseIndex + mid);
          return [...left, ...right];
        }
        throw new Error(`Rerank HTTP ${response.status}: ${responseText.slice(0, 300)}`);
      }

      const data = JSON.parse(responseText);
      return (data.results as Array<{ index: number; relevance_score: number }>).map(r => ({
        index: baseIndex + r.index,
        relevanceScore: r.relevance_score,
      }));
    } finally {
      clearTimeout(timeout);
    }
  };

  const rerank = async (query: string, documents: readonly string[]): Promise<RerankResult[]> => {
    if (documents.length === 0) return [];

    const chunks = chunkDocuments(query, documents, maxContextTokens, maxDocsPerChunk);

    const [firstChunk] = chunks;
    if (chunks.length === 1 && firstChunk !== undefined) {
      return singleRerank(query, firstChunk.chunk, firstChunk.offset);
    }

    // Multiple chunks: rerank each, merge all results
    const allResults: RerankResult[] = [];
    for (const { offset, chunk } of chunks) {
      const results = await singleRerank(query, chunk, offset);
      allResults.push(...results);
    }
    return allResults;
  };

  return { rerank };
};
