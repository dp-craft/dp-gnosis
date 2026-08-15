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
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { buildFts5Index } from '../../dp-gnosis/src/adapters/fts5Adapter.js';
import { buildLanceDbIndex } from '../../dp-gnosis/src/adapters/lanceDbAdapter.js';
import { createLinearScanAdapter } from '../../dp-gnosis/src/adapters/linearScanAdapter.js';
import { buildMiniSearchIndex } from '../../dp-gnosis/src/adapters/miniSearchAdapter.js';
import { parseAtom } from '../../dp-gnosis/src/atom.js';
import {
  type AdapterName,
  createPort,
  hasPersistentIndex
} from '../../dp-gnosis/src/cli/adapter.js';
import { ingest } from '../../dp-gnosis/src/ingest.js';
import type { IngestProfile } from '../../dp-gnosis/src/ingestProfile.js';
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

/** `error.cause` when the requested adapter's own index could not be produced. */
export const ADAPTER_INDEX_CAUSE = 'dp-gnosis-bench/adapter-index-unavailable';

/** `error.cause` when a port was asked for an index built for a different adapter. */
export const FOREIGN_INDEX_CAUSE = 'dp-gnosis-bench/foreign-index';

/** One dataset's corpus, in memory, plus where it may write. */
export interface PrepareDatasetOptions {
  readonly id: string;
  readonly docs: readonly BeirDoc[];
  /** Absolute root; this dataset owns `workRoot/<id>` exclusively. */
  readonly workRoot: string;
  /** Per-corpus atom cap; absent means the shipped `ATOM_MAX_CHARS`. */
  readonly atomMaxChars?: number | undefined;
  /**
   * The arm this dataset is being prepared for. Absent means `fts5`, the arm the
   * recorded history was measured on. It decides which index is BUILT, and the
   * prepared dataset carries it so `openPort` can refuse a foreign one.
   */
  readonly adapter?: AdapterName | undefined;
}

/** What one dataset's ingest+index produced, and what querying it needs. */
export interface PreparedDataset {
  readonly atomsDir: string;
  readonly indexPath: string;
  /** The adapter `indexPath` was built for; `openPort` refuses any other. */
  readonly adapter: AdapterName;
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

/** Where one dataset writes, and the profile the engine ingests it under. */
interface DatasetPaths {
  readonly workDir: string;
  readonly atomsDir: string;
  /** The fts5 probe index, and the stem every other arm's artefact hangs off. */
  readonly indexPath: string;
  readonly profile: IngestProfile;
}

const datasetPaths = (options: PrepareDatasetOptions): DatasetPaths => {
  const workDir = resolve(options.workRoot, options.id);
  const profile = buildProfile({
    datasetId: options.id,
    workDir,
    corpusDirName: CORPUS_DIR_NAME,
    atomMaxChars: options.atomMaxChars,
  });
  return {
    workDir,
    profile,
    atomsDir: requirePath(profile.atomsDir, 'atomsDir'),
    indexPath: requirePath(profile.indexPath, 'indexPath'),
  };
};

/**
 * Ingest, then build the fts5 PROBE index. The probe is built on every arm, not
 * only the fts5 one, because it is the sole artefact this suite can enumerate
 * (`atom_meta`) without re-implementing an adapter's internals — and the fact it
 * proves, that ingest survived the frozen `ATOM_DOMAINS` narrowing with enough
 * document coverage, is a property of the INGEST, which every arm shares. Two
 * arms are therefore comparable on `atomCount` as well as on their metrics.
 */
const ingestAndProbe = async (paths: DatasetPaths): Promise<number> => {
  const startedAt = Date.now();
  await ingest({
    corpusRoots: paths.profile.corpusRoots,
    outputDir: paths.atomsDir,
    repoRoot: paths.workDir,
    profile: paths.profile,
  });
  buildFts5Index({ atomsDir: paths.atomsDir, indexPath: paths.indexPath });
  return Date.now() - startedAt;
};

/**
 * Each arm's artefact gets its OWN path off the shared stem: `linear` reads the
 * atoms directory and `fts5` reads the probe, so both keep the stem itself,
 * while `minisearch` writes a JSON file and `lancedb` writes a DIRECTORY tree —
 * two arms sharing one path would corrupt each other.
 */
const INDEX_SUFFIXES: Readonly<Record<AdapterName, string>> = {
  linear: '',
  fts5: '',
  minisearch: '-minisearch.json',
  lancedb: '-lancedb',
};

interface IndexLocation {
  readonly atomsDir: string;
  readonly indexPath: string;
}

const buildRefusedMessage = (adapter: AdapterName, datasetId: string): string =>
  `dp-gnosis-bench: dataset "${datasetId}" could not build a "${adapter}" index — the adapter's ` +
  'optional dependency did not load. Install it, or measure an arm whose adapter is available; ' +
  'querying without its own index would retrieve nothing and record an all-zero row as a result.';

const requireBuilt = (built: boolean, adapter: AdapterName, datasetId: string): void => {
  if (!built) fail(buildRefusedMessage(adapter, datasetId), ADAPTER_INDEX_CAUSE);
};

/**
 * One builder per adapter, total over the vocabulary so a new adapter cannot be
 * measured until its index path is stated. `linear` scans the atoms directory and
 * `fts5` reads the probe already built above, so neither builds anything here.
 */
const INDEX_BUILDERS: Readonly<
  Record<AdapterName, (location: IndexLocation, datasetId: string) => Promise<void>>
> = {
  linear: async (): Promise<void> => undefined,
  fts5: async (): Promise<void> => undefined,
  minisearch: async (location, datasetId): Promise<void> =>
    requireBuilt(await buildMiniSearchIndex(location), 'minisearch', datasetId),
  lancedb: async (location, datasetId): Promise<void> =>
    requireBuilt(
      await buildLanceDbIndex({ atomsDir: location.atomsDir, indexDir: location.indexPath }),
      'lancedb',
      datasetId
    ),
};

const missingArtefactMessage = (adapter: AdapterName, indexPath: string): string =>
  `dp-gnosis-bench: the "${adapter}" index at ${indexPath} does not exist after its build — ` +
  'a port opened against it would retrieve nothing and record an all-zero row as a result.';

/** POSITIVE check: the artefact this adapter needs is on disk, at its own path. */
const assertIndexArtefact = (adapter: AdapterName, indexPath: string): void => {
  if (hasPersistentIndex(adapter) && !existsSync(indexPath)) {
    fail(missingArtefactMessage(adapter, indexPath), ADAPTER_INDEX_CAUSE);
  }
};

interface AdapterIndexRequest {
  readonly adapter: AdapterName;
  readonly datasetId: string;
  readonly paths: DatasetPaths;
}

interface BuiltIndex {
  readonly indexPath: string;
  readonly ms: number;
}

const buildAdapterIndex = async (request: AdapterIndexRequest): Promise<BuiltIndex> => {
  const indexPath = `${request.paths.indexPath}${INDEX_SUFFIXES[request.adapter]}`;
  const startedAt = Date.now();
  const location: IndexLocation = { atomsDir: request.paths.atomsDir, indexPath };
  await INDEX_BUILDERS[request.adapter](location, request.datasetId);
  assertIndexArtefact(request.adapter, indexPath);
  return { indexPath, ms: Date.now() - startedAt };
};

/**
 * Materialize, ingest, index, verify. Every path handed to the engine is
 * ABSOLUTE and the profile is the in-memory object — nothing is read from the
 * process's working directory and nothing is written outside `workRoot/<id>`.
 * The index BUILT is the requested arm's own; `ingestMs` covers ingest, the
 * probe and that build, so an arm's index cost is never hidden.
 */
export const prepareDataset = async (
  options: PrepareDatasetOptions
): Promise<PreparedDataset> => {
  const adapter = options.adapter ?? ADAPTER;
  const paths = datasetPaths(options);
  const corpus = materializeCorpus(options.docs, resolve(paths.workDir, CORPUS_DIR_NAME));
  const probeMs = await ingestAndProbe(paths);
  const indexed = indexedAtomPaths(paths.indexPath);
  assertIngestSound({
    datasetId: options.id,
    indexedAtomCount: indexed.length,
    coveredDocIds: coveredDocIds(paths.atomsDir, indexed),
    inputDocIds: [...corpus.fileNameById.keys()],
  });
  const built = await buildAdapterIndex({ adapter, datasetId: options.id, paths });
  return {
    atomsDir: paths.atomsDir,
    indexPath: built.indexPath,
    adapter,
    atomCount: indexed.length,
    docCount: corpus.docCount,
    ingestMs: probeMs + built.ms,
  };
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

const foreignIndexMessage = (requested: AdapterName, prepared: AdapterName): string =>
  `dp-gnosis-bench: refusing to open the "${requested}" adapter over an index prepared for ` +
  `"${prepared}" — the two formats are not interchangeable, and the port would either throw on ` +
  'a foreign file or retrieve nothing and record an all-zero row as a result. Prepare the ' +
  `dataset with adapter "${requested}".`;

/**
 * The silent-zero guard, and it is POSITIVE: the artefact must have been built
 * FOR the requested adapter, which is a recorded fact of `prepareDataset`, not
 * an error string to pattern-match. It fires before the query loop, so no metric
 * row can be produced from a foreign index. `linear` is exempt because it reads
 * the atoms directory and opens no index at all (`hasPersistentIndex`).
 */
const assertPreparedFor = (prepared: PreparedDataset, requested: AdapterName): void => {
  if (hasPersistentIndex(requested) && requested !== prepared.adapter) {
    fail(foreignIndexMessage(requested, prepared.adapter), FOREIGN_INDEX_CAUSE);
  }
};

/**
 * ONE port per dataset: the first retrieve stats every atom (~700 ms at 43k),
 * so a port per query would pay that cost per topic. The caller closes it
 * (`port.close?.()`) when the dataset is done.
 */
export const openPort = (
  prepared: PreparedDataset,
  options: PortOptions = DEFAULT_PORT_OPTIONS
): KnowledgePort => {
  assertPreparedFor(prepared, options.adapter);
  return options.adapter === 'linear'
    ? openLinearPort(prepared, options)
    : createPort(options.adapter, prepared.atomsDir, prepared.indexPath);
};

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
