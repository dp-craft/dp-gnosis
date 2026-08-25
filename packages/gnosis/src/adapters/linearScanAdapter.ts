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
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Atom } from '../atom.js';
import { parseAtom } from '../atom.js';
import { BM25_IDF_SMOOTHING } from '../config.js';
import { ATOMS_DIR } from '../paths.js';
import type {
  AtomOrigin,
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom,
  RetrieveOptions
} from '../port.js';
import { assertDomainFilter, assertTypeFilter, atomOrigin } from '../port.js';
import type { TermProcessor } from '../query.js';
import { stemTerm, tokenize } from '../query.js';
import { isRetrievable } from '../retrievability.js';
import {
  type AtomDomain,
  type AtomType,
  atomDomains,
  atomTypes,
  defaultAtomType
} from '../vocabulary.js';

const ADAPTER_NAME = 'linear-scan';
/** Names the legs that ran: one lexical leg, no vector leg, no index. */
const RETRIEVAL_MODE = 'lexical:bm25-linear';
const MARKDOWN_EXT = '.md';

/**
 * BM25 term-frequency saturation and length-normalization parameters, at the
 * values Robertson & Zaragoza give as the standard operating point ("The
 * Probabilistic Relevance Framework: BM25 and Beyond", 2009, §3.2: k1 in
 * 1.2–2.0, b = 0.75).
 *
 * These values do NOT make this adapter directly comparable with the `fts5`
 * one, and MUST NOT be read as doing so: `fts5Adapter.ts` indexes `entry.body`
 * ALONE (`INSERT INTO atom_fts(rowid, body)`) while this adapter indexes title
 * plus body, and this file computes its own `idf` where fts5 uses SQLite's
 * built-in `bm25()`. Different indexed text and a different IDF formula mean
 * the two scores are not on one scale whatever k1 and b are set to.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** The two BM25 knobs, carried together so scoring reads one operating point. */
interface Bm25Params {
  readonly k1: number;
  readonly b: number;
}

const DEFAULT_BM25: Bm25Params = { k1: BM25_K1, b: BM25_B };

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
  /**
   * BM25 term-frequency saturation. Defaults to `BM25_K1`, so omitting it scores
   * exactly as before. It exists so a parameter sweep can drive THIS adapter
   * rather than re-implementing BM25 beside it; SQLite FTS5 hardcodes its own
   * pair, so a value found here is not transferable to the `fts5` adapter.
   */
  readonly k1?: number;
  /** BM25 length normalization. Defaults to `BM25_B`; see `k1`. */
  readonly b?: number;
  /**
   * Keep the PARAMETER-INDEPENDENT part of the scan — parsed atoms, terms, term
   * frequencies, lengths and document frequencies — in memory between calls,
   * keyed by `atomsDir`. `k1` and `b` enter only in the final BM25 combination,
   * so one cached scan serves every cell of a parameter sweep; scores and
   * rankings are NOT cached and are recomputed per call.
   *
   * Defaults to `false`, and off it changes nothing: the scan runs per call, so
   * the port's read-at-call-time body rule holds as documented on
   * `createLinearScanAdapter`. Turning it ON trades exactly that rule for speed,
   * which makes it a BENCHMARK affordance (`dp-gnosis-bench` `sweep.ts`, where
   * the corpus is fixed across a grid), not a production knob. Two consequences
   * a caller accepts with it: an on-disk edit that leaves the corpus signature
   * — a hash over the `(relPath, size, mtimeMs)` stat manifest under `atomsDir`;
   * see `CorpusSignature` — untouched is not seen, and the
   * `stale_after`/`deprecated` retrievability cutoff is frozen at the
   * `now` of the call that filled the cache rather than re-evaluated per call.
   */
  readonly cacheCorpusScan?: boolean;
}

interface ScanContext {
  readonly dir: string;
  readonly now: Date;
  readonly processTerm: TermProcessor;
  readonly bm25: Bm25Params;
  readonly cacheCorpusScan: boolean;
}

interface ScannedDoc {
  readonly id: string;
  /** Carried whole so an absent field stays absent all the way to the port. */
  readonly origin: AtomOrigin;
  readonly title: string;
  readonly domain: AtomDomain;
  readonly type: AtomType;
  readonly body: string;
  readonly sourcePath: string;
  readonly originPaths: readonly string[];
  readonly terms: readonly string[];
  readonly freq: ReadonlyMap<string, number>;
}

/**
 * Everything the scan produces that `k1` and `b` cannot influence. Kept SEPARATE
 * from `Corpus` so a cached scan is provably parameter-independent: nothing a
 * sweep varies can reach this shape.
 */
interface CorpusScan {
  readonly docs: readonly ScannedDoc[];
  readonly avgLength: number;
  readonly docFreq: ReadonlyMap<string, number>;
}

interface Corpus extends CorpusScan {
  /** The operating point this corpus is scored at — read by `scoreTerm`. */
  readonly bm25: Bm25Params;
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
  atomDomains().find(domain => domain === value);

/**
 * An unknown or absent `type` falls back to the default rather than dropping the
 * atom: the type vocabulary classifies an atom, it does not gate scanning, so a
 * typo must not make an otherwise valid atom unreachable.
 */
const asType = (value: string): AtomType =>
  atomTypes().find(type => type === value) ?? defaultAtomType();

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
        origin: atomOrigin(atom.frontmatter),
        title: atom.frontmatter.title,
        domain,
        type: asType(atom.frontmatter.type),
        body: atom.body,
        sourcePath: join(context.dir, file),
        originPaths: atom.frontmatter.sources,
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

const buildScan = (docs: readonly ScannedDoc[]): CorpusScan => ({
  docs,
  avgLength: meanLength(docs),
  docFreq: documentFrequencies(docs),
});

/**
 * `Promise.all` preserves ARGUMENT order, so the corpus order is the sorted
 * file order regardless of which read settles first.
 */
const readScan = async (context: ScanContext, files: readonly string[]): Promise<CorpusScan> => {
  const docs = await Promise.all(files.map(file => readDoc(context, file)));
  return buildScan(docs.filter(isDefined));
};

/**
 * The cheap corpus fingerprint: a hash over the stat manifest — every atom
 * file's `(relPath, size, mtimeMs)`, sorted by `relPath` so `listAtomFiles`
 * order cannot reach the digest. One `stat` pass, no bodies read: this check
 * runs on EVERY retrieve, so reading atom bodies here would cost more than the
 * scan it guards.
 *
 * Because every file is named individually, it catches what a count-plus-newest
 * -mtime pair missed: a count-preserving swap (one file replaced by another),
 * the restore of an OLDER file (the maximum mtime does not move), a rename, and
 * any edit that changes a file's size.
 *
 * ONE residual hole is accepted: an edit that rewrites a file to EXACTLY its
 * previous size within the same mtime tick is indistinguishable from no edit.
 * Closing it would require reading bodies, which the cost rule above forbids.
 */
interface CorpusSignature {
  readonly digest: string;
}

const NO_MTIME = 0;
/** Paired with `NO_MTIME`: an unstattable file still contributes a fixed entry. */
const NO_SIZE = -1;
const MANIFEST_SEPARATOR = ' ';
const SIGNATURE_ALGORITHM = 'sha256';

/** One manifest row: identity, size and mtime of a single atom file. */
interface FileStat {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** An unstattable file yields a deterministic sentinel row rather than throwing. */
const statOf = async (dir: string, relPath: string): Promise<FileStat> =>
  await stat(join(dir, relPath)).then(
    stats => ({ relPath, size: stats.size, mtimeMs: stats.mtimeMs }),
    () => ({ relPath, size: NO_SIZE, mtimeMs: NO_MTIME })
  );

const byRelPath = (a: FileStat, b: FileStat): number => compareStrings(a.relPath, b.relPath);

const manifestRow = (entry: FileStat): string =>
  [entry.relPath, entry.size, entry.mtimeMs].join(MANIFEST_SEPARATOR);

const signatureOf = async (
  dir: string,
  files: readonly string[]
): Promise<CorpusSignature> => {
  const stats = await Promise.all(files.map(file => statOf(dir, file)));
  const manifest = [...stats].sort(byRelPath).map(manifestRow).join('\n');
  return { digest: createHash(SIGNATURE_ALGORITHM).update(manifest).digest('hex') };
};

/**
 * Keyed by directory, so two adapters over the same corpus at different `k1`/`b`
 * share one scan — which is the entire point, since a sweep builds a fresh
 * adapter per cell. `processTerm` is part of the validity check rather than the
 * key: a different tokenizer produces different terms, and serving those would
 * be silently wrong rather than merely stale.
 */
interface CacheEntry {
  readonly signature: CorpusSignature;
  readonly processTerm: TermProcessor;
  readonly scan: CorpusScan;
}

const scanCache = new Map<string, CacheEntry>();

const isFresh = (entry: CacheEntry, context: ScanContext, signature: CorpusSignature): boolean =>
  entry.processTerm === context.processTerm && entry.signature.digest === signature.digest;

const cachedScan = async (context: ScanContext, files: readonly string[]): Promise<CorpusScan> => {
  const signature = await signatureOf(context.dir, files);
  const entry = scanCache.get(context.dir);
  if (entry !== undefined && isFresh(entry, context, signature)) return entry.scan;
  const scan = await readScan(context, files);
  scanCache.set(context.dir, { signature, processTerm: context.processTerm, scan });
  return scan;
};

/** `undefined` means the corpus root itself could not be read, so NO scan ran. */
const scanCorpus = async (context: ScanContext): Promise<CorpusScan | undefined> => {
  const files = await listAtomFiles(context.dir);
  if (files === undefined) return undefined;
  return context.cacheCorpusScan ? await cachedScan(context, files) : await readScan(context, files);
};

/** BM25 IDF with the +1 smoothing that keeps the weight non-negative. */
const idf = (docFreq: number, totalDocs: number): number =>
  Math.log(1 + (totalDocs - docFreq + BM25_IDF_SMOOTHING) / (docFreq + BM25_IDF_SMOOTHING));

/** The length-normalization factor: `1 - b + b * dl / avgdl`. */
const lengthNorm = (length: number, avgLength: number, b: number): number =>
  1 - b + (b * length) / avgLength;

/** One term's contribution before saturation is applied — grouped to keep the arity at two. */
interface TermStats {
  readonly freq: number;
  readonly weight: number;
  readonly norm: number;
}

const termScore = (stats: TermStats, k1: number): number =>
  stats.freq === 0 ? 0 : (stats.weight * stats.freq * (k1 + 1)) / (stats.freq + k1 * stats.norm);

const scoreTerm = (doc: ScannedDoc, term: string, corpus: Corpus): number =>
  termScore(
    {
      freq: doc.freq.get(term) ?? 0,
      weight: idf(corpus.docFreq.get(term) ?? 0, corpus.docs.length),
      norm: lengthNorm(doc.terms.length, corpus.avgLength, corpus.bm25.b),
    },
    corpus.bm25.k1
  );

const scoreDoc = (doc: ScannedDoc, terms: readonly string[], corpus: Corpus): number =>
  terms.reduce((sum, term) => sum + scoreTerm(doc, term, corpus), 0);

/** Explicit total order — never a reliance on incidental sort stability. */
const byScoreThenId = (a: ScoredDoc, b: ScoredDoc): number =>
  b.score - a.score || compareStrings(a.doc.id, b.doc.id);

const inDomain = (doc: ScannedDoc, domains: readonly AtomDomain[] | undefined): boolean =>
  domains === undefined || domains.includes(doc.domain);

const matchType = (doc: ScannedDoc, types: readonly AtomType[] | undefined): boolean =>
  types === undefined || types.includes(doc.type);

const toRetrieved = (scored: ScoredDoc): RetrievedAtom => ({
  id: scored.doc.id,
  ...scored.doc.origin,
  title: scored.doc.title,
  domain: scored.doc.domain,
  type: scored.doc.type,
  body: scored.doc.body,
  score: scored.score,
  sourcePath: scored.doc.sourcePath,
  originPaths: scored.doc.originPaths,
});

const rank = (corpus: Corpus, terms: readonly string[], opts: RetrieveOptions): readonly ScoredDoc[] =>
  corpus.docs
    .filter(doc => inDomain(doc, opts.domains))
    .filter(doc => matchType(doc, opts.types))
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
  const scan = await scanCorpus(context);
  if (scan === undefined) return UNAVAILABLE_RESULT;
  const corpus: Corpus = { ...scan, bm25: context.bm25 };
  const scored = rank(corpus, queryTerms(query, context.processTerm), opts);
  return { atoms: scored.map(toRetrieved), mode: RETRIEVAL_MODE, indexState: indexStateOf(corpus) };
};

/** Either knob may be omitted independently; each falls back on its own. */
const bm25For = (options: LinearScanOptions): Bm25Params => ({
  k1: options.k1 ?? DEFAULT_BM25.k1,
  b: options.b ?? DEFAULT_BM25.b,
});

const contextFor = (dir: string, options: LinearScanOptions): ScanContext => ({
  dir,
  now: options.now ?? new Date(),
  processTerm: options.processTerm ?? stemTerm,
  bm25: bm25For(options),
  cacheCorpusScan: options.cacheCorpusScan ?? false,
});

/**
 * Build the linear-scan port over `atomsDir`. The directory is injectable so a
 * test can point at a fixture tree; it defaults to the real `ATOMS_DIR`, and
 * `PROPOSALS_DIR` is not reachable through any argument this factory takes.
 *
 * The corpus is re-read on EVERY `retrieve`, which is what satisfies the port's
 * read-at-call-time body rule: an edit on disk is visible to the very next call
 * with no reindex step. `options.cacheCorpusScan` — off unless a caller asks for
 * it — is the one documented way to give that rule up, and it is there for the
 * benchmark sweep; see its own comment for what it costs.
 */
export const createLinearScanAdapter = (
  atomsDir: string = ATOMS_DIR,
  options: LinearScanOptions = {}
): KnowledgePort => ({
  name: ADAPTER_NAME,
  retrieve: async (query, opts): Promise<RetrievalResult> => {
    assertTypeFilter(opts.types);
    assertDomainFilter(opts.domains);
    return await retrieve(contextFor(atomsDir, options), query, opts);
  },
});
