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
import type { BeirDoc } from '../beir.js';
import type { BeirDataset, VaultDerivationSource } from '../manifest.js';

const MARKDOWN_EXT = '.md';
const CORPUS_FILE = 'corpus.jsonl';
const QUERIES_FILE = 'queries.jsonl';
const QRELS_DIR = 'qrels';
const QRELS_HEADER = 'query-id\tcorpus-id\tscore';

/** The golden sets record relevance as a flat list, so every judgment is grade 1. */
const RELEVANT_SCORE = 1;

/** One hand-authored golden-set entry — the fields the qrels need, nothing else. */
export interface GoldenQuery {
  readonly id: string;
  readonly query: string;
  readonly relevantAtomIds: readonly string[];
}

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

const toGoldenQuery = (raw: unknown): GoldenQuery | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = stringField(raw, 'id');
  const query = stringField(raw, 'query');
  return id.length > 0 && query.length > 0
    ? { id, query, relevantAtomIds: idList(raw['relevantAtomIds']) }
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

const toDoc = (atomsDir: string, relPath: string): BeirDoc | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, relPath), 'utf8'));
  if (!parsed.ok) return undefined;
  const { title } = parsed.atom.frontmatter;
  return {
    id: basename(relPath, MARKDOWN_EXT),
    title,
    text: stripTitleHeading(parsed.atom.body, title),
  };
};

const isDoc = (value: BeirDoc | undefined): value is BeirDoc => value !== undefined;

const markdownPaths = (atomsDir: string): readonly string[] =>
  readdirSync(atomsDir, { recursive: true, encoding: 'utf8' })
    .filter(entry => entry.endsWith(MARKDOWN_EXT))
    .toSorted();

const assertUniqueIds = (docs: readonly BeirDoc[], atomsDir: string): void => {
  const unique = new Set(docs.map(doc => doc.id));
  if (unique.size !== docs.length) {
    fail(
      `${atomsDir} holds two atoms with the same filename in different subdirectories`,
      'the filename is the document id, so rename one of them before benchmarking'
    );
  }
};

const docsFrom = (atomsDir: string, relPaths: readonly string[]): readonly BeirDoc[] => {
  const docs = relPaths.map(relPath => toDoc(atomsDir, relPath)).filter(isDoc);
  assertUniqueIds(docs, atomsDir);
  return docs;
};

/** Every atom under `atomsDir`, recursively, as a BEIR document. */
export const readAtomDocs = (atomsDir: string): readonly BeirDoc[] =>
  docsFrom(atomsDir, markdownPaths(atomsDir));

const jsonl = (rows: readonly Readonly<Record<string, string>>[]): string =>
  `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;

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
    jsonl(queries.map(query => ({ _id: query.id, text: query.query }))),
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
export const ensureVaultDataset = (entry: BeirDataset, suiteRoot: string): VaultDerivation => {
  const derive = sourceOf(entry);
  const atomsDir = resolve(suiteRoot, derive.atoms);
  const paths = markdownPaths(atomsDir);
  const docs = docsFrom(atomsDir, paths);
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
    unparsedCount: paths.length - docs.length,
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
export const describeDerivation = (id: string, derived: VaultDerivation): string =>
  `${id}: derived ${derived.docCount} docs (${derived.unparsedCount} atom files unparsed), ` +
  `${derived.queryCount} queries, ${derived.judgmentCount} judgments — ` +
  `${derived.unreachableCount} unreachable ` +
  `(${share(derived.unreachableCount, derived.judgmentCount)} of gold has no atom file; ` +
  `mean recall ceiling ${derived.recallCeiling.toFixed(4)})`;
