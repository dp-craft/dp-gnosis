/**
 * The benchmark's rerank half: the nDCG metric and the model catalogue.
 *
 * nDCG measures ranking quality: a reranker that puts relevant docs first
 * scores higher than one that buries them. Unlike recall@k (which only counts
 * hits in the top-k window), nDCG rewards ORDER — a relevant doc at position 1
 * scores more than at position 10.
 *
 * The WIRE CLIENT is no longer here. `src/rerankClient.ts` owns it, and this
 * file re-exports it unchanged so every bench-side importer of this path keeps
 * working. The move inverted the direction: the serving path used to import its
 * client from under `bench/`, which made production depend on measurement
 * infrastructure.
 */

export {
  createRerankerClient,
  extractDoc,
  type ExtractStrategy,
  type RerankerClient,
  RerankOversizeError,
  type RerankResult
} from '../rerankClient.js';

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

/**
 * The reranker models available for benchmarking.
 *
 * `docs/benchmarks/lib/models.sh` (`RR_MODELS`) is the SOURCE OF TRUTH for which
 * model exists, which port serves it and what `-ub` it is served with. Mirror it
 * here on every change: ports are its `port` field, and `maxBatchTokens` for an
 * untuned entry is its `ubatch` field. `zerank-2` is absent because models.sh
 * removed it on 2026-08-11 — its GGUF carries no rank head, so every document
 * scored 0.0. `bge-reranker-large` is absent because models.sh removed it on
 * 2026-08-13 — P7-5 measured it both worse and slower than `bge-reranker-v2-m3`
 * (nDCG@10 0.4712 @ p50 2144 ms vs 0.4938 @ 2017 ms), so it can never be the
 * right pick. The per-model `maxBatchTokens` / `maxDocsPerChunk` below that sit
 * under `ubatch` are measured client-side chunking limits; keep them.
 */
export const DEFAULT_RERANKERS: readonly RerankerModelConfig[] = [
  { name: 'bge-reranker-v2-m3', baseUrl: 'http://127.0.0.1:11104', modelId: 'bge-reranker-v2-m3', maxBatchTokens: 8000 },
  { name: 'bge-reranker-base', baseUrl: 'http://127.0.0.1:11101', modelId: 'bge-reranker-base', maxBatchTokens: 400, maxDocsPerChunk: 2 },
  { name: 'jina-reranker-v2-base-multilingual', baseUrl: 'http://127.0.0.1:11103', modelId: 'jina-reranker-v2-base-multilingual', maxBatchTokens: 800 },
  { name: 'qwen3-06b', baseUrl: 'http://127.0.0.1:11105', modelId: 'qwen3-06b', maxBatchTokens: 8192 },
  { name: 'qwen3-4b', baseUrl: 'http://127.0.0.1:11106', modelId: 'qwen3-4b', maxBatchTokens: 8192 },
];
