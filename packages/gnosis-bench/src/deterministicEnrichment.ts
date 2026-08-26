/**
 * `gnosis:detenrich` — Track W's DETERMINISTIC ENRICHMENT PRODUCER (W1 + W4).
 *
 * It answers one question: is an LLM needed to produce the `questions` column
 * at all? The recorded arm `A_questions` (`--field-weights questions=1`,
 * nDCG@10 0.3369) is the control. This script writes two challengers that are
 * the SAME sidecar with ONE field mutated, so the contrast is exact:
 *
 * - `enrichment-w1-idf.jsonl` — `questions` becomes the document's own top-86
 *   body terms by corpus IDF, rarest first, as a single space-joined string.
 * - `enrichment-w4-nofiller.jsonl` — `questions` becomes the EXISTING LLM
 *   questions with every occurrence of the corpus's 50 commonest terms
 *   removed, each question still its own element, an emptied question dropped.
 *
 * WHY 86. The `questions` column holds 448 291 tokens over 3 605 documents =
 * 124 tokens/document, of which 30.6 % are the 50 commonest terms, leaving ~86
 * informative. W4 removes exactly that 30.6 %, so the two arms are
 * TOKEN-MATCHED by construction and the pair measures SELECTION, not length.
 *
 * EVERY OTHER FIELD IS COPIED THROUGH UNCHANGED. The records are re-serialized
 * by {@link serializeEnrichmentRecord}, the same canonical sorted-key writer
 * that produced the source, so a non-`questions` byte cannot move.
 *
 * NON-IDEMPOTENCY, the landmine this path must not step on: 822 of 19 098
 * nfcorpus terms (4.3 %) CHANGE under a second `analyze()` pass. So each side
 * enters analysed space exactly once and by one route only — a `fts5vocab`
 * term is ALREADY analysed and is compared BYTE FOR BYTE, never re-analysed;
 * raw corpus text and raw question tokens are analysed HERE, once, under the
 * chain STAMPED into the index ({@link readIndexAnalyzer}), never an assumed
 * `porter-fold`.
 *
 * WRITES NOTHING IT WAS NOT ASKED TO. The index is opened `readonly` and the
 * `fts5vocab` handle is a TEMP virtual table living in that connection's own
 * temp database; the source sidecar is only read.
 *
 * EXIT CODES: 0 — both sidecars were written. 2 — unusable invocation, or an
 * unreadable index / corpus / sidecar, or a sidecar record that joins to no
 * corpus document (a silently shrinking denominator is refused, not absorbed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { FTS_TABLE, readIndexAnalyzer } from '../../gnosis/src/adapters/fts5Adapter.js';
import {
  type EnrichmentRecord,
  parseEnrichmentLine,
  serializeEnrichmentRecord
} from '../../gnosis/src/enrichment.js';
import { analyze, type AnalyzerId } from '../../gnosis/src/query.js';

/** Both sidecars were written. */
export const DET_ENRICH_EXIT_OK = 0;

/** Unusable invocation, or an unreadable / unjoinable input. */
export const DET_ENRICH_EXIT_USAGE = 2;

/** W1's N — the informative-token budget derived in this module's docblock. */
export const IDF_TERM_COUNT = 86;

/** W4's filler set size — the corpus's commonest terms, by document frequency. */
export const FILLER_TERM_COUNT = 50;

export const W1_FILENAME = 'enrichment-w1-idf.jsonl';
export const W4_FILENAME = 'enrichment-w4-nofiller.jsonl';

const VOCAB_TABLE = 'gnosis_detenrich_vocab';

const CREATE_VOCAB_SQL =
  `CREATE VIRTUAL TABLE temp.${VOCAB_TABLE} USING fts5vocab(main, ${FTS_TABLE}, 'row')`;

const SELECT_VOCAB_SQL = `SELECT term AS term, doc AS doc FROM temp.${VOCAB_TABLE}`;

const WHITESPACE_RE = /\s+/;

/** One already-analysed index term and the number of rows holding it. */
export interface VocabTerm {
  readonly term: string;
  /** `fts5vocab`'s `doc` — document frequency, the inverse of IDF. */
  readonly doc: number;
}

/** Everything both arms need, read once. */
export interface DeterministicContext {
  /** Analysed term -> document frequency, for every term the index holds. */
  readonly frequency: ReadonlyMap<string, number>;
  /** The {@link FILLER_TERM_COUNT} commonest analysed terms. */
  readonly filler: ReadonlySet<string>;
  /** The chain the index is STAMPED with — never a chain chosen here. */
  readonly analyzer: AnalyzerId;
  /** Lowercased BEIR `_id` -> that document's `title text`. */
  readonly corpus: ReadonlyMap<string, string>;
}

/** What one sidecar file yielded, with the losses counted rather than hidden. */
export interface SidecarRead {
  readonly records: readonly EnrichmentRecord[];
  readonly skipped: number;
}

export interface DetEnrichArgs {
  readonly indexPath: string;
  readonly corpusPath: string;
  readonly sidecarPath: string;
  readonly outDir?: string | undefined;
}

export const DET_ENRICH_HELP = [
  'gnosis:detenrich — write the W1 (IDF) and W4 (filler-stripped) enrichment sidecars.',
  '',
  'usage: npm run gnosis:detenrich -- --index <index.sqlite> --corpus <corpus.jsonl>',
  '                                  --sidecar <enrichment.jsonl> [--out <dir>]',
  '',
  '  --index    the fts5 index whose vocabulary supplies IDF; opened READ-ONLY',
  '  --corpus   the BEIR corpus JSONL the sidecar records join to by id',
  '  --sidecar  the SOURCE enrichment sidecar; only read, never modified',
  `  --out      directory for ${W1_FILENAME} and ${W4_FILENAME}`,
  '             (default: beside --sidecar)',
  '',
  'Only the `questions` column differs from the source; every other field is copied through.',
  'The analyser is read off the index stamp, never chosen here.',
  '',
  'exit codes:',
  `  ${DET_ENRICH_EXIT_OK}  both sidecars were written`,
  `  ${DET_ENRICH_EXIT_USAGE}  unusable invocation, or an unreadable / unjoinable input`,
  '',
].join('\n');

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const isBlank = (line: string): boolean => line.trim().length === 0;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const tokensOf = (text: string): readonly string[] =>
  text.split(WHITESPACE_RE).filter(token => token.length > 0);

/** Codepoint order, not `localeCompare` — a tie-break that changes with a locale is not one. */
const compareTerms = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Read every term of the index vocabulary. The terms come back ALREADY
 * ANALYSED and are used verbatim from here on.
 */
export const readVocabulary = (indexPath: string): readonly VocabTerm[] => {
  const db = new Database(indexPath, { readonly: true });
  db.exec(CREATE_VOCAB_SQL);
  const rows = db.prepare(SELECT_VOCAB_SQL).all() as readonly VocabTerm[];
  db.close();
  return rows;
};

export const documentFrequencies = (
  vocabulary: readonly VocabTerm[]
): ReadonlyMap<string, number> => new Map(vocabulary.map(entry => [entry.term, entry.doc]));

/** Commonest = HIGHEST `doc`; ties broken lexicographically, never by row order. */
export const commonestTerms = (
  vocabulary: readonly VocabTerm[],
  count: number
): readonly string[] =>
  [...vocabulary]
    .sort((left, right) =>
      left.doc === right.doc ? compareTerms(left.term, right.term) : right.doc - left.doc)
    .slice(0, count)
    .map(entry => entry.term);

const byRarity = (
  frequency: ReadonlyMap<string, number>
): ((left: string, right: string) => number) => (left, right) => {
  const leftDoc = frequency.get(left) ?? 0;
  const rightDoc = frequency.get(right) ?? 0;
  return leftDoc === rightDoc ? compareTerms(left, right) : leftDoc - rightDoc;
};

/**
 * The document's own distinct terms, rarest first, capped at `limit`. A term
 * the index does not hold is DROPPED rather than ranked first: its posting
 * list is empty, so it can reach nothing and would spend budget out of the
 * `limit` informative slots this arm is allowed. Fewer than `limit` distinct
 * terms yields all of them.
 */
export const rarestTerms = (
  bodyTerms: readonly string[],
  frequency: ReadonlyMap<string, number>,
  limit: number
): readonly string[] =>
  [...new Set(bodyTerms)]
    .filter(term => frequency.has(term))
    .sort(byRarity(frequency))
    .slice(0, limit);

/** W1's column: ONE element holding the selected terms, space-joined, rarest first. */
export const idfQuestions = (
  bodyTerms: readonly string[],
  frequency: ReadonlyMap<string, number>,
  limit: number
): readonly string[] => {
  const terms = rarestTerms(bodyTerms, frequency, limit);
  return terms.length === 0 ? [] : [terms.join(' ')];
};

/**
 * Is this RAW token one of the filler terms? The token is analysed here, once;
 * the filler set came out of the index and is matched byte for byte. A token
 * that analyses to nothing (punctuation) carries no index signal and is kept —
 * removing it would change more than the terms this arm names.
 */
const isFillerToken = (
  token: string,
  filler: ReadonlySet<string>,
  analyzer: AnalyzerId
): boolean => {
  const terms = analyze(token, analyzer);
  return terms.length > 0 && terms.every(term => filler.has(term));
};

export const stripFiller = (
  question: string,
  filler: ReadonlySet<string>,
  analyzer: AnalyzerId
): string => tokensOf(question).filter(token => !isFillerToken(token, filler, analyzer)).join(' ');

/** W4's column: each question kept as its own element, an emptied question dropped. */
export const withoutFillerTerms = (
  questions: readonly string[],
  filler: ReadonlySet<string>,
  analyzer: AnalyzerId
): readonly string[] =>
  questions.map(question => stripFiller(question, filler, analyzer)).filter(text => text.length > 0);

/** The single mutation both arms are allowed. */
export const withQuestions = (
  record: EnrichmentRecord,
  questions: readonly string[]
): EnrichmentRecord => ({ ...record, questions });

const toCorpusEntry = (line: string): readonly [string, string] => {
  const row = JSON.parse(line) as Readonly<Record<string, unknown>>;
  return [
    asString(row['_id']).toLowerCase(),
    `${asString(row['title'])} ${asString(row['text'])}`,
  ];
};

export const readCorpusText = (corpusPath: string): ReadonlyMap<string, string> =>
  new Map(readFileSync(corpusPath, 'utf8').split('\n').filter(line => !isBlank(line)).map(toCorpusEntry));

/**
 * The join. A sidecar id is `slugify(<docId> <title>)`, truncated on a segment
 * boundary, so the document id is a hyphen-segment PREFIX of it. The LONGEST
 * prefix the corpus knows wins — the most specific match, and the only one
 * that cannot be an accident of a shorter id sharing a stem.
 */
export const documentKeyOf = (
  sidecarId: string,
  corpus: ReadonlyMap<string, string>
): string | undefined => {
  const segments = sidecarId.split('-');
  return segments
    .map((_segment, index) => segments.slice(0, segments.length - index).join('-'))
    .find(candidate => corpus.has(candidate));
};

/**
 * A malformed line is SKIPPED and COUNTED, never thrown — the behaviour
 * `loadEnrichmentSidecar` already has, and the reason this reads through
 * `parseEnrichmentLine` rather than its own `JSON.parse`.
 */
export const readSidecar = (sidecarPath: string): SidecarRead => {
  const parsed = readFileSync(sidecarPath, 'utf8')
    .split('\n')
    .filter(line => !isBlank(line))
    .map(parseEnrichmentLine);
  return {
    records: parsed.filter(isDefined),
    skipped: parsed.filter(record => record === undefined).length,
  };
};

export const w1QuestionsFor = (
  record: EnrichmentRecord,
  context: DeterministicContext
): readonly string[] => {
  const key = documentKeyOf(record.id, context.corpus);
  const text = key === undefined ? undefined : context.corpus.get(key);
  if (text === undefined) {
    throw new Error(`no corpus document joins sidecar id "${record.id}"`);
  }
  return idfQuestions(analyze(text, context.analyzer), context.frequency, IDF_TERM_COUNT);
};

export const readContext = (args: DetEnrichArgs): DeterministicContext => {
  const indexPath = resolve(args.indexPath);
  const vocabulary = readVocabulary(indexPath);
  return {
    frequency: documentFrequencies(vocabulary),
    filler: new Set(commonestTerms(vocabulary, FILLER_TERM_COUNT)),
    analyzer: readIndexAnalyzer(indexPath),
    corpus: readCorpusText(resolve(args.corpusPath)),
  };
};

/** Whitespace tokens of the whole column — the unit the 124/document figure is in. */
export const questionTokenCount = (questions: readonly string[]): number =>
  tokensOf(questions.join(' ')).length;

const meanTokens = (records: readonly EnrichmentRecord[]): number =>
  records.length === 0
    ? 0
    : records.reduce((sum, record) => sum + questionTokenCount(record.questions), 0) /
      records.length;

const armReport = (name: string, records: readonly EnrichmentRecord[]): string =>
  `${name}: ${records.length} records, mean ${meanTokens(records).toFixed(1)} question tokens/document\n` +
  `${name}: first questions = ${JSON.stringify(records[0]?.questions ?? [])}\n`;

const writeSidecar = (path: string, records: readonly EnrichmentRecord[]): void => {
  writeFileSync(path, records.map(serializeEnrichmentRecord).join(''), 'utf8');
};

const flagValue = (argv: readonly string[], flag: string): string | undefined =>
  argv.flatMap((token, index) => (token === flag ? [argv[index + 1] ?? ''] : []))
    .filter(value => value.length > 0)
    .at(-1);

/** The three flags with no default; absent any one of them, the invocation is unusable. */
const requiredPaths = (
  argv: readonly string[]
): Omit<DetEnrichArgs, 'outDir'> | undefined => {
  const indexPath = flagValue(argv, '--index');
  const corpusPath = flagValue(argv, '--corpus');
  const sidecarPath = flagValue(argv, '--sidecar');
  return indexPath === undefined || corpusPath === undefined || sidecarPath === undefined
    ? undefined
    : { indexPath, corpusPath, sidecarPath };
};

export const parseDetEnrichArgs = (argv: readonly string[]): DetEnrichArgs | undefined => {
  const paths = argv.includes('--help') ? undefined : requiredPaths(argv);
  return paths === undefined ? undefined : { ...paths, outDir: flagValue(argv, '--out') };
};

const run = (args: DetEnrichArgs): number => {
  const context = readContext(args);
  const sidecarPath = resolve(args.sidecarPath);
  const sidecar = readSidecar(sidecarPath);
  const outDir = args.outDir === undefined ? dirname(sidecarPath) : resolve(args.outDir);
  const w1 = sidecar.records.map(record => withQuestions(record, w1QuestionsFor(record, context)));
  const w4 = sidecar.records.map(record =>
    withQuestions(record, withoutFillerTerms(record.questions, context.filler, context.analyzer)));
  writeSidecar(join(outDir, W1_FILENAME), w1);
  writeSidecar(join(outDir, W4_FILENAME), w4);
  process.stdout.write(
    `source: ${sidecar.records.length} records, ${sidecar.skipped} malformed line(s) skipped\n` +
    armReport(W1_FILENAME, w1) + armReport(W4_FILENAME, w4));
  return DET_ENRICH_EXIT_OK;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const main = (argv: readonly string[]): number => {
  const args = parseDetEnrichArgs(argv);
  if (args === undefined) {
    process.stdout.write(DET_ENRICH_HELP);
    return DET_ENRICH_EXIT_USAGE;
  }
  try {
    return run(args);
  } catch (error) {
    process.stderr.write(`gnosis:detenrich: ${messageOf(error)}\n`);
    return DET_ENRICH_EXIT_USAGE;
  }
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
