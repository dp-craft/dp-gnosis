/**
 * THE SEAM: the benchmark's only contact with dp-gnosis, and it drives the
 * SHIPPED path end to end — `ingest()` → `buildFts5Index()` → `createPort()` →
 * `port.retrieve()`. Nothing here re-implements chunking, tokenizing, query
 * building or ranking; if any of those change, the numbers move. That is the
 * point of the suite (`beirIndex.ts`, the harness this replaces, built its own
 * index and its own SQL and therefore could not see an engine regression).
 *
 * Four rules, each verified against the engine source, each silent when broken:
 *
 * 1. The RAW query text goes to `port.retrieve` — `retrieveCommand.ts:349`
 *    passes exactly that, and `fts5Adapter.toMatchExpression` does the stemming
 *    via the package-wide `stemText`. Building a query or document frequencies
 *    here would measure a path production never takes.
 * 2. `fitToTokenBudget` is NOT applied. It is the CLI's PRESENTATION cap
 *    (`retrieveCommand.ts:342`) and at depth 100 would drop most of the ranking
 *    before it could be scored.
 * 3. Every dataset gets its OWN parent directory. `ingest.ts:428 writeManifest`
 *    writes `corpus-manifest.json` to `dirname(outputDir)`, and
 *    `claimOutputDir`/`pruneOrphans` wipe an atoms directory another profile
 *    owns — so a shared work dir destroys corpora silently.
 * 4. Ingest soundness is ASSERTED, not assumed. `config.ts:257` freezes
 *    `ATOM_DOMAINS` at import time and `fts5Adapter.asDomain:127` narrows
 *    against it, so an atom carrying an off-vocabulary domain is DROPPED at
 *    index time with no error anywhere: an empty index, zero results, and a
 *    green benchmark reporting 0.0 as if it were a quality finding. The assert
 *    below is the only thing between that and a trusted number.
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { buildFts5Index } from '../../dp-gnosis/src/adapters/fts5Adapter.js';
import { createLinearScanAdapter } from '../../dp-gnosis/src/adapters/linearScanAdapter.js';
import { parseAtom } from '../../dp-gnosis/src/atom.js';
import { type AdapterName, createPort } from '../../dp-gnosis/src/cli/adapter.js';
import { ingest } from '../../dp-gnosis/src/ingest.js';
import type { KnowledgePort, RetrievedAtom } from '../../dp-gnosis/src/port.js';
import { rerankAtoms } from '../../dp-gnosis/src/rerank.js';
import type { BeirDoc } from './beir.js';
import { buildProfile, materializeCorpus } from './corpus.js';

const MARKDOWN_EXT = '.md';

/** The adapter under measurement; the one the CLI's `--adapter fts5` builds. */
const ADAPTER = 'fts5' as const;

/** `workRoot/<datasetId>/docs` — the generated markdown, inside the dataset's own dir. */
const CORPUS_DIR_NAME = 'docs';

/** The index's own atom table (`fts5Adapter.ts:79`), read to count what was INDEXED. */
const INDEXED_PATHS_SQL = 'SELECT path FROM atom_meta';

/** Below this share of input documents represented in the index, the dataset fails. */
export const MIN_DOCUMENT_COVERAGE = 0.9;

/** `error.cause` when the index came out empty — the frozen-vocabulary landmine. */
export const EMPTY_INDEX_CAUSE = 'dp-gnosis-bench/empty-index';

/** `error.cause` when too few input documents survived into the index. */
export const LOW_COVERAGE_CAUSE = 'dp-gnosis-bench/low-document-coverage';

/** `error.cause` when `--rerank` was asked for and the reranker refused. */
export const RERANK_REFUSED_CAUSE = 'dp-gnosis-bench/rerank-refused';

/** One dataset's corpus, in memory, plus where it may write. */
export interface PrepareDatasetOptions {
  readonly id: string;
  readonly docs: readonly BeirDoc[];
  /** Absolute root; this dataset owns `workRoot/<id>` exclusively. */
  readonly workRoot: string;
  /** Per-corpus atom cap; absent means the shipped `ATOM_MAX_CHARS`. */
  readonly atomMaxChars?: number | undefined;
}

/** What one dataset's ingest+index produced, and what querying it needs. */
export interface PreparedDataset {
  readonly atomsDir: string;
  readonly indexPath: string;
  /** Atoms actually present in the index — not atoms written to disk. */
  readonly atomCount: number;
  readonly docCount: number;
  readonly ingestMs: number;
}

/** The facts the soundness assert judges, separated so it can be tested alone. */
export interface IngestSoundness {
  readonly datasetId: string;
  readonly indexedAtomCount: number;
  /** Input document ids recovered from the indexed atoms' `sources`. */
  readonly coveredDocIds: readonly string[];
  readonly inputDocIds: readonly string[];
}

const fail = (message: string, cause: string): never => {
  throw new Error(message, { cause });
};

const emptyIndexMessage = (datasetId: string): string =>
  `dp-gnosis-bench: dataset "${datasetId}" indexed ZERO atoms. The atoms were written but ` +
  'every one was dropped at index time — the usual cause is an ingest profile declaring a ' +
  'domain outside the frozen ATOM_DOMAINS vocabulary (tools/dp-gnosis/src/config.ts), which ' +
  'fts5Adapter.asDomain discards without an error. Use the shipped "docs" domain (see corpus.ts).';

const lowCoverageMessage = (facts: IngestSoundness, covered: number): string =>
  `dp-gnosis-bench: dataset "${facts.datasetId}" indexed ${facts.indexedAtomCount} atoms ` +
  `covering only ${covered} of ${facts.inputDocIds.length} documents ` +
  `(below ${MIN_DOCUMENT_COVERAGE}). Documents missing from the index can never be retrieved, ` +
  'so every recall number would be understated; inspect the ingest skips before recording a run.';

/** How many INPUT documents are represented among the indexed atoms' origins. */
const coveredCount = (facts: IngestSoundness): number => {
  const covered = new Set(facts.coveredDocIds);
  return facts.inputDocIds.filter(id => covered.has(id)).length;
};

/**
 * Refuse a dataset whose index cannot produce trustworthy numbers. Exported so
 * the guard is testable without staging a corpus that indexes nothing.
 */
export const assertIngestSound = (facts: IngestSoundness): void => {
  if (facts.indexedAtomCount === 0) fail(emptyIndexMessage(facts.datasetId), EMPTY_INDEX_CAUSE);
  const covered = coveredCount(facts);
  const ratio = covered / Math.max(facts.inputDocIds.length, 1);
  if (ratio < MIN_DOCUMENT_COVERAGE) fail(lowCoverageMessage(facts, covered), LOW_COVERAGE_CAUSE);
};

interface IndexedPathRow {
  readonly path: string;
}

/** Atom paths the index actually holds — the post-narrowing set, from the index itself. */
const indexedAtomPaths = (indexPath: string): readonly string[] => {
  const db = new Database(indexPath, { readonly: true });
  const rows = db.prepare(INDEXED_PATHS_SQL).all() as readonly IndexedPathRow[];
  db.close();
  return rows.map(row => row.path);
};

/** An atom's origin documents, read from its frontmatter `sources` — never guessed. */
const atomSources = (atomsDir: string, relPath: string): readonly string[] => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, relPath), 'utf8'));
  return parsed.ok ? parsed.atom.frontmatter.sources : [];
};

/**
 * `docs/10009203.md` → `10009203`. The basename IS the document id because
 * `materializeCorpus` names each file after it; `atom.id` is lossy (slugified,
 * SHA1-suffixed on collision) and MUST NOT be used for this.
 */
const docIdOf = (originPath: string): string => basename(originPath, MARKDOWN_EXT);

const coveredDocIds = (atomsDir: string, relPaths: readonly string[]): readonly string[] =>
  relPaths.flatMap(rel => atomSources(atomsDir, rel)).map(docIdOf);

const requirePath = (value: string | undefined, field: string): string =>
  value ?? fail(`dp-gnosis-bench: the generated profile declared no ${field}`, EMPTY_INDEX_CAUSE);

/**
 * Materialize, ingest, index, verify. Every path handed to the engine is
 * ABSOLUTE and the profile is the in-memory object — nothing is read from the
 * process's working directory and nothing is written outside `workRoot/<id>`.
 */
export const prepareDataset = async (
  options: PrepareDatasetOptions
): Promise<PreparedDataset> => {
  const workDir = resolve(options.workRoot, options.id);
  const corpus = materializeCorpus(options.docs, resolve(workDir, CORPUS_DIR_NAME));
  const profile = buildProfile({
    datasetId: options.id,
    workDir,
    corpusDirName: CORPUS_DIR_NAME,
    atomMaxChars: options.atomMaxChars,
  });
  const atomsDir = requirePath(profile.atomsDir, 'atomsDir');
  const indexPath = requirePath(profile.indexPath, 'indexPath');
  const startedAt = Date.now();
  await ingest({ corpusRoots: profile.corpusRoots, outputDir: atomsDir, repoRoot: workDir, profile });
  buildFts5Index({ atomsDir, indexPath });
  const ingestMs = Date.now() - startedAt;
  const indexed = indexedAtomPaths(indexPath);
  assertIngestSound({
    datasetId: options.id,
    indexedAtomCount: indexed.length,
    coveredDocIds: coveredDocIds(atomsDir, indexed),
    inputDocIds: [...corpus.fileNameById.keys()],
  });
  return { atomsDir, indexPath, atomCount: indexed.length, docCount: corpus.docCount, ingestMs };
};

/**
 * Which adapter to open, and — for `linear` only — at which BM25 operating
 * point. Absent `k1`/`b` mean the adapter's own defaults, so the shipped
 * configuration is what an unparameterised sweep point measures.
 */
export interface PortOptions {
  readonly adapter: AdapterName;
  readonly k1?: number | undefined;
  readonly b?: number | undefined;
  /**
   * Let the `linear` adapter keep its corpus scan in memory across calls. Absent
   * means off, which is the adapter's read-at-call-time default. Only a caller
   * that holds `atomsDir` FIXED while it varies `k1`/`b` may set it — that is
   * `sweep.ts`, whose cells differ in nothing else.
   */
  readonly cacheCorpusScan?: boolean | undefined;
}

/** The default: the adapter under measurement in `run.ts`. */
const DEFAULT_PORT_OPTIONS: PortOptions = { adapter: ADAPTER };

/**
 * `createPort` takes no tuning arguments — it is the CLI's `--adapter`
 * resolution, and BM25 parameters are not CLI flags. The `linear` branch below
 * therefore calls the SAME factory `createPort` would (`cli/adapter.ts`
 * `PORT_FACTORIES.linear`), only with the parameters attached. It is not a
 * second implementation: the scan, the tokenizer and the ranking are the
 * engine's.
 */
const openLinearPort = (prepared: PreparedDataset, options: PortOptions): KnowledgePort =>
  createLinearScanAdapter(prepared.atomsDir, {
    ...(options.k1 === undefined ? {} : { k1: options.k1 }),
    ...(options.b === undefined ? {} : { b: options.b }),
    ...(options.cacheCorpusScan === undefined ? {} : { cacheCorpusScan: options.cacheCorpusScan }),
  });

/**
 * ONE port per dataset: the first retrieve stats every atom (~700 ms at 43k),
 * so a port per query would pay that cost per topic. The caller closes it
 * (`port.close?.()`) when the dataset is done.
 */
export const openPort = (
  prepared: PreparedDataset,
  options: PortOptions = DEFAULT_PORT_OPTIONS
): KnowledgePort =>
  options.adapter === 'linear'
    ? openLinearPort(prepared, options)
    : createPort(options.adapter, prepared.atomsDir, prepared.indexPath);

/**
 * The measured call. `rawQueryText` is the dataset's query VERBATIM — the same
 * string `retrieveCommand` hands the port.
 */
export const retrieveDocs = async (
  port: KnowledgePort,
  rawQueryText: string,
  depth: number
): Promise<readonly RetrievedAtom[]> => {
  const result = await port.retrieve(rawQueryText, { k: depth });
  return result.atoms;
};

/**
 * The `--rerank` arm. A refusal FAILS the dataset: falling back to the BM25
 * order would record a rerank run that never reranked, which is the one error
 * this suite exists to make impossible. `rerankAtoms` already refuses loudly
 * when 127.0.0.1:9292 is down or serves no reranker; the message is carried
 * through verbatim.
 */
export const rerankIfRequested = async (
  query: string,
  atoms: readonly RetrievedAtom[],
  requested: boolean
): Promise<readonly RetrievedAtom[]> => {
  if (!requested) return atoms;
  const outcome = await rerankAtoms(query, atoms);
  return outcome.ok
    ? outcome.atoms
    : fail(`dp-gnosis-bench: rerank refused — ${outcome.error}`, RERANK_REFUSED_CAUSE);
};
