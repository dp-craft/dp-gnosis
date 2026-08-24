/**
 * P7-0 per-k timing: measures actual retrieval cost at k=5, k=200, k=400.
 * Each k is a SEPARATE retrieval call so latency reflects real cost.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  defaultCandidates,
  type AdapterCandidate,
  isAvailable,
  skippedOf,
} from './bench/candidates.js';
import { materializeRealCorpus } from './bench/corpora.js';
import { recallAtK, mean } from './bench/metrics.js';
import { loadVerifiedGoldenSet, type GoldenSet } from './goldenSet.js';
import { ATOMS_DIR, BENCH_WORK_DIR, REPO_ROOT } from './paths.js';
import type { KnowledgePort } from './port.js';
import { type CorpusLocation } from './bench/candidates.js';
import { type AtomDomain, atomDomains } from './vocabulary.js';

const K_VALUES = [5, 100, 200, 400] as const;
type KValue = (typeof K_VALUES)[number];

interface KResult {
  readonly k: KValue;
  readonly recall: number | undefined;
  readonly latencyMean: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly latencyMin: number;
  readonly latencyMax: number;
  readonly totalMs: number;
}

interface AdapterResult {
  readonly adapter: string;
  readonly perK: Readonly<Record<KValue, KResult>>;
}

const asDomain = (value: string | null): AtomDomain | undefined =>
  value === null ? undefined : atomDomains().find(domain => domain === value);

const percentile = (sorted: number[], p: number) => sorted[Math.floor(sorted.length * p)] ?? 0;

const measureOneK = async (
  k: KValue,
  location: CorpusLocation,
  candidate: AdapterCandidate,
  goldenSet: GoldenSet
): Promise<KResult> => {
  const port: KnowledgePort = candidate.open(location);

  const latencies: number[] = [];
  let scoredCount = 0;
  let recallSum = 0;

  for (const query of goldenSet.queries) {
    const domain = asDomain(query.domain);
    const start = performance.now();
    const result = await port.retrieve(query.query, domain === undefined ? { k } : { k, domains: [domain] });
    latencies.push(performance.now() - start);

    const recall = recallAtK(result.atoms.map(a => a.id), query.relevantAtomIds, k);
    if (recall !== undefined) {
      scoredCount++;
      recallSum += recall;
    }
  }
  port.close?.();

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    k,
    recall: scoredCount > 0 ? recallSum / scoredCount : undefined,
    latencyMean: mean(latencies) ?? 0,
    latencyP50: percentile(sorted, 0.5),
    latencyP95: percentile(sorted, 0.95),
    latencyMin: sorted[0] ?? 0,
    latencyMax: sorted[sorted.length - 1] ?? 0,
    totalMs: latencies.reduce((a, b) => a + b, 0),
  };
};

const ms = (v: number): string => v < 1 ? `${(v * 1000).toFixed(0)}μs` : v < 1000 ? `${v.toFixed(1)}ms` : `${(v / 1000).toFixed(2)}s`;

async function main() {
  const outputDir = resolve(REPO_ROOT, 'docs', 'benchmarking', '2026-08-09-gnosis-reranker');
  await mkdir(outputDir, { recursive: true });

  const goldenSet = loadVerifiedGoldenSet();
  const corpus = await materializeRealCorpus(ATOMS_DIR, BENCH_WORK_DIR, 'seed');
  const candidates = (await defaultCandidates()).filter(isAvailable);
  const skipped = skippedOf(await defaultCandidates());

  console.log(`Queries: ${goldenSet.queries.length} | Corpus: ${corpus.atomCount} atoms | Adapters: ${candidates.length}`);
  console.log('');

  const results: AdapterResult[] = [];

  for (const candidate of candidates) {
    console.log(`\n${candidate.name}:`);
    const perK: Record<KValue, KResult> = {} as Record<KValue, KResult>;

    const location: CorpusLocation = {
      atomsDir: corpus.atomsDir,
      indexPath: join(BENCH_WORK_DIR, `${candidate.name}-p70timed.db`),
    };

    await candidate.index(location);

    for (const k of K_VALUES) {
      const result = await measureOneK(k, location, candidate, goldenSet);
      perK[k] = result;
      console.log(`  k=${k.toString().padStart(3)}: recall=${result.recall?.toFixed(4) ?? 'n/a'} | mean=${ms(result.latencyMean)} p95=${ms(result.latencyP95)} total=${ms(result.totalMs)}`);
    }

    results.push({ adapter: candidate.name, perK });
  }

  // Build markdown
  const lines: string[] = [
    '# P7-0: Per-K Retrieval Timing',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Corpus: ${corpus.label} (${corpus.atomCount} atoms) | Queries: ${goldenSet.queries.length}`,
    '',
    '## Recall + Latency Per K',
    '',
  ];

  for (const result of results) {
    lines.push(`### ${result.adapter}`);
    lines.push('');
    lines.push('| k | recall@k | mean/query | p50 | p95 | min | max | total (50q) |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const k of K_VALUES) {
      const r = result.perK[k];
      lines.push(`| ${k} | ${r.recall?.toFixed(4) ?? 'n/a'} | ${ms(r.latencyMean)} | ${ms(r.latencyP50)} | ${ms(r.latencyP95)} | ${ms(r.latencyMin)} | ${ms(r.latencyMax)} | ${ms(r.totalMs)} |`);
    }
    lines.push('');
  }

  // Cross-adapter comparison
  lines.push('## Comparison: Time to Reach Recall@k');
  lines.push('');
  lines.push('| adapter | recall@5 | time@5 | recall@100 | time@100 | recall@200 | time@200 | recall@400 | time@400 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const result of results) {
    const r5 = result.perK[5];
    const r100 = result.perK[100];
    const r200 = result.perK[200];
    const r400 = result.perK[400];
    lines.push(`| ${result.adapter} | ${r5.recall?.toFixed(4)} | ${ms(r5.totalMs)} | ${r100.recall?.toFixed(4)} | ${ms(r100.totalMs)} | ${r200.recall?.toFixed(4)} | ${ms(r200.totalMs)} | ${r400.recall?.toFixed(4)} | ${ms(r400.totalMs)} |`);
  }
  lines.push('');

  if (skipped.length > 0) {
    lines.push('## Skipped', '');
    for (const s of skipped) lines.push(`- **${s.name}** — ${s.reason}`);
    lines.push('');
  }

  const mdPath = join(outputDir, 'P7-0-per-k-timing.md');
  await writeFile(mdPath, lines.join('\n'), 'utf8');
  console.log(`\nReport: ${mdPath}`);

  // JSON
  const jsonPath = join(outputDir, 'P7-0-per-k-timing.json');
  await writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), corpus: corpus.label, atomCount: corpus.atomCount, queryCount: goldenSet.queries.length, results, skipped }, null, 2) + '\n', 'utf8');
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
