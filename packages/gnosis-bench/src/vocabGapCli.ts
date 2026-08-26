/**
 * `gnosis:vocabgap` — C11a's OFFLINE AGGREGATE. The retrieve-path warning says
 * "this query has a hole"; this says how big the hole is across a whole topic
 * set, which is the evidence C11b is conditional on (finalization plan
 * § 2.9.3).
 *
 * Three rules, the `gnosis:goldaudit` ones:
 *
 * 1. It MEASURES ONLY. It opens the index `readonly`, ingests nothing, builds
 *    nothing, calls no model and touches no GPU. Re-runnable as often as wanted
 *    against a live index.
 * 2. Both inputs are EXPLICIT — `--index` and `--queries` — so the same tool
 *    points at a bench dataset's `queries.jsonl` and at the real vault's golden
 *    set with no code path that differs between them.
 * 3. The ANALYSER is not a flag. It is read off the index's own stamp
 *    (`readIndexAnalyzer`), because a diagnostic run under a chain the searcher
 *    would not use reports a hole its own analysis invented.
 *
 * OUTPUT: JSONL, one record per topic, so a partial run is still readable and
 * the result joins to a `.trec` run or a qrels file by `topicId` with no parser.
 *
 * EXIT CODES: 0 — the measurement ran (a large gap still exits 0; the verdict is
 * the data, not the status). 2 — unusable invocation, or an unreadable index or
 * queries file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readIndexAnalyzer } from '../../gnosis/src/adapters/fts5Adapter.js';
import {
  type QueryTermPostings,
  readVocabularyGap
} from '../../gnosis/src/adapters/fts5VocabularyGap.js';

/** The measurement ran and every topic was reported. */
export const VOCAB_GAP_EXIT_OK = 0;

/** Unusable invocation, or the index / queries file could not be read. */
export const VOCAB_GAP_EXIT_USAGE = 2;

/** One topic's line of the JSONL report. */
export interface VocabGapRecord {
  readonly topicId: string;
  readonly query: string;
  readonly terms: readonly QueryTermPostings[];
  readonly gapTerms: readonly string[];
  readonly gapCount: number;
  readonly termCount: number;
}

/** One topic as the queries file states it. */
export interface Topic {
  readonly topicId: string;
  readonly query: string;
}

export interface VocabGapArgs {
  readonly indexPath: string;
  readonly queriesPath: string;
  readonly outPath?: string | undefined;
}

export const VOCAB_GAP_HELP = [
  'gnosis:vocabgap — zero-GPU, read-only report of the query terms an fts5 index cannot reach.',
  '',
  'usage: npm run gnosis:vocabgap -- --index <index.sqlite> --queries <queries.jsonl> [--out <path>]',
  '',
  '  --index    the fts5 index to read; opened READ-ONLY, never written',
  '  --queries  a BEIR-shaped queries JSONL ({"_id","text"} per line) — a bench',
  '             dataset\'s queries.jsonl, or the vault golden set\'s',
  '  --out      write the JSONL there instead of stdout',
  '',
  'One JSON record per topic: {topicId, query, terms:[{term,postings}], gapTerms, gapCount, termCount}.',
  'The analyser is read off the index stamp, never chosen here.',
  '',
  'exit codes:',
  `  ${VOCAB_GAP_EXIT_OK}  the measurement ran`,
  `  ${VOCAB_GAP_EXIT_USAGE}  unusable invocation, or an unreadable --index / --queries`,
  '',
].join('\n');

const flagValue = (argv: readonly string[], flag: string): string | undefined =>
  argv.flatMap((token, index) => (token === flag ? [argv[index + 1] ?? ''] : []))
    .filter(value => value.length > 0)
    .at(-1);

export const parseVocabGapArgs = (argv: readonly string[]): VocabGapArgs | undefined => {
  const indexPath = flagValue(argv, '--index');
  const queriesPath = flagValue(argv, '--queries');
  if (indexPath === undefined || queriesPath === undefined || argv.includes('--help')) {
    return undefined;
  }
  return { indexPath, queriesPath, outPath: flagValue(argv, '--out') };
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const toTopic = (line: string): Topic => {
  const row = JSON.parse(line) as Readonly<Record<string, unknown>>;
  return { topicId: asString(row['_id']), query: asString(row['text']) };
};

/**
 * A blank line is skipped; a topic with no id or no text is DROPPED and would
 * be indistinguishable from one that was never there, so it is refused instead
 * — a quietly shrinking denominator is the failure this project keeps hitting.
 */
export const readTopics = (queriesPath: string): readonly Topic[] => {
  const topics = readFileSync(queriesPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(toTopic);
  const bad = topics.filter(topic => topic.topicId.length === 0 || topic.query.length === 0);
  if (bad.length > 0) {
    throw new Error(`${queriesPath}: ${bad.length} line(s) carry no "_id" or no "text"`);
  }
  return topics;
};

/**
 * One topic's record. The QUERY is raw text and enters analysed space exactly
 * once, inside `readVocabularyGap`; nothing here re-analyses anything, and the
 * `terms` handed back are already-analysed index vocabulary that MUST NOT be
 * fed to `toMatchExpression`. See that function's docblock for the 4.3 %
 * non-idempotency measurement.
 */
export const recordFor = (
  indexPath: string,
  analyzer: ReturnType<typeof readIndexAnalyzer>,
  topic: Topic
): VocabGapRecord => {
  const gap = readVocabularyGap(indexPath, topic.query, analyzer);
  return { ...topic, ...gap };
};

export const vocabGapReport = (
  indexPath: string,
  topics: readonly Topic[]
): readonly VocabGapRecord[] => {
  const analyzer = readIndexAnalyzer(indexPath);
  return topics.map(topic => recordFor(indexPath, analyzer, topic));
};

const serialize = (records: readonly VocabGapRecord[]): string =>
  records.map(record => JSON.stringify(record)).join('\n') + '\n';

const emit = (text: string, outPath: string | undefined): void => {
  if (outPath === undefined) process.stdout.write(text);
  else writeFileSync(resolve(outPath), text, 'utf8');
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const main = (argv: readonly string[]): number => {
  const args = parseVocabGapArgs(argv);
  if (args === undefined) {
    process.stdout.write(VOCAB_GAP_HELP);
    return VOCAB_GAP_EXIT_USAGE;
  }
  try {
    const topics = readTopics(resolve(args.queriesPath));
    emit(serialize(vocabGapReport(resolve(args.indexPath), topics)), args.outPath);
    return VOCAB_GAP_EXIT_OK;
  } catch (error) {
    process.stderr.write(`gnosis:vocabgap: ${messageOf(error)}\n`);
    return VOCAB_GAP_EXIT_USAGE;
  }
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
