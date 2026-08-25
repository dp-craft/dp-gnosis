import { fts5Candidate } from './src/bench/candidates.js';
import { materializeRealCorpus } from './src/bench/corpora.js';
import { recallAtK } from './src/bench/metrics.js';
import { createRerankerClient, extractDoc } from './src/bench/reranker.js';
import { loadVerifiedGoldenSet } from './src/goldenSet.js';
import { ATOMS_DIR, BENCH_WORK_DIR } from './src/paths.js';
import { ATOM_DOMAINS } from './src/config.js';
import { join, resolve, dirname } from 'path';
import { mkdir, writeFile, cp } from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const [port, modelName, mbt, maxDocs] = args;

  // Output dir: docs/test/YYYY-MM-DD_HH-mm-ss
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const outputDir = join(__dirname, 'docs', 'test', `${ts}-${modelName}`);
  await mkdir(outputDir, { recursive: true });

  // Copy this script for run details
  await cp(join(__dirname, 'rerank-test.mts'), join(outputDir, 'rerank-test.mts'));

  const goldenSet = loadVerifiedGoldenSet();
  const corpus = await materializeRealCorpus(ATOMS_DIR, BENCH_WORK_DIR, 'seed');
  const fts5 = await fts5Candidate();
  const fts5Location = { atomsDir: corpus.atomsDir, indexPath: join(BENCH_WORK_DIR, 'fts5-diag.db') };
  await fts5.index(fts5Location);
  const fts5Port = fts5.open(fts5Location);

  const client = createRerankerClient(`http://127.0.0.1:${port}`, modelName, 300000, parseInt(mbt), parseInt(maxDocs));

  const strategies = [
    { name: 'head-200', strategy: 'head', docMaxChars: 200 },
    { name: 'headTail-512', strategy: 'headTail', docMaxChars: 512 },
    { name: 'full-1000', strategy: 'full', docMaxChars: 1000 },
  ];

  const results: any[] = [];

  for (const s of strategies) {
    console.log('  ' + s.name + ':');
    const recalls: number[] = [];
    for (let i = 0; i < goldenSet.queries.length; i++) {
      const query = goldenSet.queries[i];
      const domain = query.domain === null ? undefined : ATOM_DOMAINS.find(d => d === query.domain);
      const retrieval = await fts5Port.retrieve(query.query, domain === undefined ? { k: 200 } : { k: 200, domain });
      const extracted = retrieval.atoms.map(a => extractDoc(a.body, s.strategy, s.docMaxChars));
      if (extracted.length === 0) continue;
      const reranked = await client.rerank(query.query, extracted);
      const rerankedIds = reranked.sort((a, b) => b.relevanceScore - a.relevanceScore).map((r, idx) => retrieval.atoms[r.index].id).slice(0, 200);
      const rec = recallAtK(rerankedIds, query.relevantAtomIds, 200);
      if (rec !== undefined) recalls.push(rec);
      if (i % 10 === 0) console.log(`    Query ${i + 1}/${goldenSet.queries.length} done`);
    }
    const avgRecall = recalls.reduce((a, b) => a + b, 0) / recalls.length;
    console.log('    recall@200: ' + avgRecall.toFixed(4) + ' (' + recalls.length + ' queries)');
    results.push({ strategy: s.name, recall200: avgRecall, queries: recalls.length, perQuery: recalls });
  }

  // Save results
  const report = {
    model: modelName,
    port: parseInt(port),
    maxBatchTokens: parseInt(mbt),
    maxDocsPerChunk: parseInt(maxDocs),
    timestamp: new Date().toISOString(),
    corpus: { label: corpus.label, atomCount: corpus.atomCount },
    goldenSet: { queries: goldenSet.queries.length },
    results,
  };

  const jsonPath = join(outputDir, 'results.json');
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  console.log('Saved: ' + jsonPath);

  // Save markdown summary
  let md = `# Reranker Benchmark: ${modelName}\n\n`;
  md += `- **Model**: ${modelName}\n`;
  md += `- **Port**: ${port}\n`;
  md += `- **Max Batch Tokens**: ${mbt}\n`;
  md += `- **Max Docs Per Chunk**: ${maxDocs}\n`;
  md += `- **Timestamp**: ${report.timestamp}\n`;
  md += `- **Corpus**: ${corpus.label} (${corpus.atomCount} atoms)\n`;
  md += `- **Queries**: ${goldenSet.queries.length}\n\n`;
  md += `| Strategy | recall@200 | Queries |\n`;
  md += `|---|---|---|\n`;
  for (const r of results) {
    md += `| ${r.strategy} | ${r.recall200.toFixed(4)} | ${r.queries} |\n`;
  }
  md += `\n## Per-Query Results\n\n`;
  for (const r of results) {
    md += `### ${r.strategy}\n\n`;
    md += `| Query | recall@200 |\n`;
    md += `|---|---|\n`;
    r.perQuery.forEach((v: number, i: number) => {
      md += `| ${i + 1} | ${v.toFixed(4)} |\n`;
    });
    md += `\n`;
  }

  const mdPath = join(outputDir, 'results.md');
  await writeFile(mdPath, md);
  console.log('Saved: ' + mdPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
