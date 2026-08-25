#!/usr/bin/env node
/**
 * qmd-arm — drive an EXTERNAL `qmd` retrieval arm over a BEIR-layout topic set
 * and export a TREC run file plus the raw per-topic payload.
 *
 * WHY BLACK BOX: `qmd` is a competitor arm, not a leg of dp-gnosis. It is
 * exercised ONLY through its public CLI on stock defaults — never read,
 * patched, or vendored. Any tuning we could do by reaching into its source
 * would make the measured number describe OUR build of qmd, not the tool a
 * user would install, and the comparison would stop being evidence.
 *
 * CONTRACT 1 — docid identity. `--full-path` is mandatory: the qrels name
 * documents by corpus id, and only the full path lets us recover that id as
 * `basename(file, '.md')`. Without it two distinct documents can collapse onto
 * the same bare name and score as one.
 *
 * CONTRACT 2 — document-level first-occurrence rollup. qmd returns CHUNKS; the
 * qrels judge DOCUMENTS. Several chunks of one document are one document, held
 * at its BEST (first) rank — deduping any other way would either inflate the
 * run with duplicate docids or demote a document to its worst chunk.
 *
 * Also non-negotiable: the raw `--explain` payload is written per topic. It is
 * the only thing that can attribute a win to a leg afterwards, and re-running
 * to recover it costs the whole arm. A failing topic is recorded as zero
 * results, never retried and never skipped — a dropped topic flatters the arm.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const REQUIRED_FLAGS = ['--qmd', '--index-dir', '--queries', '--out-run', '--out-raw'];
const DEFAULT_DEPTH = 100;
const DEFAULT_TAG = 'qmd';
const MAX_BUFFER = 256 * 1024 * 1024;

const argValue = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};

const missingFlags = () => REQUIRED_FLAGS.filter((name) => argValue(name, undefined) === undefined);

const parseArgs = () => ({
  qmd: argValue('--qmd', ''),
  indexDir: argValue('--index-dir', ''),
  queries: argValue('--queries', ''),
  outRun: argValue('--out-run', ''),
  outRaw: argValue('--out-raw', ''),
  depth: Number(argValue('--depth', String(DEFAULT_DEPTH))),
  tag: argValue('--tag', DEFAULT_TAG),
  extra: argValue('--extra', '').split(/\s+/).filter((token) => token.length > 0),
});

const readTopics = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

const buildQueryArgs = (text, cfg) => [
  'query', text, '-n', String(cfg.depth), '--json', '--full-path', '--explain', ...cfg.extra,
];

const firstLine = (err) => String(err && err.message ? err.message : err).split('\n')[0];

const queryQmd = (text, cfg) => {
  try {
    const stdout = execFileSync(cfg.qmd, buildQueryArgs(text, cfg), {
      cwd: cfg.indexDir,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout);
    return { results: Array.isArray(parsed) ? parsed : [], failed: false };
  } catch (err) {
    process.stderr.write(`${firstLine(err)}\n`);
    return { results: [], failed: true };
  }
};

/** Chunks -> documents: first occurrence wins, then truncate to depth. */
const rollupDocs = (results, depth) => {
  const docIds = results.map((r) => basename(String(r.file), '.md'));
  return docIds.filter((id, index) => docIds.indexOf(id) === index).slice(0, depth);
};

const processTopic = (topic, cfg) => {
  const started = Date.now();
  const { results, failed } = queryQmd(topic.text, cfg);
  const ms = Date.now() - started;
  const ranking = rollupDocs(results, cfg.depth);
  appendFileSync(cfg.outRaw, `${JSON.stringify({ queryId: topic._id, text: topic.text, ms, results })}\n`);
  process.stderr.write(`${topic._id}: ${results.length} chunks → ${ranking.length} docs (${ms} ms)\n`);
  return { queryId: topic._id, ms, failed, chunks: results.length, ranking };
};

const trecLines = (record, tag) =>
  record.ranking.map((docId, index) =>
    `${record.queryId} Q0 ${docId} ${index + 1} ${record.ranking.length - index} ${tag}`);

const percentile = (sortedMs, q) => {
  if (sortedMs.length === 0) return 0;
  const at = Math.min(Math.floor(q * sortedMs.length), sortedMs.length - 1);
  return sortedMs[at];
};

const maxOf = (values) => values.reduce((acc, v) => (v > acc ? v : acc), 0);

const summarize = (records) => {
  const sortedMs = records.map((r) => r.ms).sort((a, b) => a - b);
  return {
    topics: records.length,
    failures: records.filter((r) => r.failed).length,
    queryMs: sortedMs.reduce((acc, v) => acc + v, 0),
    queryP50Ms: percentile(sortedMs, 0.5),
    queryP95Ms: percentile(sortedMs, 0.95),
    chunksReturnedMax: maxOf(records.map((r) => r.chunks)),
    docsReturnedMax: maxOf(records.map((r) => r.ranking.length)),
  };
};

const prepareOutputs = (cfg) => {
  mkdirSync(dirname(cfg.outRun), { recursive: true });
  mkdirSync(dirname(cfg.outRaw), { recursive: true });
  writeFileSync(cfg.outRaw, '');
};

const main = () => {
  const missing = missingFlags();
  if (missing.length > 0) {
    process.stderr.write(`qmd-arm: required flag(s) missing: ${missing.join(' ')}\n`);
    process.exit(2);
  }
  const cfg = parseArgs();
  prepareOutputs(cfg);
  const records = [];
  // Sequential and back-to-back on purpose: a cold model reload between topics
  // would contaminate the p50 this arm reports.
  for (const topic of readTopics(cfg.queries)) records.push(processTopic(topic, cfg));
  const lines = records.flatMap((record) => trecLines(record, cfg.tag));
  writeFileSync(cfg.outRun, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  process.stdout.write(`${JSON.stringify(summarize(records))}\n`);
  process.exitCode = records.some((r) => r.failed) ? 3 : 0;
};

main();
