/**
 * P7-0: Candidate-depth measurement — gates P7-5.
 *
 * On the existing golden set and adapters, computes recall@5 / @20 / @50 / @200 / @400.
 * A reranker only REORDERS what the first pass already fetched: if recall@200
 * is high, reranking is the fix; if it is as flat as recall@5, there is nothing
 * to reorder and P7-5 is the wrong lever.
 *
 * English-only (D-R17). Each adapter is a SEPARATE measurement epoch.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  defaultCandidates,
  type AdapterCandidate,
  isAvailable,
  skippedOf,
} from './bench/candidates.js';
import { materializeRealCorpus, type BenchCorpus } from './bench/corpora.js';
import { recallAtK, reciprocalRank, mean } from './bench/metrics.js';
import { mapSequential } from './bench/sequential.js';
import { loadVerifiedGoldenSet, type GoldenSet, type GoldenQuery } from './goldenSet.js';
import { ATOMS_DIR, BENCH_WORK_DIR, REPO_ROOT } from './paths.js';
import type { KnowledgePort, RetrievalResult } from './port.js';
import { type CorpusLocation } from './bench/candidates.js';
import { ATOM_DOMAINS, type AtomDomain } from './config.js';

const K_VALUES = [5, 20, 50, 200, 400] as const;
type KValue = (typeof K_VALUES)[number];

/** Retrieve at this depth so all k-values have enough candidates. */
const RETRIEVE_K: number = 400;

/** One query scored at multiple k-values with timing. */
interface MultiKQueryMetric {
  readonly queryId: string;
  readonly axis: string;
  readonly retrievedCount: number;
  /** Per-k recall; undefined if the query has no relevant atoms. */
  readonly recalls: Readonly<Record<KValue, number | undefined>>;
  readonly reciprocalRank: number | undefined;
  /** Retrieval latency in ms. */
  readonly latencyMs: number;
}

/** One adapter's aggregate across all queries at each k. */
interface AdapterMultiKResult {
  readonly adapter: string;
  readonly corpus: string;
  readonly atomCount: number;
  /** Per-k aggregate recall and MRR. */
  readonly perK: Readonly<Record<KValue, { recall: number | undefined; mrr: number | undefined; scored: number; unscorable: number }>>;
  /** Latency stats. */
  readonly latency: { min: number; max: number; mean: number; p50: number; p95: number; total: number };
  readonly perQuery: readonly MultiKQueryMetric[];
}

/** The full P7-0 report. */
interface P70Report {
  readonly generatedAt: string;
  readonly goldenSetPath: string;
  readonly goldenSetFrozenAt: string;
  readonly queryCount: number;
  readonly kValues: readonly KValue[];
  readonly adapters: readonly string[];
  readonly skippedAdapters: readonly { name: string; reason: string }[];
  readonly corpus: string;
  readonly atomCount: number;
  readonly results: readonly AdapterMultiKResult[];
}

const asDomain = (value: string | null): AtomDomain | undefined =>
  value === null ? undefined : ATOM_DOMAINS.find(domain => domain === value);

/** Score one query at all k-values from a single retrieval. */
const scoreMultiK = (
  query: GoldenQuery,
  retrievedIds: readonly string[],
  latencyMs: number
): MultiKQueryMetric => ({
  queryId: query.id,
  axis: query.axis,
  retrievedCount: retrievedIds.length,
  recalls: Object.fromEntries(
    K_VALUES.map(k => [k, recallAtK(retrievedIds, query.relevantAtomIds, k)])
  ) as Record<KValue, number | undefined>,
  reciprocalRank: reciprocalRank(retrievedIds, query.relevantAtomIds),
  latencyMs,
});

/** Aggregate per-query metrics at a single k. */
const aggregateAtK = (k: KValue, metrics: readonly MultiKQueryMetric[]) => {
  const recalls = metrics.map(m => m.recalls[k]);
  const rrs = metrics.map(m => m.reciprocalRank);
  const scored = recalls.filter(v => v !== undefined).length;
  return {
    recall: mean(recalls),
    mrr: mean(rrs),
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

/** Measure one adapter against the golden set. */
const measureAdapter = async (
  candidate: AdapterCandidate,
  corpus: BenchCorpus,
  goldenSet: GoldenSet,
  workDir: string
): Promise<AdapterMultiKResult> => {
  const location: CorpusLocation = {
    atomsDir: corpus.atomsDir,
    indexPath: join(workDir, `${candidate.name}-p70.db`),
  };

  // Build index
  await candidate.index(location);

  // Open port, retrieve all queries with timing
  const port: KnowledgePort = candidate.open(location);
  const perQuery = await mapSequential(goldenSet.queries, async query => {
    const domain = asDomain(query.domain);
    const start = performance.now();
    const result: RetrievalResult = await port.retrieve(query.query, domain === undefined ? { k: RETRIEVE_K } : { k: RETRIEVE_K, domains: [domain] });
    const latencyMs = performance.now() - start;
    return scoreMultiK(query, result.atoms.map(atom => atom.id), latencyMs);
  });
  port.close?.();

  const perK = Object.fromEntries(
    K_VALUES.map(k => [k, aggregateAtK(k, perQuery)])
  ) as Record<KValue, { recall: number | undefined; mrr: number | undefined; scored: number; unscorable: number }>;

  return {
    adapter: candidate.name,
    corpus: corpus.label,
    atomCount: corpus.atomCount,
    perK,
    latency: latencyStats(perQuery.map(q => q.latencyMs)),
    perQuery,
  };
};

/** Render the report as markdown. */
const renderMarkdown = (report: P70Report): string => {
  const ratio = (v: number | undefined): string => v === undefined ? 'n/a' : v.toFixed(4);
  const ms = (v: number): string => v.toFixed(1) + 'ms';

  const lines: string[] = [
    '# P7-0: Candidate-Depth Measurement',
    '',
    '> **Purpose:** Determine whether a reranker (P7-5) has candidates to reorder.',
    '> If recall@200 is significantly higher than recall@5, reranking is the fix.',
    '> If recall@200 is flat with recall@5, there is nothing to reorder.',
    '',
    '## Provenance',
    '',
    `- generated at: \`${report.generatedAt}\``,
    `- golden set frozen at: \`${report.goldenSetFrozenAt}\``,
    `- golden set path: \`${report.goldenSetPath}\``,
    `- queries: ${report.queryCount}`,
    `- corpus: ${report.corpus} (${report.atomCount} atoms)`,
    `- k values measured: ${report.kValues.join(', ')}`,
    `- retrieve depth: ${RETRIEVE_K}`,
    '',
    '## Adapters',
    '',
    report.adapters.map(a => `- ${a}`).join('\n'),
    '',
  ];

  if (report.skippedAdapters.length > 0) {
    lines.push('## Skipped adapters', '');
    lines.push(...report.skippedAdapters.map(a => `- **${a.name}** — ${a.reason}`));
    lines.push('');
  }

  // Per-adapter results
  lines.push('## Results');
  lines.push('');

  for (const result of report.results) {
    lines.push(`### ${result.adapter}`);
    lines.push('');
    lines.push('| k | recall@k | MRR | scored | unscorable |');
    lines.push('|---|---|---|---|---|');
    for (const k of K_VALUES) {
      const m = result.perK[k];
      lines.push(`| ${k} | ${ratio(m.recall)} | ${ratio(m.mrr)} | ${m.scored} | ${m.unscorable} |`);
    }
    lines.push('');

    // Latency summary
    lines.push('**Latency (per query):**');
    lines.push('');
    lines.push(`| min | p50 | p95 | max | mean | total |`);
    lines.push('|---|---|---|---|---|---|');
    lines.push(`| ${ms(result.latency.min)} | ${ms(result.latency.p50)} | ${ms(result.latency.p95)} | ${ms(result.latency.max)} | ${ms(result.latency.mean)} | ${ms(result.latency.total)} |`);
    lines.push('');

    // Per-query breakdown
    lines.push('<details><summary>Per-query breakdown</summary>', '');
    const kHeaders = K_VALUES.map(k => `recall@${k}`).join(' | ');
    lines.push(`| query | axis | retrieved | ${kHeaders} | MRR | latency |`);
    lines.push(`|---|---|---|${'|---'.repeat(K_VALUES.length + 2)}|---|`);
    for (const qm of result.perQuery) {
      const recalls = K_VALUES.map(k => ratio(qm.recalls[k])).join(' | ');
      lines.push(
        `| ${qm.queryId} | ${qm.axis} | ${qm.retrievedCount} | ${recalls} | ${ratio(qm.reciprocalRank)} | ${ms(qm.latencyMs)} |`
      );
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Summary comparison
  lines.push('## Summary: Recall Gap');
  lines.push('');
  lines.push('| adapter | recall@5 | recall@200 | recall@400 | gap (@400 - @5) |');
  lines.push('|---|---|---|---|---|');
  for (const result of report.results) {
    const r5 = result.perK[5].recall;
    const r200 = result.perK[200].recall;
    const r400 = result.perK[400].recall;
    const gap = r5 !== undefined && r400 !== undefined ? (r400 - r5).toFixed(4) : 'n/a';
    lines.push(`| ${result.adapter} | ${ratio(r5)} | ${ratio(r200)} | ${ratio(r400)} | ${gap} |`);
  }
  lines.push('');

  // Latency comparison
  lines.push('## Latency Comparison');
  lines.push('');
  lines.push('| adapter | mean/query | p50 | p95 | total (50 queries) |');
  lines.push('|---|---|---|---|---|');
  for (const result of report.results) {
    lines.push(`| ${result.adapter} | ${ms(result.latency.mean)} | ${ms(result.latency.p50)} | ${ms(result.latency.p95)} | ${ms(result.latency.total)} |`);
  }
  lines.push('');

  // Verdict section
  lines.push('## P7-5 Gate Verdict');
  lines.push('');

  // Check if any adapter has a significant gap
  const significantGaps = report.results
    .filter(r => {
      const r5 = r.perK[5].recall;
      const r400 = r.perK[400].recall;
      return r5 !== undefined && r400 !== undefined && (r400 - r5) > 0.06;
    });

  if (significantGaps.length > 0) {
    lines.push(
      '**P7-5 MAY RUN.** At least one adapter shows a significant gap between recall@5 and recall@400.',
      'A reranker has candidates to reorder.',
      '',
      'Adapters with significant gap:',
    );
    for (const r of significantGaps) {
      const gap = (r.perK[400].recall! - r.perK[5].recall!).toFixed(4);
      lines.push(`- ${r.adapter}: gap = ${gap}`);
    }
  } else {
    lines.push(
      '**P7-5 CANCELED.** No adapter shows a significant gap between recall@5 and recall@400.',
      'There is nothing meaningful for a reranker to reorder — the first pass already',
      'surfaces what it can. A reranker would re-order noise, not recover missed atoms.',
      '',
      'The pre-registered minimum meaningful difference (recall resolution) is',
      `${report.queryCount > 0 ? (1 / report.queryCount).toFixed(4) : 'n/a'} per query.`,
      'Every gap is below this floor.',
    );
  }
  lines.push('');

  // What was NOT measured
  lines.push('## What Was NOT Measured');
  lines.push('');
  lines.push('- Precision, nDCG, or any metric beyond recall@k and MRR');
  lines.push('- Hungarian-language retrieval (D-R17: English only)');
  lines.push('- Synthetic corpora (seed corpus only)');
  lines.push('- Index size or cost metrics');
  lines.push('- Reranker models (that is P7-5, which this measurement gates)');
  lines.push('');

  return lines.join('\n');
};

async function main() {
  const outputDir = resolve(REPO_ROOT, 'docs', 'benchmarking', '2026-08-09-gnosis-reranker');
  await mkdir(outputDir, { recursive: true });

  // Load golden set
  const goldenSet = loadVerifiedGoldenSet();
  console.log(`Golden set: ${goldenSet.queries.length} queries, frozen ${goldenSet.frozenAt}`);

  // Materialize the real corpus
  const corpus = await materializeRealCorpus(ATOMS_DIR, BENCH_WORK_DIR, 'seed');
  console.log(`Corpus: ${corpus.atomCount} atoms`);

  // Get candidates
  const candidates = await defaultCandidates();
  const available = candidates.filter(isAvailable);
  const skipped = skippedOf(candidates);
  console.log(`Adapters: ${available.length} available, ${skipped.length} skipped`);

  // Measure each adapter
  const results = await mapSequential(available, candidate =>
    measureAdapter(candidate, corpus, goldenSet, BENCH_WORK_DIR)
  );

  // Build report
  const report: P70Report = {
    generatedAt: new Date().toISOString(),
    goldenSetPath: 'tools/dp-gnosis/golden/golden-set.v1.json',
    goldenSetFrozenAt: goldenSet.frozenAt,
    queryCount: goldenSet.queries.length,
    kValues: K_VALUES,
    adapters: available.map(c => c.name),
    skippedAdapters: skipped,
    corpus: corpus.label,
    atomCount: corpus.atomCount,
    results,
  };

  // Write markdown
  const mdPath = join(outputDir, 'P7-0-candidate-depth-measurement.md');
  await writeFile(mdPath, renderMarkdown(report), 'utf8');
  console.log(`Report: ${mdPath}`);

  // Write JSON sidecar
  const jsonPath = join(outputDir, 'P7-0-candidate-depth-measurement.json');
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`JSON: ${jsonPath}`);

  // Print summary to stdout
  console.log('\n=== P7-0 Summary ===');
  for (const result of results) {
    console.log(`${result.adapter}: recall@5=${result.perK[5].recall?.toFixed(4) ?? 'n/a'} recall@200=${result.perK[200].recall?.toFixed(4) ?? 'n/a'} recall@400=${result.perK[400].recall?.toFixed(4) ?? 'n/a'} | latency mean=${result.latency.mean.toFixed(1)}ms p95=${result.latency.p95.toFixed(1)}ms total=${result.latency.total.toFixed(0)}ms`);
  }

  // Verdict
  const hasSignificantGap = results.some(r => {
    const r5 = r.perK[5].recall;
    const r400 = r.perK[400].recall;
    return r5 !== undefined && r400 !== undefined && (r400 - r5) > 0.06;
  });

  console.log(`\nP7-5 verdict: ${hasSignificantGap ? 'MAY RUN (significant gap found)' : 'CANCELED (no significant gap)'}`);
}

main().catch(err => {
  console.error('P7-0 measurement failed:', err);
  process.exit(1);
});
