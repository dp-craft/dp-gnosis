/**
 * Cross-SYSTEM paired test — pair one of OUR per-topic files against an
 * EXTERNAL system's (qmd), on the same dataset, topics and qrels.
 *
 * Why it is not `pair.ts`: that command refuses this pairing, and it is right to
 * for its own job. `atomCount` is a SCALE_FIELD and the two systems genuinely
 * chunk differently (gnosis 455 atoms / qmd 524 chunks on `vault-hu`), so
 * subtracting their rows would compare two different corpora. But every metric
 * here is scored at DOCUMENT level over the SAME document set, so an internal
 * chunk count cannot move it, and the provenance guard is the only thing in the
 * way.
 *
 * It therefore calls `pairedScores`, which `significance.ts` documents as
 * "`pairedSignificance` minus run resolution and the provenance guard" — so the
 * statistic CANNOT diverge from the one every gnosis pairing uses. The guard is
 * bypassed deliberately and only here; no arithmetic changes.
 *
 * MUST NOT be used to pair two gnosis arms — that is `gnosis:pair`, guard and
 * all. Bypassing a provenance guard is defensible exactly once, for the case it
 * was never written to cover.
 *
 * usage: tsx scripts/crossPair.ts <dataset> <a.tsv> <b.tsv> <aLabel> <bLabel>
 *   paths are relative to the bench package root; positive Δ means B is ahead
 */
import { type MetricName, pairedScores, readPerTopic } from '../src/significance.ts';

const [dataset, aPath, bPath, aLabel, bLabel] = process.argv.slice(2);
if (dataset === undefined || aPath === undefined || bPath === undefined) {
  process.stderr.write('usage: tsx scripts/crossPair.ts <dataset> <a.tsv> <b.tsv> <aLabel> <bLabel>\n');
  process.exit(2);
}
const a = readPerTopic(aPath);
const b = readPerTopic(bPath);
if (a === undefined || b === undefined) throw new Error('unreadable per-topic file');

const METRICS: readonly MetricName[] = ['ndcg10', 'recall10', 'recall100', 'mrr10', 'precision10', 'map'];
const signed = (value: number): string => (value >= 0 ? '+' : '') + value.toFixed(4);

process.stdout.write(`\n${dataset}: B=${bLabel} minus A=${aLabel}  (positive ⇒ ${bLabel} ahead)\n`);
process.stdout.write('metric        Δ mean      p        95% CI                topics\n');
for (const metric of METRICS) {
  const verdict = pairedScores(dataset, metric, a, b);
  if (verdict.kind !== 'verdict') {
    process.stdout.write(`${metric.padEnd(13)} ${verdict.kind}\n`);
    continue;
  }
  const ci = `[${signed(verdict.ciLow)}, ${signed(verdict.ciHigh)}]`;
  process.stdout.write(
    `${metric.padEnd(13)} ${signed(verdict.meanDifference)}  ${verdict.pValue.toFixed(4)}  ` +
    `${ci.padEnd(22)} ${verdict.topics}  ${verdict.significant ? 'SIGNIFICANT' : 'ns'}\n`
  );
}
