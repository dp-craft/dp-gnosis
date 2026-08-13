/**
 * P7-5: Reranker benchmark — measures reranking quality on top of fts5 first-pass.
 *
 * Flow: fts5 retrieves K_INIT candidates → extracts atom bodies → each reranker
 * reorders via HTTP POST → scores nDCG@10, recall@10, recall@20, MRR per query.
 *
 * Gates on P7-0: only runs if P7-0 showed a significant recall gap. If the
 * first pass already surfaces what it can, a reranker reorders noise.
 *
 * English-only (D-R17). Each reranker model is a SEPARATE measurement epoch.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fts5Candidate } from './bench/candidates.js';
import { type BenchCorpus, materializeRealCorpus } from './bench/corpora.js';
import { mean, recallAtK, reciprocalRank } from './bench/metrics.js';
import {
  createRerankerClient,
  DEFAULT_RERANKERS,
  extractDoc,
  type ExtractStrategy,
  ndcgAtK,
  type RerankerModelConfig,
  type RerankResult
} from './bench/reranker.js';
import { mapSequential } from './bench/sequential.js';
import { ATOM_DOMAINS, type AtomDomain } from './config.js';
import { type GoldenQuery, type GoldenSet, loadVerifiedGoldenSet } from './goldenSet.js';
import { ATOMS_DIR, BENCH_WORK_DIR, REPO_ROOT } from './paths.js';
import type { KnowledgePort, RetrievalResult } from './port.js';

/** First-pass retrieval depth — the candidate pool a reranker reorders. */
const K_INIT = 200;

/** Default max chars per document sent to the reranker. BGE tokenizers are ~1:1 char:token, so 200 chars ≈ 200 tokens. Allows 2 docs + query in a 512-token context. */
const DEFAULT_DOC_MAX_CHARS = 200;

/** Models excluded by D-01: hard n_ctx_train=512 limit makes them unsuitable for extended benchmark. */
const EXCLUDED_MODEL_NAMES = new Set(['bge-reranker-base']);

/** Filtered reranker list for extended benchmark (D-01). */
const EXTENDED_RERANKERS = DEFAULT_RERANKERS.filter(m => !EXCLUDED_MODEL_NAMES.has(m.name));

/** Parse CLI arguments. */
function parseArgs(): { strategy: ExtractStrategy; docMaxChars: number; allModels: boolean; maxBatchTokens: number | undefined; outputPrefix: string } {
  const args = process.argv.slice(2);
  const strategy = (args.find(a => a.startsWith('--strategy='))?.split('=')[1] as ExtractStrategy) ?? 'head';
  const docMaxChars = parseInt(args.find(a => a.startsWith('--doc-max-chars='))?.split('=')[1] ?? String(DEFAULT_DOC_MAX_CHARS), 10);
  const allModels = args.includes('--all-models');
  const maxBatchTokens = args.find(a => a.startsWith('--max-batch-tokens='))?.split('=')[1]
    ? parseInt(args.find(a => a.startsWith('--max-batch-tokens='))!.split('=')[1], 10)
    : undefined;
  const outputPrefix = (args.find(a => a.startsWith('--output-prefix='))?.split('=')[1]) ?? `P7-5-${strategy}`;
  return { strategy, docMaxChars, allModels, maxBatchTokens, outputPrefix };
}

/** The closed set of k-values for recall. */
const K_VALUES = [10, 20] as const;
type KValue = (typeof K_VALUES)[number];

/** One query scored against one reranker. */
interface RerankerQueryMetric {
  readonly queryId: string;
  readonly axis: string;
  readonly retrievedCount: number;
  readonly ndcg10: number;
  /** Per-k recall; undefined if the query has no relevant atoms. */
  readonly recalls: Readonly<Record<KValue, number | undefined>>;
  readonly reciprocalRank: number | undefined;
  /** Rerank call latency in ms. */
  readonly latencyMs: number;
}

/** One reranker model's aggregate across all queries. */
interface RerankerModelResult {
  readonly model: string;
  readonly corpus: string;
  readonly atomCount: number;
  readonly kInit: number;
  /** Aggregate metrics. */
  readonly ndcg10: number | undefined;
  readonly perK: Readonly<Record<KValue, { recall: number | undefined; scored: number; unscorable: number }>>;
  readonly mrr: number | undefined;
  /** Latency stats. */
  readonly latency: { min: number; max: number; mean: number; p50: number; p95: number; total: number };
  readonly perQuery: readonly RerankerQueryMetric[];
}

/** The full P7-5 report. */
interface P75Report {
  readonly generatedAt: string;
  readonly goldenSetPath: string;
  readonly goldenSetFrozenAt: string;
  readonly queryCount: number;
  readonly kInit: number;
  readonly kValues: readonly KValue[];
  readonly extractionStrategy: string;
  readonly docMaxChars: number;
  readonly rerankerModels: readonly string[];
  readonly skippedModels: readonly { name: string; reason: string }[];
  readonly corpus: string;
  readonly atomCount: number;
  readonly results: readonly RerankerModelResult[];
}

const asDomain = (value: string | null): AtomDomain | undefined =>
  value === null ? undefined : ATOM_DOMAINS.find(domain => domain === value);

/** Score one query against one reranker's output. */
const scoreRerankerQuery = (
  query: GoldenQuery,
  retrievedIds: readonly string[],
  latencyMs: number
): RerankerQueryMetric => ({
  queryId: query.id,
  axis: query.axis,
  retrievedCount: retrievedIds.length,
  ndcg10: ndcgAtK(retrievedIds, query.relevantAtomIds, 10),
  recalls: Object.fromEntries(
    K_VALUES.map(k => [k, recallAtK(retrievedIds, query.relevantAtomIds, k)])
  ) as Record<KValue, number | undefined>,
  reciprocalRank: reciprocalRank(retrievedIds, query.relevantAtomIds),
  latencyMs,
});

/** Aggregate per-query metrics at a single k. */
const aggregateAtK = (k: KValue, metrics: readonly RerankerQueryMetric[]) => {
  const recalls = metrics.map(m => m.recalls[k]);
  const scored = recalls.filter(v => v !== undefined).length;
  return {
    recall: mean(recalls),
    scored,
    unscorable: metrics.length - scored,
  };
};

/** Compute latency stats from per-query timings. */
const latencyStats = (latencies: number[]) => {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    min: sorted[0] ?? 0,
    max: sorted[n - 1] ?? 0,
    mean: mean(sorted) ?? 0,
    p50: sorted[Math.floor(n * 0.5)] ?? 0,
    p95: sorted[Math.floor(n * 0.95)] ?? 0,
    total: sorted.reduce((a, b) => a + b, 0),
  };
};

/** Measure one reranker model against the golden set using fts5 first-pass. */
const measureReranker = async (
  modelConfig: RerankerModelConfig,
  corpus: BenchCorpus,
  goldenSet: GoldenSet,
  workDir: string,
  strategy: ExtractStrategy,
  docMaxChars: number,
  maxBatchTokens: number | undefined
): Promise<RerankerModelResult> => {
  // Build fts5 index for first-pass retrieval
  const fts5 = await fts5Candidate();
  const fts5Location = {
    atomsDir: corpus.atomsDir,
    indexPath: join(workDir, `fts5-p75-${modelConfig.name.replace(/[^a-zA-Z0-9-]/g, '')}.db`),
  };
  await fts5.index(fts5Location);

  // Open fts5 port for first-pass
  const fts5Port: KnowledgePort = fts5.open(fts5Location);

  // Create reranker HTTP client with per-model batch limit (CLI override for MaxFit)
  const rerankerClient = createRerankerClient(
    modelConfig.baseUrl,
    modelConfig.modelId,
    60000,
    maxBatchTokens ?? modelConfig.maxBatchTokens ?? 4000,
    modelConfig.maxDocsPerChunk
  );

  // For each query: fts5 first-pass → extract bodies → rerank → score
  const perQuery = await mapSequential(goldenSet.queries, async (query: GoldenQuery) => {
    const domain = asDomain(query.domain);
    // First-pass: retrieve K_INIT candidates via fts5
    const retrieval: RetrievalResult = await fts5Port.retrieve(
      query.query,
      domain === undefined ? { k: K_INIT } : { k: K_INIT, domain }
    );

    // Extract atom bodies for reranker input, truncated per strategy
    const documents: string[] = retrieval.atoms.map(atom => extractDoc(atom.body, strategy, docMaxChars));
    // Map index → atom id for reordering
    const indexToId: string[] = retrieval.atoms.map(atom => atom.id);

    if (documents.length === 0) {
      return scoreRerankerQuery(query, [], 0);
    }

    // Rerank via HTTP
    const start = performance.now();
    const results: RerankResult[] = await rerankerClient.rerank(query.query, documents);
    const latencyMs = performance.now() - start;

    // Map reranked indices back to atom IDs in score order
    const rerankedIds: string[] = results
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .map(r => indexToId[r.index])
      .filter((id): id is string => id !== undefined);

    return scoreRerankerQuery(query, rerankedIds, latencyMs);
  });

  fts5Port.close?.();

  // Aggregate
  const ndcgValues = perQuery.map(q => q.ndcg10);
  const rrValues = perQuery.map(q => q.reciprocalRank);
  const perK = Object.fromEntries(
    K_VALUES.map(k => [k, aggregateAtK(k, perQuery)])
  ) as Record<KValue, { recall: number | undefined; scored: number; unscorable: number }>;

  return {
    model: modelConfig.name,
    corpus: corpus.label,
    atomCount: corpus.atomCount,
    kInit: K_INIT,
    ndcg10: mean(ndcgValues),
    perK,
    mrr: mean(rrValues),
    latency: latencyStats(perQuery.map(q => q.latencyMs)),
    perQuery,
  };
};

/** Render the report as markdown. */
const renderMarkdown = (report: P75Report): string => {
  const ratio = (v: number | undefined): string => v === undefined ? 'n/a' : v.toFixed(4);
  const ms = (v: number): string => v.toFixed(1) + 'ms';

  const lines: string[] = [
    '# P7-5: Reranker Benchmark',
    '',
    '> **Purpose:** Measure reranking quality on top of fts5 first-pass retrieval.',
    '> A reranker improves ordering without expanding the candidate pool.',
    '',
    '## Provenance',
    '',
    `- generated at: \`${report.generatedAt}\``,
    `- golden set frozen at: \`${report.goldenSetFrozenAt}\``,
    `- golden set path: \`${report.goldenSetPath}\``,
    `- queries: ${report.queryCount}`,
    `- corpus: ${report.corpus} (${report.atomCount} atoms)`,
    `- first-pass adapter: fts5`,
    `- k_init (candidate pool): ${report.kInit}`,
    `- k values measured: ${report.kValues.join(', ')}`,
    `- extraction strategy: ${report.extractionStrategy}`,
    `- doc max chars: ${report.docMaxChars}`,
    `- reranker models: ${report.rerankerModels.join(', ')}`,
    '',
  ];

  if (report.skippedModels.length > 0) {
    lines.push('## Skipped models', '');
    lines.push(...report.skippedModels.map(m => `- **${m.name}** — ${m.reason}`));
    lines.push('');
  }

  // Per-model results
  lines.push('## Results');
  lines.push('');

  for (const result of report.results) {
    lines.push(`### ${result.model}`);
    lines.push('');
    lines.push('| metric | value |');
    lines.push('|---|---|');
    lines.push(`| nDCG@10 | ${ratio(result.ndcg10)} |`);
    for (const k of K_VALUES) {
      const m = result.perK[k];
      lines.push(`| recall@${k} | ${ratio(m.recall)} |`);
    }
    lines.push(`| MRR | ${ratio(result.mrr)} |`);
    lines.push('');

    // Latency summary
    lines.push('**Latency (per rerank call):**');
    lines.push('');
    lines.push('| min | p50 | p95 | max | mean | total |');
    lines.push('|---|---|---|---|---|---|');
    lines.push(`| ${ms(result.latency.min)} | ${ms(result.latency.p50)} | ${ms(result.latency.p95)} | ${ms(result.latency.max)} | ${ms(result.latency.mean)} | ${ms(result.latency.total)} |`);
    lines.push('');

    // Per-query breakdown
    lines.push('<details><summary>Per-query breakdown</summary>', '');
    const kHeaders = K_VALUES.map(k => `recall@${k}`).join(' | ');
    lines.push(`| query | axis | retrieved | nDCG@10 | ${kHeaders} | MRR | latency |`);
    lines.push(`|---|---|---|---|${'|---'.repeat(K_VALUES.length + 2)}|---|`);
    for (const qm of result.perQuery) {
      const recalls = K_VALUES.map(k => ratio(qm.recalls[k])).join(' | ');
      lines.push(
        `| ${qm.queryId} | ${qm.axis} | ${qm.retrievedCount} | ${qm.ndcg10.toFixed(4)} | ${recalls} | ${ratio(qm.reciprocalRank)} | ${ms(qm.latencyMs)} |`
      );
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Summary comparison — ranked by nDCG@10
  lines.push('## Summary: Model Ranking by nDCG@10');
  lines.push('');
  lines.push('| rank | model | nDCG@10 | recall@10 | recall@20 | MRR | mean latency | p95 latency |');
  lines.push('|---|---|---|---|---|---|---|---|');

  const ranked = [...report.results].sort((a, b) => {
    const aNdcg = a.ndcg10 ?? -1;
    const bNdcg = b.ndcg10 ?? -1;
    return bNdcg - aNdcg;
  });

  ranked.forEach((result, index) => {
    lines.push(
      `| ${index + 1} | ${result.model} | ${ratio(result.ndcg10)} | ${ratio(result.perK[10].recall)} | ${ratio(result.perK[20].recall)} | ${ratio(result.mrr)} | ${ms(result.latency.mean)} | ${ms(result.latency.p95)} |`
    );
  });
  lines.push('');

  // What was NOT measured
  lines.push('## What Was NOT Measured');
  lines.push('');
  lines.push('- Precision or any metric beyond nDCG@10, recall@10, recall@20, MRR');
  lines.push('- Hungarian-language reranking (D-R17: English only)');
  lines.push('- Synthetic corpora (seed corpus only)');
  lines.push('- First-pass adapter comparison (fts5 only — P7-0 covers adapter comparison)');
  lines.push('- Reranker index size, memory, or startup cost');
  lines.push('- Cross-adapter reranking (e.g., minisearch first-pass + reranker)');
  lines.push('');

  return lines.join('\n');
};

const ratio = (v: number | undefined): string => v === undefined ? 'n/a' : v.toFixed(4);

async function main() {
  const { strategy, docMaxChars, allModels, maxBatchTokens: cliMaxBatchTokens, outputPrefix } = parseArgs();
  const models = allModels ? DEFAULT_RERANKERS : EXTENDED_RERANKERS;
  const outputDir = resolve(REPO_ROOT, 'docs', 'benchmarking', '2026-08-09-gnosis-reranker');
  await mkdir(outputDir, { recursive: true });

  // Load golden set
  const goldenSet = loadVerifiedGoldenSet();
  console.log(`Golden set: ${goldenSet.queries.length} queries, frozen ${goldenSet.frozenAt}`);
  console.log(`Strategy: ${strategy}, docMaxChars: ${docMaxChars}`);

  // Materialize the real corpus
  const corpus = await materializeRealCorpus(ATOMS_DIR, BENCH_WORK_DIR, 'seed');
  console.log(`Corpus: ${corpus.atomCount} atoms`);

  // Check reranker availability — probe each model with a health check
  const rerankers: RerankerModelConfig[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const model of models) {
    try {
      const resp = await fetch(`${model.baseUrl}/v1/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.modelId,
          query: 'health check',
          documents: ['health check'],
          top_n: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        rerankers.push(model);
      } else {
        skipped.push({ name: model.name, reason: `HTTP ${resp.status}: ${resp.statusText}` });
      }
    } catch (err) {
      skipped.push({ name: model.name, reason: err instanceof Error ? err.message : 'connection failed' });
    }
  }

  console.log(`Rerankers: ${rerankers.length} available, ${skipped.length} skipped`);

  // Measure each reranker
  const results = await mapSequential(rerankers, async modelConfig => {
    console.log(`Measuring: ${modelConfig.name}`);
    return measureReranker(modelConfig, corpus, goldenSet, BENCH_WORK_DIR, strategy, docMaxChars, cliMaxBatchTokens);
  });

  if (rerankers.length === 0) {
    console.error('No reranker models available. Ensure llama-server instances are running.');
    process.exit(1);
  }

  // Build report
  const report: P75Report = {
    generatedAt: new Date().toISOString(),
    goldenSetPath: 'tools/dp-gnosis/golden/golden-set.v1.json',
    goldenSetFrozenAt: goldenSet.frozenAt,
    queryCount: goldenSet.queries.length,
    kInit: K_INIT,
    kValues: K_VALUES,
    extractionStrategy: strategy,
    docMaxChars,
    rerankerModels: rerankers.map(m => m.name),
    skippedModels: skipped,
    corpus: corpus.label,
    atomCount: corpus.atomCount,
    results,
  };

  // Write markdown
  const mdPath = join(outputDir, `${outputPrefix}.md`);
  await writeFile(mdPath, renderMarkdown(report), 'utf8');
  console.log(`Report: ${mdPath}`);

  // Write JSON sidecar
  const jsonPath = join(outputDir, `${outputPrefix}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`JSON: ${jsonPath}`);

  // Print summary to stdout
  console.log('\n=== P7-5 Summary ===');
  for (const result of results) {
    console.log(
      `${result.model}: nDCG@10=${ratio(result.ndcg10)} recall@10=${ratio(result.perK[10].recall)} recall@20=${ratio(result.perK[20].recall)} MRR=${ratio(result.mrr)} | latency mean=${result.latency.mean.toFixed(1)}ms p95=${result.latency.p95.toFixed(1)}ms`
    );
  }
}

main().catch(err => {
  console.error('P7-5 measurement failed:', err);
  process.exit(1);
});
