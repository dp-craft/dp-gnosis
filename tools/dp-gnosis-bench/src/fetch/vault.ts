/**
 * `beir-local` + `derive` — the REAL vault as a dataset, built from material the
 * repo already carries: a directory of ingested atoms plus a hand-authored
 * golden set. Neither is modified; both are read and projected into the BEIR
 * layout `beir.ts` expects.
 *
 * Three decisions, each load-bearing:
 *
 * 1. **The FILENAME is the document id.** `score.ts` maps a retrieved atom back
 *    to a qrels key through its `originPaths` basename, and the golden set's
 *    `relevantAtomIds` are exactly those basenames. Using the frontmatter `id`
 *    instead would break on the collision suffix `resolveId` appends.
 * 2. **An unreachable judgment is KEPT.** A gold id with no atom file cannot be
 *    retrieved, so it caps recall — dropping the row would hide that ceiling and
 *    report a flattered number. The count is returned so the caller can print it.
 * 3. **It re-derives on every run.** The source is local files, so there is
 *    nothing to cache and a stale copy would measure a vault that no longer
 *    exists. This is why it is not shaped like the network fetchers.
 *
 * The frozen-domain landmine (`config.ts:257`) is handled upstream: these
 * documents go through `materializeCorpus` + `buildProfile` like every other
 * dataset, so they are re-ingested under the shipped `docs` domain. The atoms'
 * own `x_domain` never reaches the index.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { parseAtom } from '../../../dp-gnosis/src/atom.js';
import { defaultExcludedTypes } from '../../../dp-gnosis/src/vocabulary.js';
import type { BeirDoc } from '../beir.js';
import type { BeirDataset, VaultDerivationSource } from '../manifest.js';

const MARKDOWN_EXT = '.md';
const CORPUS_FILE = 'corpus.jsonl';
const QUERIES_FILE = 'queries.jsonl';
const QRELS_DIR = 'qrels';
const QRELS_HEADER = 'query-id\tcorpus-id\tscore';

/** The golden sets record relevance as a flat list, so every judgment is grade 1. */
const RELEVANT_SCORE = 1;

/**
 * One hand-authored golden-set entry — the fields the qrels need, plus the
 * REPORTING facets the author stated about the query's shape.
 *
 * `axis` / `domain` / `type` are carried as reporting dimensions ONLY. They are
 * never a retrieval filter: `buildProfile` labels every bench atom
 * `domain=docs` / `type=vendor-doc`, so filtering on an authored value would
 * return zero documents. Each is ABSENT when the entry does not author it — a
 * placeholder would open a bucket the author never wrote.
 */
export interface GoldenQuery {
  readonly id: string;
  readonly query: string;
  readonly relevantAtomIds: readonly string[];
  readonly axis?: string | undefined;
  readonly domain?: string | undefined;
  readonly type?: string | undefined;
}

/** The facet keys, in the one order every projection and every column uses. */
export const GOLDEN_FACET_KEYS = ['axis', 'domain', 'type'] as const;

/** What one derivation produced, in the numbers a run must be able to quote. */
export interface VaultDerivation {
  readonly dir: string;
  readonly docCount: number;
  readonly queryCount: number;
  readonly judgmentCount: number;
  /** Judgments naming an atom the corpus does not hold. */
  readonly unreachableCount: number;
  /** Macro mean over queries of the share of gold that IS reachable. */
  readonly recallCeiling: number;
  /** Atom files the engine's own parser refused; they carry no document. */
  readonly unparsedCount: number;
  /**
   * Atoms dropped because their type is one the CLI never serves. Counted APART
   * from `unparsedCount`: that one is a defect diagnostic, and folding a
   * deliberate exclusion into it would report the alignment as corrupt files.
   */
  readonly excludedCount: number;
}

const fail = (problem: string, fix: string): never => {
  throw new Error(`dp-gnosis-bench vault: ${problem} — ${fix}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string =>
  typeof record[key] === 'string' ? record[key] : '';

const idList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Only the facets the entry actually authored; an empty string writes no key. */
const facetsOf = (
  record: Readonly<Record<string, unknown>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    GOLDEN_FACET_KEYS.map(key => [key, stringField(record, key)] as const).filter(
      pair => pair[1].length > 0
    )
  );

const toGoldenQuery = (raw: unknown): GoldenQuery | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = stringField(raw, 'id');
  const query = stringField(raw, 'query');
  return id.length > 0 && query.length > 0
    ? { id, query, relevantAtomIds: idList(raw['relevantAtomIds']), ...facetsOf(raw) }
    : undefined;
};

const isQuery = (value: GoldenQuery | undefined): value is GoldenQuery => value !== undefined;

/** Validate a parsed golden-set body. The file itself is never rewritten. */
export const parseGoldenSet = (raw: unknown, path: string): readonly GoldenQuery[] => {
  const list = isRecord(raw) ? raw['queries'] : undefined;
  return Array.isArray(list)
    ? list.map(toGoldenQuery).filter(isQuery)
    : fail(`${path} has no "queries" array`, 'point "derive.golden" at a golden-set JSON file');
};

/**
 * `# <title>` at the head of a body only repeats the frontmatter title, and
 * `toMarkdown` re-adds it. Dropping it keeps the generated document byte-close
 * to the atom the vault actually holds instead of counting the title twice.
 */
const stripTitleHeading = (body: string, title: string): string => {
  const heading = `# ${title}\n`;
  const rest = body.startsWith(heading) ? body.slice(heading.length) : body;
  return rest.startsWith('\n') ? rest.slice(1) : rest;
};

/**
 * One parsed atom, with the frontmatter `type` kept BESIDE its projection. The
 * type has to be read here or nowhere: `BeirDoc` is `{id,title,text}` and
 * `corpus.ts` re-labels every bench atom `vendor-doc` at ingest, so nothing
 * downstream of this function can tell a `review` atom from a `standard` one.
 */
interface TypedDoc {
  readonly doc: BeirDoc;
  readonly type: string;
}

const toTypedDoc = (atomsDir: string, relPath: string): TypedDoc | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, relPath), 'utf8'));
  if (!parsed.ok) return undefined;
  const { title, type } = parsed.atom.frontmatter;
  return {
    doc: {
      id: basename(relPath, MARKDOWN_EXT),
      title,
      text: stripTitleHeading(parsed.atom.body, title),
    },
    type,
  };
};

const isTypedDoc = (value: TypedDoc | undefined): value is TypedDoc => value !== undefined;

/**
 * The types the CLI hides from every `retrieve`, read as plain strings. A
 * FUNCTION call, not a module-level constant: the exclusion is profile data and
 * resolving it at import would read a profile off disk before the caller has
 * named one.
 */
const isServable = (typed: TypedDoc): boolean =>
  !(defaultExcludedTypes() as readonly string[]).includes(typed.type);

const markdownPaths = (atomsDir: string): readonly string[] =>
  [
    ...readdirSync(atomsDir, { recursive: true, encoding: 'utf8' }).filter(entry =>
      entry.endsWith(MARKDOWN_EXT)
    ),
  ].sort();

const assertUniqueIds = (docs: readonly BeirDoc[], atomsDir: string): void => {
  const unique = new Set(docs.map(doc => doc.id));
  if (unique.size !== docs.length) {
    fail(
      `${atomsDir} holds two atoms with the same filename in different subdirectories`,
      'the filename is the document id, so rename one of them before benchmarking'
    );
  }
};

/** What one projection produced: the kept documents, and how many were excluded. */
interface DerivedDocs {
  readonly docs: readonly BeirDoc[];
  readonly excludedCount: number;
}

/**
 * Project every parsed atom, then subtract the types the CLI never serves.
 * Uniqueness is asserted over the PARSED set, not the kept one, so a duplicate
 * filename still fails exactly as it did before the filter existed.
 */
const docsFrom = (
  atomsDir: string,
  relPaths: readonly string[],
  includeHistory: boolean
): DerivedDocs => {
  const parsed = relPaths.map(relPath => toTypedDoc(atomsDir, relPath)).filter(isTypedDoc);
  assertUniqueIds(parsed.map(typed => typed.doc), atomsDir);
  const kept = includeHistory ? parsed : parsed.filter(isServable);
  return { docs: kept.map(typed => typed.doc), excludedCount: parsed.length - kept.length };
};

/**
 * Every atom under `atomsDir`, recursively, as a BEIR document — UNFILTERED, the
 * whole directory. The forensics inspector reads it to explain what the vault
 * holds, which is a different question from what an arm measures.
 */
export const readAtomDocs = (atomsDir: string): readonly BeirDoc[] =>
  docsFrom(atomsDir, markdownPaths(atomsDir), true).docs;

const jsonl = (rows: readonly Readonly<Record<string, string>>[]): string =>
  `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;

/** The facets a PARSED entry carries, read off the typed fields, never a cast. */
const authoredFacets = (query: GoldenQuery): Readonly<Record<string, string>> => ({
  ...(query.axis === undefined ? {} : { axis: query.axis }),
  ...(query.domain === undefined ? {} : { domain: query.domain }),
  ...(query.type === undefined ? {} : { type: query.type }),
});

/**
 * One `queries.jsonl` row. The facets ride BESIDE `_id`/`text`, and an
 * unauthored one writes no key at all — a BEIR or BRIGHT dataset authors none,
 * and its rows must stay exactly what they have always been.
 */
const queryRow = (query: GoldenQuery): Readonly<Record<string, string>> => ({
  _id: query.id,
  text: query.query,
  ...authoredFacets(query),
});

const qrelsBody = (queries: readonly GoldenQuery[]): string => {
  const rows = queries.flatMap(query =>
    query.relevantAtomIds.map(atomId => `${query.id}\t${atomId}\t${RELEVANT_SCORE}`)
  );
  return `${[QRELS_HEADER, ...rows].join('\n')}\n`;
};

const writeLayout = (
  dir: string,
  split: string,
  docs: readonly BeirDoc[],
  queries: readonly GoldenQuery[]
): void => {
  mkdirSync(resolve(dir, QRELS_DIR), { recursive: true });
  writeFileSync(
    resolve(dir, CORPUS_FILE),
    jsonl(docs.map(doc => ({ _id: doc.id, title: doc.title, text: doc.text }))),
    'utf8'
  );
  writeFileSync(
    resolve(dir, QUERIES_FILE),
    jsonl(queries.map(queryRow)),
    'utf8'
  );
  writeFileSync(resolve(dir, QRELS_DIR, `${split}.tsv`), qrelsBody(queries), 'utf8');
};

/** Per query: how many of its judgments name an atom the corpus actually holds. */
const reachableShares = (
  queries: readonly GoldenQuery[],
  docs: readonly BeirDoc[]
): readonly number[] => {
  const present = new Set(docs.map(doc => doc.id));
  return queries.map(query => {
    const reachable = query.relevantAtomIds.filter(atomId => present.has(atomId)).length;
    return reachable / Math.max(query.relevantAtomIds.length, 1);
  });
};

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);

const countUnreachable = (
  queries: readonly GoldenQuery[],
  docs: readonly BeirDoc[]
): number => {
  const present = new Set(docs.map(doc => doc.id));
  return queries
    .flatMap(query => query.relevantAtomIds)
    .filter(atomId => !present.has(atomId)).length;
};

const sourceOf = (entry: BeirDataset): VaultDerivationSource =>
  entry.derive ??
  fail(
    `dataset "${entry.id}" has no "derive" block`,
    'add { "derive": { "atoms": "...", "golden": "..." } }, or drop the vault fetcher'
  );

/**
 * Project the atoms + golden set at `entry.derive` into the BEIR layout at
 * `entry.source`, and report what came out. Paths in `derive` are resolved
 * against `suiteRoot`, like every other path in the manifest.
 */
export const ensureVaultDataset = (
  entry: BeirDataset,
  suiteRoot: string,
  includeHistory = false
): VaultDerivation => {
  const derive = sourceOf(entry);
  const atomsDir = resolve(suiteRoot, derive.atoms);
  const paths = markdownPaths(atomsDir);
  const { docs, excludedCount } = docsFrom(atomsDir, paths, includeHistory);
  const queries = parseGoldenSet(
    JSON.parse(readFileSync(resolve(suiteRoot, derive.golden), 'utf8')) as unknown,
    derive.golden
  );
  const dir = resolve(suiteRoot, entry.source);
  writeLayout(dir, entry.qrels, docs, queries);
  return {
    dir,
    docCount: docs.length,
    queryCount: queries.length,
    judgmentCount: queries.reduce((total, query) => total + query.relevantAtomIds.length, 0),
    unreachableCount: countUnreachable(queries, docs),
    recallCeiling: mean(reachableShares(queries, docs)),
    unparsedCount: paths.length - docs.length - excludedCount,
    excludedCount,
  };
};

const share = (part: number, whole: number): string =>
  `${((part / Math.max(whole, 1)) * 100).toFixed(1)}%`;

/**
 * The one line a run prints per derived dataset. Unreachable gold is stated
 * every time because it is a ceiling on recall, not a transient warning: the
 * ceiling is the MACRO mean of each query's reachable share, matching the way
 * `score.ts` averages recall over topics.
 */
/** `error.cause` when a derived dataset cannot reach gold the run is scored against. */
export const UNREACHABLE_GOLD_CAUSE = 'dp-gnosis-bench/unreachable-gold';

/**
 * How many unreachable judgments a derivation may carry and still be measured.
 * ZERO: a gold id with no atom file is a document that left the corpus, and
 * every metric computed over it is scored against a ceiling below 1 that no
 * arm can reach. The T2.1 gate read exactly that as a −0.0921 nDCG@10
 * regression, because the count was PRINTED and the run continued.
 *
 * The floor is a constant and not a flag on purpose: a threshold an operator
 * can raise from the command line is a threshold that gets raised on the run
 * that trips it. Re-point the golden set, or fix what dropped the document.
 */
export const UNREACHABLE_GOLD_FLOOR = 0;

const unreachableGoldMessage = (id: string, derived: VaultDerivation): string =>
  `dp-gnosis-bench: refusing dataset "${id}" — ${describeDerivation(id, derived)}. ` +
  `At most ${UNREACHABLE_GOLD_FLOOR} unreachable judgments may be measured: every one of them ` +
  'caps recall at a ceiling no arm can reach, so the scores would understate every arm equally ' +
  'and read as a regression. Re-point the golden set to the atoms the corpus now holds, ' +
  'recording the from→to mapping, or restore the documents the ingest dropped.';

/**
 * REFUSE, do not warn. Separate from `ensureVaultDataset` so the derivation
 * still reports its counts to a caller that wants them (the tests, a future
 * inspector) while the RUN — the only caller that scores the result — cannot
 * proceed past a corpus that has lost gold.
 */
export const assertGoldReachable = (id: string, derived: VaultDerivation): void => {
  if (derived.unreachableCount <= UNREACHABLE_GOLD_FLOOR) return;
  throw new Error(unreachableGoldMessage(id, derived), { cause: UNREACHABLE_GOLD_CAUSE });
};

/** What the INDEXED-corpus refusal judges, separated so it can be tested without an index. */
export interface IndexedGoldFacts {
  readonly datasetId: string;
  /** Document ids the run's judgments name — the qrels' `corpus-id` column. */
  readonly goldDocIds: readonly string[];
  /** Document ids the INDEXED atoms roll up to, via `score.ts:toDocumentRanking`. */
  readonly reachableDocIds: readonly string[];
}

/** Judged documents no indexed atom rolls up to, deduplicated and ordered for a stable message. */
export const unreachableGoldDocIds = (facts: IndexedGoldFacts): readonly string[] => {
  const reachable = new Set(facts.reachableDocIds);
  return [...new Set(facts.goldDocIds)].filter(docId => !reachable.has(docId)).sort();
};

/** How many missing ids the refusal spells out before it stops listing them. */
const NAMED_MISSING_LIMIT = 10;

const indexedGoldMessage = (facts: IndexedGoldFacts, missing: readonly string[]): string =>
  `dp-gnosis-bench: refusing dataset "${facts.datasetId}" — the INDEXED corpus cannot reach ` +
  `${missing.length} of ${new Set(facts.goldDocIds).size} judged documents ` +
  `(${missing.slice(0, NAMED_MISSING_LIMIT).join(', ')}). They exist in the source projection ` +
  'and were lost between it and the index — the exact-body dedupe and the frozen domain ' +
  'vocabulary are the two paths that drop a document there. Every metric over them is scored ' +
  'against a ceiling no arm can reach, so the run would read as a regression. Restore the ' +
  'documents the ingest dropped, or re-point the golden set, recording the from→to mapping.';

/**
 * REFUSE on the corpus the engine ACTUALLY INDEXED. Sibling of
 * `assertGoldReachable`, under the same cause and the same zero floor, and it
 * exists because that one cannot see this loss: it is computed over the BEIR
 * projection of the SOURCE atoms, before ingest, so it printed
 * `0 unreachable (mean recall ceiling 1.0000)` over a run whose dedupe had just
 * removed 9 judged documents. A check upstream of the stage that loses gold
 * cannot detect the loss.
 */
export const assertIndexedGoldReachable = (facts: IndexedGoldFacts): void => {
  const missing = unreachableGoldDocIds(facts);
  if (missing.length <= UNREACHABLE_GOLD_FLOOR) return;
  throw new Error(indexedGoldMessage(facts, missing), { cause: UNREACHABLE_GOLD_CAUSE });
};

/** Kept for the run's stdout line; the refusal above is what stops a bad corpus. */
export const describeDerivation = (id: string, derived: VaultDerivation): string =>
  `${id}: derived ${derived.docCount} docs (${derived.unparsedCount} atom files unparsed, ` +
  `${derived.excludedCount} excluded as unservable types), ` +
  `${derived.queryCount} queries, ${derived.judgmentCount} judgments — ` +
  `${derived.unreachableCount} unreachable ` +
  `(${share(derived.unreachableCount, derived.judgmentCount)} of gold has no atom file; ` +
  `mean recall ceiling ${derived.recallCeiling.toFixed(4)})`;
