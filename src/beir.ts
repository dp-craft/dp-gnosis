/**
 * Readers for the BEIR on-disk layout: `corpus.jsonl`, `queries.jsonl` and
 * `qrels/<split>.tsv`.
 *
 * The parsing is lifted verbatim from the external suite's proven harness
 * (`docs/benchmarks/2026-08-14-external-suite/harness/runBeirPipeline.ts:42-65`)
 * — same `_id`/`title`/`text` projection, same tab-separated qrels with the
 * header row skipped by matching `query-id`. It is copied rather than
 * re-derived so the numbers stay comparable with the recorded baseline.
 *
 * WHAT is parsed is still that verbatim projection; only HOW the bytes reach it
 * changed. `readFileSync(path,'utf8')` cannot hold a corpus above Node's
 * 0x1fffffe8 (~0.5 GB) single-string cap — `webis-touche2020` is 0.69 GB and
 * threw before parsing — so the jsonl files stream through `lines.ts`, whose
 * line semantics are pinned against the old expression.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertNoIdCollisions, safeDocId } from './docId.js';
import { mapNonEmptyLines } from './lines.js';
import type { Qrel } from './metrics.js';

export type { Qrel } from './metrics.js';

/** The three BEIR corpus fields the harness reads. */
export interface BeirDoc {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

const CORPUS_FILE = 'corpus.jsonl';
const QUERIES_FILE = 'queries.jsonl';
const QRELS_DIR = 'qrels';
const QRELS_HEADER_ID = 'query-id';

const readJsonl = (path: string): readonly Record<string, unknown>[] =>
  mapNonEmptyLines(path, line => JSON.parse(line) as Record<string, unknown>);

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const toDoc = (row: Readonly<Record<string, unknown>>): BeirDoc => ({
  id: asString(row['_id']),
  title: asString(row['title']),
  text: asString(row['text']),
});

const toSafeDoc = (doc: BeirDoc): BeirDoc => ({ ...doc, id: safeDocId(doc.id) });

/**
 * Every corpus document, in file order. Rows without an `_id` are dropped.
 *
 * Ids come back MAPPED through `safeDocId` — the identity on every dataset whose
 * ids are already filename-safe, and the only reason `webis-touche2020` (whose
 * ids all embed a `:`) can be materialised at all. `readQrels` maps through the
 * same function, so the qrels join is preserved; a mapping that merged two
 * documents refuses here rather than corrupting the dataset's metrics.
 */
export const readCorpus = (dir: string): readonly BeirDoc[] => {
  const docs = readJsonl(resolve(dir, CORPUS_FILE))
    .map(toDoc)
    .filter(doc => doc.id.length > 0);
  assertNoIdCollisions(docs.map(doc => doc.id));
  return docs.map(toSafeDoc);
};

/** Query id → query text. */
export const readQueries = (dir: string): ReadonlyMap<string, string> =>
  new Map(
    readJsonl(resolve(dir, QUERIES_FILE)).map(row => [asString(row['_id']), asString(row['text'])])
  );

/**
 * Tab-separated WITH a header row, which is skipped by matching the header text.
 * The `corpus-id` column goes through the SAME `safeDocId` as the corpus — the
 * judgments must be keyed on the ids `score.ts` recovers from the atoms, or the
 * dataset would score zero against a corpus it fully covers.
 */
export const readQrels = (dir: string, split: string): ReadonlyMap<string, Qrel> =>
  readFileSync(resolve(dir, QRELS_DIR, `${split}.tsv`), 'utf8')
    .split('\n')
    .map(line => line.split('\t'))
    .filter(cols => cols.length >= 3 && cols[0] !== QRELS_HEADER_ID)
    .reduce((acc, cols) => {
      const perQuery = acc.get(cols[0]!) ?? new Map<string, number>();
      perQuery.set(safeDocId(cols[1]!), Number(cols[2]));
      return acc.set(cols[0]!, perQuery);
    }, new Map<string, Map<string, number>>());
