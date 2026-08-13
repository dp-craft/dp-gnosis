/**
 * Reranker HTTP client and nDCG metric.
 *
 * nDCG measures ranking quality: a reranker that puts relevant docs first
 * scores higher than one that buries them. Unlike recall@k (which only counts
 * hits in the top-k window), nDCG rewards ORDER — a relevant doc at position 1
 * scores more than at position 10.
 *
 * The HTTP client wraps llama-server's `POST /v1/rerank` endpoint. Each
 * reranker model runs on its own port; the client is parameterized by base URL.
 */

import { estimateTokens } from '../budget.js';

/** One reranker result: original document index and its relevance score. */
export interface RerankResult {
  readonly index: number;
  readonly relevanceScore: number;
}

/** Reranker model configuration. */
export interface RerankerModelConfig {
  readonly name: string;
  readonly baseUrl: string;
  readonly modelId: string;
  /** Max tokens per batch for chunking — bounded by llama-server's -b (batch size). */
  readonly maxBatchTokens?: number;
  /** Hard cap on docs per chunk — prevents tokenizer estimation errors from overflowing context. */
  readonly maxDocsPerChunk?: number;
}

/**
 * nDCG@k: normalized discounted cumulative gain.
 *
 * Binary relevance (1 / 0). The discount is log2(rank) where rank is 1-based,
 * so position 1 has no discount, position 2 is halved, etc. Normalized against
 * the ideal ranking (all relevant docs first) so the score is bounded [0, 1].
 */
export const ndcgAtK = (
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  k: number
): number => {
  if (relevantIds.length === 0) return 0;

  const relevant = new Set(relevantIds);
  const cutoff = Math.min(k, retrievedIds.length);

  // Binary relevance: 1 if relevant, 0 otherwise
  const rels: number[] = retrievedIds.slice(0, cutoff).map(id => relevant.has(id) ? 1 : 0);

  // DCG@k: relevance discounted by log2(position), position is 1-based
  const dcg = rels.reduce((sum, rel, i) => {
    return sum + (rel / Math.log2(i + 2)); // i+2: 0-based index → 1-based position, +1 for log offset
  }, 0);

  // Ideal DCG: all relevant docs first
  const idealRels = [...rels].sort((a, b) => b - a);
  const idcg = idealRels.reduce((sum, rel, i) => {
    return sum + (rel / Math.log2(i + 2));
  }, 0);

  return idcg === 0 ? 0 : dcg / idcg;
};

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
export function extractDoc(
  snippet: string,
  strategy: ExtractStrategy,
  maxChars: number
): string {
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
}

/**
 * A document cannot fit the reranker context even alone (query + doc > limit).
 *
 * Thrown rather than skipped: a dropped document never reaches the reranker,
 * so the benchmark would silently score fewer atoms than it was handed.
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

/** HTTP reranker client factory — auto-chunks to fit context windows. */
export const createRerankerClient = (
  baseUrl: string,
  modelId: string,
  timeoutMs: number = 60000,
  maxContextTokens: number = 4096,
  maxDocsPerChunk: number = Infinity
) => {
  const singleRerank = async (
    query: string,
    documents: readonly string[],
    baseIndex: number
  ): Promise<RerankResult[]> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

/** The reranker models available for benchmarking. */
export const DEFAULT_RERANKERS: readonly RerankerModelConfig[] = [
  { name: 'bge-reranker-v2-m3', baseUrl: 'http://127.0.0.1:11001', modelId: 'bge-reranker-v2-m3', maxBatchTokens: 8000 },
  { name: 'bge-reranker-large', baseUrl: 'http://127.0.0.1:11002', modelId: 'bge-reranker-large', maxBatchTokens: 400, maxDocsPerChunk: 2 },
  { name: 'bge-reranker-base', baseUrl: 'http://127.0.0.1:11003', modelId: 'bge-reranker-base', maxBatchTokens: 400, maxDocsPerChunk: 2 },
  { name: 'jina-reranker-v2-base-multilingual', baseUrl: 'http://127.0.0.1:11004', modelId: 'jina-reranker-v2-base-multilingual', maxBatchTokens: 800 },
  { name: 'zerank-2', baseUrl: 'http://127.0.0.1:11005', modelId: 'zerank-2', maxBatchTokens: 8000, maxDocsPerChunk: 10 },
];
