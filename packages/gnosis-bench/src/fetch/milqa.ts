/**
 * `milqa` — SzegedAI/MILQA (Hungarian Wikipedia QA, SQuAD 2.0 layout) converted
 * into the BEIR layout on disk.
 *
 * WHY THIS DATASET EXISTS HERE. `vault-hu` is the only Hungarian corpus the
 * suite carries and it holds 31 topics, an MDE of 0.05–0.07 (`handbook/GNOSIS-BENCH.md`
 * § Known harness gaps). At that power a Hungarian analyzer question, a PRF cell
 * or a stemming change cannot be DECIDED — every result reads "cannot tell", and
 * a null on it has repeatedly been mistaken for "no difference". MILQA carries
 * 16 885 answerable questions over 2 191 paragraphs, so its detectable effect is
 * far smaller and its random R@100 floor is 0.0456 against `vault-hu`'s 0.2203.
 *
 * IT IS A **LANGUAGE** PROBE, NOT A PRODUCT PROXY. The documents are encyclopedic
 * Wikipedia prose; the served vault is technical notes, code identifiers and
 * runbooks. So a MILQA result answers "does this analysis chain handle Hungarian
 * morphology" and NOTHING about topical or domain behaviour on the product
 * corpus. A conclusion MUST NOT be carried across the two — the same rule that
 * keeps a BEIR number out of a vault claim.
 *
 * THREE CONVERSION DECISIONS, each load-bearing and each visible in the numbers:
 *
 * 1. **Unanswerable questions are DROPPED.** MILQA marks ~28 % of its questions
 *    `is_impossible` — a question the paragraph deliberately does NOT answer.
 *    Keeping them would put two incompatible relevance definitions in one qrels
 *    file ("this paragraph answers it" and "this paragraph is the one it is
 *    about"), and nDCG cannot be read when the judgments mean two things. They
 *    are dropped so the qrels state ONE definition.
 * 2. **Granularity is the PARAGRAPH, not the article.** MILQA holds 140 articles;
 *    an article-level corpus would be 140 documents, at which point R@100 is
 *    nearly a constant and the dataset measures nothing. Paragraphs give 2 191
 *    documents at roughly one atom each, which is also the unit the annotators
 *    actually judged against.
 * 3. **Paragraphs are deduplicated across the splits, FIRST occurrence wins.**
 *    The published train and test splits OVERLAP — all 36 test articles also
 *    appear in train — so a naive flatten would put the same paragraph in the
 *    corpus twice under two ids, split its relevance judgments between them and
 *    understate recall. The questions of a dropped duplicate are NOT lost: they
 *    are re-pointed at the surviving document, then deduplicated themselves on
 *    (question text, document id) so the overlap cannot double-count a topic.
 *
 * The document id is a slug of the article title plus a per-article running
 * paragraph index (`abszint-p03`), not a hash: a readable id is what makes a
 * per-topic TSV inspectable by a Hungarian reader, and `docId.ts:safeDocId` is
 * the IDENTITY on it. A collision REFUSES rather than merging two paragraphs
 * into one document — the exact failure `assertNoIdCollisions` exists to stop.
 *
 * The corpus text opens with `# <article> > <section>` because that is the vault
 * ATOM convention: an atom carries its heading line in the indexed body
 * (`handbook/GNOSIS-GUIDE.md` § heading composition), so a corpus built without one would
 * measure a body shape the engine never sees in production.
 *
 * IDEMPOTENT like every fetcher here: a `corpus.jsonl` already on disk means the
 * dataset is present, and nothing is requested.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { MilqaDataset } from '../manifest.js';

const CORPUS_FILE = 'corpus.jsonl';
const QUERIES_FILE = 'queries.jsonl';
const QRELS_DIR = 'qrels';

/** `run.ts` scores this entry under the split its manifest `qrels` names. */
const QRELS_SPLIT = 'test';
const QRELS_HEADER = 'query-id\tcorpus-id\tscore';

/** Every judgment is "this paragraph answers this question" — binary, grade 1. */
const QRELS_GRADE = 1;

/**
 * The two published split files, PINNED by their release date. MILQA is a
 * living repository; an unpinned `train.json` would silently re-download a
 * different corpus under the same manifest entry and every recorded row would
 * stop being reproducible. Read in this order: train first, so a paragraph
 * shared with test keeps its train id.
 */
const TRAIN_FILE = 'train.MILQA-2023-03-27.squad.s.json';
const TEST_FILE = 'test.MILQA-2023-03-27.squad.s.json';
export const MILQA_SPLIT_FILES: readonly string[] = [TRAIN_FILE, TEST_FILE];

/** The reporting facet every MILQA topic carries — the suite's only per-axis key. */
const QUERY_AXIS = 'hungarian-wiki-qa';

/** `mq-00001` — width chosen so 16 885 topics sort lexicographically. */
const QUERY_ID_PREFIX = 'mq-';
const QUERY_ID_DIGITS = 5;

/** `abszint-p03` — two digits covers the longest article (39 paragraphs). */
const PARAGRAPH_ID_INFIX = '-p';
const PARAGRAPH_ID_DIGITS = 2;

/** Slug budget, leaving the `-pNN` suffix inside `docId.ts`'s 200-char ceiling. */
const SLUG_MAX_CHARS = 60;

const COMBINING_MARKS = /[̀-ͯ]/g;
const NON_SLUG_CHARS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const WHITESPACE_RUN = /\s+/g;

const SECTION_SEPARATOR = ' > ';
const HEADING_PREFIX = '# ';
const HEADING_GAP = '\n\n';

/** The dedupe key joiner — a NUL occurs in neither field it separates. */
const KEY_SEPARATOR = '\u0000';

type Json = Readonly<Record<string, unknown>>;

/** One paragraph as the SQuAD file states it, already bound to its article. */
interface RawParagraph {
  readonly articleTitle: string;
  readonly section: string;
  readonly context: string;
  readonly questions: readonly string[];
}

/** A paragraph after dedupe and id assignment — one corpus row. */
interface MilqaDoc {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/** A judged pair — one queries row and one qrels row. */
interface MilqaTopic {
  readonly id: string;
  readonly text: string;
  readonly docId: string;
}

/** The three BEIR artefacts, as file bodies. */
export interface MilqaFiles {
  readonly corpus: string;
  readonly queries: string;
  readonly qrels: string;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const str = (row: Json, key: string): string => {
  const value = row[key];
  return isString(value) ? value : '';
};

const records = (value: unknown): readonly Json[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/**
 * A question is kept unless it is EXPLICITLY unanswerable. Tested against
 * `!== true` rather than `=== false`: an absent flag means answerable in SQuAD
 * 2.0, and a `=== false` test would silently drop every row that omits it.
 */
const answerableQuestions = (paragraph: Json): readonly string[] =>
  records(paragraph['qas'])
    .filter(qa => qa['is_impossible'] !== true)
    .map(qa => str(qa, 'question').replace(WHITESPACE_RUN, ' ').trim())
    .filter(question => question.length > 0);

const paragraphsOf = (article: Json): readonly RawParagraph[] => {
  const articleTitle = str(article, 'title');
  return records(article['paragraphs']).map(paragraph => ({
    articleTitle,
    section: str(paragraph, 'section').trim(),
    context: str(paragraph, 'context').trim(),
    questions: answerableQuestions(paragraph),
  }));
};

/**
 * Every paragraph of every split, in FILE ORDER. Order is the dedupe rule's
 * whole content — first occurrence wins — so it MUST NOT be sorted or grouped.
 */
const flattenSplits = (splits: readonly unknown[]): readonly RawParagraph[] =>
  splits.flatMap(split => records(isRecord(split) ? split['data'] : undefined))
    .flatMap(paragraphsOf);

/**
 * NFKD, marks stripped, lowercased, everything else collapsed to a single dash.
 * Decomposing first is what makes `könyvei` → `konyvei` instead of `k-nyvei`:
 * Hungarian carries ő/ű, whose combining marks a straight `[^a-z0-9]` replace
 * would turn into separators and merge two articles onto one slug.
 */
export const slugify = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_SLUG_CHARS, '-')
    .replace(EDGE_DASHES, '')
    .slice(0, SLUG_MAX_CHARS);

const docIdOf = (articleTitle: string, ordinal: number): string =>
  `${slugify(articleTitle)}${PARAGRAPH_ID_INFIX}${String(ordinal).padStart(PARAGRAPH_ID_DIGITS, '0')}`;

const dedupeKeyOf = (paragraph: RawParagraph): string =>
  `${paragraph.articleTitle}${KEY_SEPARATOR}${paragraph.context}`;

const headingOf = (paragraph: RawParagraph): string =>
  paragraph.section.length > 0
    ? `${paragraph.articleTitle}${SECTION_SEPARATOR}${paragraph.section}`
    : paragraph.articleTitle;

/**
 * The corpus row's `title` is the NARROWEST heading the paragraph carries — its
 * section when it has one, the article otherwise. The article is not lost: it is
 * in the body's heading line, which is the string the index actually reads.
 */
const titleOf = (paragraph: RawParagraph): string =>
  paragraph.section.length > 0 ? paragraph.section : paragraph.articleTitle;

const bodyOf = (paragraph: RawParagraph): string =>
  `${HEADING_PREFIX}${headingOf(paragraph)}${HEADING_GAP}${paragraph.context}`;

const collisionMessage = (docId: string, first: string, second: string): string =>
  `dp-gnosis-bench: MILQA paragraphs from ${JSON.stringify(first)} and ` +
  `${JSON.stringify(second)} both map to the document id ${JSON.stringify(docId)}. Two ` +
  'paragraphs would merge into one document and every metric for this dataset would be ' +
  'wrong, so this refuses rather than scoring a corpus that is not the one named. Raise ' +
  'SLUG_MAX_CHARS or PARAGRAPH_ID_DIGITS in fetch/milqa.ts so the ids stay distinct.';

/**
 * The surviving paragraph for each (article, context) pair, with its document
 * id. The running ordinal counts DEDUPED paragraphs of that article, so an id
 * never numbers a paragraph the corpus does not carry — and a `Map` keyed on
 * the article title makes it independent of how the splits interleave.
 */
const assignIds = (
  paragraphs: readonly RawParagraph[]
): ReadonlyMap<string, MilqaDoc> => {
  const ordinals = new Map<string, number>();
  const byId = new Map<string, string>();
  return paragraphs.reduce((docs, paragraph) => {
    const key = dedupeKeyOf(paragraph);
    if (docs.has(key)) return docs;
    const ordinal = ordinals.get(paragraph.articleTitle) ?? 0;
    ordinals.set(paragraph.articleTitle, ordinal + 1);
    const id = docIdOf(paragraph.articleTitle, ordinal);
    const previous = byId.get(id);
    if (previous !== undefined) throw new Error(collisionMessage(id, previous, key));
    byId.set(id, key);
    return docs.set(key, { id, title: titleOf(paragraph), text: bodyOf(paragraph) });
  }, new Map<string, MilqaDoc>());
};

const queryId = (index: number): string =>
  `${QUERY_ID_PREFIX}${String(index + 1).padStart(QUERY_ID_DIGITS, '0')}`;

/**
 * Every answerable question, pointed at the document that SURVIVED dedupe and
 * then deduplicated itself on (question, document): the split overlap repeats a
 * paragraph's whole question list, and two identical topics would count one
 * result twice in every macro-average this suite reports.
 */
const collectTopics = (
  paragraphs: readonly RawParagraph[],
  docs: ReadonlyMap<string, MilqaDoc>
): readonly MilqaTopic[] => {
  const seen = new Set<string>();
  return paragraphs
    .flatMap(paragraph =>
      paragraph.questions.map(text => ({
        text,
        docId: docs.get(dedupeKeyOf(paragraph))?.id ?? '',
      }))
    )
    .filter(pair => {
      const key = `${pair.text}${KEY_SEPARATOR}${pair.docId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((pair, index) => ({ id: queryId(index), text: pair.text, docId: pair.docId }));
};

const corpusLine = (doc: MilqaDoc): string =>
  JSON.stringify({ _id: doc.id, title: doc.title, text: doc.text });

const queryLine = (topic: MilqaTopic): string =>
  JSON.stringify({ _id: topic.id, text: topic.text, axis: QUERY_AXIS });

const qrelLine = (topic: MilqaTopic): string =>
  `${topic.id}\t${topic.docId}\t${QRELS_GRADE}`;

/**
 * The BEIR bodies for the whole dataset, from the parsed split files in read
 * order. Pure, so the entire conversion — dedupe, id scheme, the
 * `is_impossible` drop and the qrels alignment — is testable with no network.
 */
export const buildMilqaFiles = (splits: readonly unknown[]): MilqaFiles => {
  const paragraphs = flattenSplits(splits);
  const docs = assignIds(paragraphs);
  const topics = collectTopics(paragraphs, docs);
  return {
    corpus: [...docs.values()].map(corpusLine).join('\n').concat('\n'),
    queries: topics.map(queryLine).join('\n').concat('\n'),
    qrels: [QRELS_HEADER, ...topics.map(qrelLine)].join('\n').concat('\n'),
  };
};

const downloadFailed = (entry: MilqaDataset, url: string, status: number): string =>
  `dp-gnosis-bench: dataset "${entry.id}" download failed with HTTP ${status} for ${url} — ` +
  'check "source" in datasets.json against the MILQA repository, or disable the entry';

const fetchSplit = async (entry: MilqaDataset, file: string): Promise<unknown> => {
  const url = `${entry.source}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(downloadFailed(entry, url, response.status));
  return (await response.json()) as unknown;
};

const writeFiles = (dir: string, files: MilqaFiles): void => {
  mkdirSync(resolve(dir, QRELS_DIR), { recursive: true });
  writeFileSync(resolve(dir, CORPUS_FILE), files.corpus, 'utf8');
  writeFileSync(resolve(dir, QUERIES_FILE), files.queries, 'utf8');
  writeFileSync(resolve(dir, QRELS_DIR, `${QRELS_SPLIT}.tsv`), files.qrels, 'utf8');
};

/**
 * Materialise the dataset into `<dataDir>/<entry.id>` unless its `corpus.jsonl`
 * is already there. The presence check is the CORPUS file, not the directory:
 * an aborted write leaves a directory behind, and treating that as "done" would
 * score a truncated corpus and record the number as if it were comparable.
 */
export const ensureMilqaDataset = async (
  entry: MilqaDataset,
  dataDir: string
): Promise<void> => {
  const dir = resolve(dataDir, entry.id);
  if (existsSync(resolve(dir, CORPUS_FILE))) return;
  console.log(`dp-gnosis-bench: downloading MILQA splits from ${entry.source}`);
  const splits = await Promise.all(MILQA_SPLIT_FILES.map(file => fetchSplit(entry, file)));
  writeFiles(dir, buildMilqaFiles(splits));
};
