/**
 * The REFERENCE retrieval adapter: BM25 scored in memory over the atom files,
 * with no persistent index at all. Every indexed adapter is compared against
 * this one, so it is written for obvious correctness rather than for speed —
 * it re-reads and re-scores the whole corpus on every call.
 *
 * Two properties are load-bearing and are the reason this file exists:
 *
 * 1. Determinism. `fs.readdir` order is NOT guaranteed across platforms or
 *    filesystems, so the file list is EXPLICITLY sorted before anything is
 *    scored, and the final ordering is an explicit `(score DESC, atomId ASC)`
 *    sort. Nothing here may depend on directory order, on `Promise` settle
 *    order, or on a sort being stable by accident.
 * 2. Location-based retrievability. This adapter reads `ATOMS_DIR` and only
 *    `ATOMS_DIR`. A markdown file sitting in `PROPOSALS_DIR` is structurally
 *    unreachable — it is never opened, not filtered out after the fact.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Atom } from '../atom.js';
import { parseAtom } from '../atom.js';
import type { AtomDomain, AtomType } from '../config.js';
import { ATOM_DOMAINS, ATOM_TYPES, BM25_IDF_SMOOTHING, DEFAULT_ATOM_TYPE } from '../config.js';
import { ATOMS_DIR } from '../paths.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';
import type { TermProcessor } from '../query.js';
import { stemTerm, tokenize } from '../query.js';
import { isRetrievable } from '../retrievability.js';

const ADAPTER_NAME = 'linear-scan';
/** Names the legs that ran: one lexical leg, no vector leg, no index. */
const RETRIEVAL_MODE = 'lexical:bm25-linear';
const MARKDOWN_EXT = '.md';

/**
 * BM25 term-frequency saturation and length-normalization parameters, at the
 * values Robertson & Zaragoza give as the standard operating point ("The
 * Probabilistic Relevance Framework: BM25 and Beyond", 2009, §3.2: k1 in
 * 1.2–2.0, b = 0.75). They are also what SQLite FTS5's `bm25()` uses, which
 * keeps this reference adapter comparable with the indexed one rather than
 * differing by a tuning choice nobody made deliberately.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface LinearScanOptions {
  /**
   * Injected for the same reason `isRetrievable` takes it: a time-dependent
   * predicate cannot be asserted deterministically. Defaults to the wall clock
   * at CALL time, not at construction time.
   */
  readonly now?: Date;
  /**
   * Term normalizer, applied index-side and query-side so the two can never
   * drift apart.
   *
   * Defaults to the package-wide `stemTerm` — the SAME function every other
   * adapter defaults to, which is what keeps `--adapter` a comparison of
   * retrieval rather than of tokenizers. Overriding it is a test affordance,
   * not a production knob.
   */
  readonly processTerm?: TermProcessor;
}

interface ScanContext {
  readonly dir: string;
  readonly now: Date;
  readonly processTerm: TermProcessor;
}

interface ScannedDoc {
  readonly id: string;
  readonly title: string;
  readonly domain: AtomDomain;
  readonly type: AtomType;
  readonly body: string;
  readonly sourcePath: string;
  readonly terms: readonly string[];
  readonly freq: ReadonlyMap<string, number>;
}

interface Corpus {
  readonly docs: readonly ScannedDoc[];
  readonly avgLength: number;
  readonly docFreq: ReadonlyMap<string, number>;
}

interface ScoredDoc {
  readonly doc: ScannedDoc;
  readonly score: number;
}

/** Code-unit order — NOT `localeCompare`, whose result varies by locale. */
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

/** Membership test rather than a cast: an unknown domain is not an `AtomDomain`. */
const asDomain = (value: string): AtomDomain | undefined =>
  ATOM_DOMAINS.find(domain => domain === value);

/**
 * An unknown or absent `type` falls back to the default rather than dropping the
 * atom: the type vocabulary classifies an atom, it does not gate scanning, so a
 * typo must not make an otherwise valid atom unreachable.
 */
const asType = (value: string): AtomType =>
  ATOM_TYPES.find(type => type === value) ?? DEFAULT_ATOM_TYPE;

const isAtomFile = (entry: Dirent): boolean =>
  entry.isFile() && entry.name.endsWith(MARKDOWN_EXT);

/**
 * Explicitly sorted: `readdir` order is not part of any contract.
 *
 * An unreadable root — most often one that does not exist yet, before the first
 * `ingest` — yields `undefined` rather than throwing, matching how the port
 * already treats an unreadable FILE, and matching `readExistingIds` in
 * `validate.ts`. `undefined` and `[]` are kept DISTINCT on purpose: `[]` is a
 * real corpus holding no atoms, and collapsing the two would erase the
 * `unavailable`/`empty` split the port depends on.
 */
const listAtomFiles = async (dir: string): Promise<readonly string[] | undefined> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  return entries
    ?.filter(isAtomFile)
    .map(entry => entry.name)
    .sort(compareStrings);
};

const countTerms = (terms: readonly string[]): ReadonlyMap<string, number> =>
  terms.reduce((counts, term) => counts.set(term, (counts.get(term) ?? 0) + 1), new Map<string, number>());

const withFreq = (base: Omit<ScannedDoc, 'freq'>): ScannedDoc => ({
  ...base,
  freq: countTerms(base.terms),
});

const documentTerms = (context: ScanContext, atom: Atom): readonly string[] =>
  tokenize(`${atom.frontmatter.title} ${atom.body}`).map(context.processTerm);

/**
 * Retrievability goes through the SHARED predicate — the deprecated and
 * `stale_after` rules are deliberately not re-stated here.
 */
const fromAtom = (context: ScanContext, file: string, atom: Atom): ScannedDoc | undefined => {
  const domain = asDomain(atom.frontmatter.x_domain);
  return domain === undefined || !isRetrievable(atom.frontmatter, context.now)
    ? undefined
    : withFreq({
        id: atom.frontmatter.id,
        title: atom.frontmatter.title,
        domain,
        type: asType(atom.frontmatter.type),
        body: atom.body,
        sourcePath: join(context.dir, file),
        terms: documentTerms(context, atom),
      });
};

/** A file outside the closed atom grammar is SKIPPED — one bad file is not fatal. */
const toScannedDoc = (context: ScanContext, file: string, text: string): ScannedDoc | undefined => {
  const parsed = parseAtom(text);
  return parsed.ok ? fromAtom(context, file, parsed.atom) : undefined;
};

const readDoc = async (context: ScanContext, file: string): Promise<ScannedDoc | undefined> => {
  const text = await readFile(join(context.dir, file), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : toScannedDoc(context, file, text);
};

const documentFrequencies = (docs: readonly ScannedDoc[]): ReadonlyMap<string, number> =>
  docs.reduce(
    (counts, doc) =>
      [...new Set(doc.terms)].reduce((acc, term) => acc.set(term, (acc.get(term) ?? 0) + 1), counts),
    new Map<string, number>()
  );

const meanLength = (docs: readonly ScannedDoc[]): number =>
  docs.length === 0 ? 0 : docs.reduce((sum, doc) => sum + doc.terms.length, 0) / docs.length;

const buildCorpus = (docs: readonly ScannedDoc[]): Corpus => ({
  docs,
  avgLength: meanLength(docs),
  docFreq: documentFrequencies(docs),
});

/**
 * `Promise.all` preserves ARGUMENT order, so the corpus order is the sorted
 * file order regardless of which read settles first.
 *
 * `undefined` means the corpus root itself could not be read, so NO scan ran.
 */
const scanCorpus = async (context: ScanContext): Promise<Corpus | undefined> => {
  const files = await listAtomFiles(context.dir);
  if (files === undefined) return undefined;
  const docs = await Promise.all(files.map(file => readDoc(context, file)));
  return buildCorpus(docs.filter(isDefined));
};

/** BM25 IDF with the +1 smoothing that keeps the weight non-negative. */
const idf = (docFreq: number, totalDocs: number): number =>
  Math.log(1 + (totalDocs - docFreq + BM25_IDF_SMOOTHING) / (docFreq + BM25_IDF_SMOOTHING));

/** The length-normalization factor: `1 - b + b * dl / avgdl`. */
const lengthNorm = (length: number, avgLength: number): number =>
  1 - BM25_B + (BM25_B * length) / avgLength;

const termScore = (freq: number, weight: number, norm: number): number =>
  freq === 0 ? 0 : (weight * freq * (BM25_K1 + 1)) / (freq + BM25_K1 * norm);

const scoreTerm = (doc: ScannedDoc, term: string, corpus: Corpus): number =>
  termScore(
    doc.freq.get(term) ?? 0,
    idf(corpus.docFreq.get(term) ?? 0, corpus.docs.length),
    lengthNorm(doc.terms.length, corpus.avgLength)
  );

const scoreDoc = (doc: ScannedDoc, terms: readonly string[], corpus: Corpus): number =>
  terms.reduce((sum, term) => sum + scoreTerm(doc, term, corpus), 0);

/** Explicit total order — never a reliance on incidental sort stability. */
const byScoreThenId = (a: ScoredDoc, b: ScoredDoc): number =>
  b.score - a.score || compareStrings(a.doc.id, b.doc.id);

const inDomain = (doc: ScannedDoc, domain: AtomDomain | undefined): boolean =>
  domain === undefined || doc.domain === domain;

const matchType = (doc: ScannedDoc, type: AtomType | undefined): boolean =>
  type === undefined || doc.type === type;

const toRetrieved = (scored: ScoredDoc): RetrievedAtom => ({
  id: scored.doc.id,
  title: scored.doc.title,
  domain: scored.doc.domain,
  type: scored.doc.type,
  body: scored.doc.body,
  score: scored.score,
  sourcePath: scored.doc.sourcePath,
});

const rank = (corpus: Corpus, terms: readonly string[], opts: RetrieveOptions): readonly ScoredDoc[] =>
  corpus.docs
    .filter(doc => inDomain(doc, opts.domain))
    .filter(doc => matchType(doc, opts.type))
    .map(doc => ({ doc, score: scoreDoc(doc, terms, corpus) }))
    .filter(scored => scored.score > 0)
    .sort(byScoreThenId)
    .slice(0, opts.k);

/**
 * This adapter has NO index, so it can never be `stale` (nothing can lag the
 * corpus). It IS `unavailable` when the corpus root cannot be read, because
 * then no scan ran at all — see `UNAVAILABLE_RESULT`. The remaining split still
 * matters: it lets a caller tell "searched, found nothing" (`empty` corpus)
 * from "searched a populated corpus and nothing matched" (`ready`).
 */
const indexStateOf = (corpus: Corpus): IndexState => (corpus.docs.length === 0 ? 'empty' : 'ready');

/** No corpus root, so no search happened — NEVER reported as an `empty` corpus. */
const UNAVAILABLE_RESULT: RetrievalResult = {
  atoms: [],
  mode: RETRIEVAL_MODE,
  indexState: 'unavailable',
};

const queryTerms = (query: string, processTerm: TermProcessor): readonly string[] => [
  ...new Set(tokenize(query).map(processTerm)),
];

const retrieve = async (
  context: ScanContext,
  query: string,
  opts: RetrieveOptions
): Promise<RetrievalResult> => {
  const corpus = await scanCorpus(context);
  if (corpus === undefined) return UNAVAILABLE_RESULT;
  const scored = rank(corpus, queryTerms(query, context.processTerm), opts);
  return { atoms: scored.map(toRetrieved), mode: RETRIEVAL_MODE, indexState: indexStateOf(corpus) };
};

const contextFor = (dir: string, options: LinearScanOptions): ScanContext => ({
  dir,
  now: options.now ?? new Date(),
  processTerm: options.processTerm ?? stemTerm,
});

/**
 * Build the linear-scan port over `atomsDir`. The directory is injectable so a
 * test can point at a fixture tree; it defaults to the real `ATOMS_DIR`, and
 * `PROPOSALS_DIR` is not reachable through any argument this factory takes.
 *
 * The corpus is re-read on EVERY `retrieve`, which is what satisfies the port's
 * read-at-call-time body rule: an edit on disk is visible to the very next call
 * with no reindex step.
 */
export const createLinearScanAdapter = (
  atomsDir: string = ATOMS_DIR,
  options: LinearScanOptions = {}
): KnowledgePort => ({
  name: ADAPTER_NAME,
  retrieve: (query, opts) => retrieve(contextFor(atomsDir, options), query, opts),
});
