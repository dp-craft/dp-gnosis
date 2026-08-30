/**
 * THE SEAM: the benchmark's only contact with dp-gnosis, and it drives the
 * SHIPPED path end to end — `ingest()` → `buildFts5Index()` → `createPort()` →
 * `port.retrieve()`. Nothing here re-implements chunking, tokenizing, query
 * building or ranking; if any of those change, the numbers move. That is the
 * point of the suite (`beirIndex.ts`, the harness this replaces, built its own
 * index and its own SQL and therefore could not see an engine regression).
 *
 * Five rules, each verified against the engine source, each silent when broken:
 *
 * 1. The RAW query text goes to `port.retrieve` — `retrieveCommand.ts:349`
 *    passes exactly that, and `fts5Adapter.toMatchExpression` does the stemming
 *    via the package-wide `stemText`. Building a query or document frequencies
 *    here would measure a path production never takes.
 * 2. `fitToTokenBudget` is NOT applied HERE, ever — not in `retrieveDocs`, which
 *    runs BEFORE `rerankIfRequested`, so capping here would truncate the
 *    RERANKER'S CANDIDATE POOL and record a presentation cap as a pool cap. It is
 *    the CLI's PRESENTATION cap (`retrieveCommand.ts:342`) and at depth 100 would
 *    drop most of the ranking before it could be scored. ONE exception, and it
 *    lives in `run.ts:rankTopic` rather than in this file: behind `--budget` the
 *    cap is applied there, AFTER the rerank and immediately before
 *    `toDocumentRanking`, over `--served-k` atoms. Without `--budget` nothing is
 *    capped and the default path is unchanged to the byte.
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
 * 5. Corpus IDENTITY is asserted before ingest. Materialization prunes the docs
 *    directory to exactly the current corpus, and `assertCorpusMaterialized`
 *    proves it did. Without that, a corpus that SHRANK left its dropped
 *    documents on disk to be ingested forever as distractors — invisible to
 *    rule 4, which validates gold reachability, not corpus identity.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { buildFts5Index } from '../../gnosis/src/adapters/fts5Adapter.js';
import { buildLanceDbIndex } from '../../gnosis/src/adapters/lanceDbAdapter.js';
import {
  buildLanceDbDenseIndex,
  createLanceDbDenseAdapter,
  type DenseRoute
} from '../../gnosis/src/adapters/lanceDbDenseAdapter.js';
import { createLinearScanAdapter } from '../../gnosis/src/adapters/linearScanAdapter.js';
import { buildMiniSearchIndex } from '../../gnosis/src/adapters/miniSearchAdapter.js';
import { parseAtom } from '../../gnosis/src/atom.js';
import type { ExtractStrategy } from '../../gnosis/src/bench/reranker.js';
import {
  type AdapterName,
  createPort,
  DENSE_ROUTES,
  type DenseAdapterName,
  denseRouteOf,
  hasPersistentIndex
} from '../../gnosis/src/cli/adapter.js';
import type {
  BodySource,
  EnrichmentColumnSpec,
  FieldWeights,
  KeywordFilter,
  RerankFusion
} from '../../gnosis/src/config.js';
import { ingest, type IngestSkip, type IngestSummary } from '../../gnosis/src/ingest.js';
import type { IngestProfile } from '../../gnosis/src/ingestProfile.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievalResult,
  RetrievedAtom
} from '../../gnosis/src/port.js';
import type { PrfParams } from '../../gnosis/src/prf.js';
import type { AnalyzerId } from '../../gnosis/src/query.js';
import { probeRerankDiscrimination, rerankAtoms } from '../../gnosis/src/rerank.js';
import type { BeirDoc } from './beir.js';
import { buildProfile, materializeCorpus, type MaterializedCorpus } from './corpus.js';
import { assertIndexedGoldReachable } from './fetch/vault.js';
import { NO_ENRICHMENT } from './report.js';
import { type RankedAtom, toDocumentRanking } from './score.js';

const MARKDOWN_EXT = '.md';

/** The adapter under measurement; the one the CLI's `--adapter fts5` builds. */
const ADAPTER = 'fts5' as const;

/** `workRoot/<datasetId>/docs` — the generated markdown, inside the dataset's own dir. */
export const CORPUS_DIR_NAME = 'docs';

/** The index's own atom table (`fts5Adapter.ts:79`), read to count what was INDEXED. */
const INDEXED_PATHS_SQL = 'SELECT path FROM atom_meta';

/**
 * The build's OWN count of atoms it joined to a sidecar record, read back off
 * the stamp `buildFts5Index` writes inside the same transaction as the rows it
 * describes. Read rather than recomputed: counting the sidecar here would report
 * what was OFFERED, and the treatment under measurement is what was MERGED.
 */
const ENRICHMENT_STAMP_SQL =
  'SELECT value FROM index_meta WHERE key = \'enrichment_records\'';

/** Below this share of input documents represented in the index, the dataset fails. */
export const MIN_DOCUMENT_COVERAGE = 0.9;

/** `error.cause` when the index came out empty — the frozen-vocabulary landmine. */
export const EMPTY_INDEX_CAUSE = 'dp-gnosis-bench/empty-index';

/** `error.cause` when too few input documents survived into the index. */
export const LOW_COVERAGE_CAUSE = 'dp-gnosis-bench/low-document-coverage';

/** `error.cause` when `--rerank` was asked for and the reranker refused. */
export const RERANK_REFUSED_CAUSE = 'dp-gnosis-bench/rerank-refused';

/** `error.cause` when the arm's reranker failed the two-document discrimination probe. */
export const RERANK_PROBE_CAUSE = 'dp-gnosis-bench/rerank-probe-failed';

/** `error.cause` when the requested adapter's own index could not be produced. */
export const ADAPTER_INDEX_CAUSE = 'dp-gnosis-bench/adapter-index-unavailable';

/** `error.cause` when a port was asked for an index built for a different adapter. */
export const FOREIGN_INDEX_CAUSE = 'dp-gnosis-bench/foreign-index';

/** `error.cause` when the directory about to be ingested is not exactly the corpus. */
export const CORPUS_MISMATCH_CAUSE = 'dp-gnosis-bench/corpus-materialization-mismatch';

/** `error.cause` when the MEASURED adapter's own port reported no usable index. */
export const PORT_INDEX_STATE_CAUSE = 'dp-gnosis-bench/port-index-not-ready';

/** `error.cause` when a ready port answered nothing to every topic it was probed with. */
export const PORT_SILENT_CAUSE = 'dp-gnosis-bench/port-retrieved-nothing';

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
  /**
   * The analysis chain the fts5 index is BUILT with, stamped into it. Absent
   * means the engine's `DEFAULT_ANALYZER`, which is the chain every recorded run
   * was measured on. There is no query-side counterpart on purpose: the fts5
   * adapter reads the chain back off the stamp, so the index is the only place a
   * run can be told which analyzer produced it.
   */
  readonly analyzer?: AnalyzerId | undefined;
  /**
   * The enrichment sidecar JOINED into the index's enrichment columns, by atom
   * id. Absent — or a path with no file — leaves every enrichment column empty,
   * which is today's index byte for byte: an empty column holds no terms, so it
   * moves neither length normalisation nor any score.
   */
  readonly enrichmentPath?: string | undefined;
  /**
   * WHERE the fts5 build takes the `body` column's text from. Absent means the
   * atom body — today's index byte for byte, and what every recorded run was
   * prepared with.
   */
  readonly bodySource?: BodySource | undefined;
  /**
   * WHETHER the fts5 build drops keywords that merely re-emit body vocabulary.
   * Absent means every keyword — today's index byte for byte, and what every
   * recorded run was prepared with.
   */
  readonly keywordFilter?: KeywordFilter | undefined;
  /**
   * WHICH enrichment columns the fts5 build populates. Absent means every one of
   * them — today's index byte for byte, and what every recorded run was prepared
   * with.
   */
  readonly enrichmentColumns?: EnrichmentColumnSpec | undefined;
  /**
   * Document ids the dataset's golden set judges, handed to the engine's
   * exact-body dedupe so a mirrored document keeps the copy the judgments can
   * credit. The ids are the qrels' `corpus-id` column, which `materializeCorpus`
   * writes as `<id>.md` and `ingest` matches on the source basename — the same
   * spelling `score.ts` recovers a retrieved atom through.
   *
   * Absent — what every BEIR dataset passes — leaves the dedupe gold-blind, so
   * those runs stay byte-identical to every row already recorded.
   */
  readonly goldIds?: readonly string[] | undefined;
}

/** What one dataset's ingest+index produced, and what querying it needs. */
export interface PreparedDataset {
  readonly atomsDir: string;
  readonly indexPath: string;
  /** The adapter `indexPath` was built for; `openPort` refuses any other. */
  readonly adapter: AdapterName;
  /**
   * The analysis chain the fts5 index was BUILT with, carried so `openPort` can
   * declare it. Without the declaration the adapter reads the chain off the
   * stamp and answers under it, so an index from another chain would score the
   * run silently and the row would carry the arm's label anyway. `undefined`
   * when the arm named none, which leaves the stamp the only statement there is
   * — the state every recorded run was measured in.
   */
  readonly analyzer: AnalyzerId | undefined;
  /** Atoms actually present in the index — not atoms written to disk. */
  readonly atomCount: number;
  /**
   * Atoms the fts5 build joined to an enrichment sidecar record, read off the
   * index's own stamp. `0` when no sidecar was named — the state every recorded
   * run was prepared in.
   */
  readonly enrichmentRecords: number;
  readonly docCount: number;
  /**
   * Ingest plus the MEASURED adapter's own index build — the cost of the arm the
   * row reports. The fts5 soundness probe is charged here only when the measured
   * arm IS fts5, whose index that probe is; see `attributedIngestMs`.
   */
  readonly ingestMs: number;
  /**
   * The fts5 soundness-probe index build, paid on every arm. Reported beside
   * `ingestMs` rather than folded into it: the probe is a gate, not a cost of the
   * adapter under measurement, and dropping the number would hide a real cost.
   */
  readonly probeMs: number;
}

/** The wall-time parts of one dataset's preparation, before attribution. */
export interface PreparationCost {
  readonly adapter: AdapterName;
  /** Corpus → atoms. Every arm pays it, identically. */
  readonly ingestMs: number;
  /** The fts5 probe index build. Every arm pays it, only fts5 uses it. */
  readonly probeMs: number;
  /** The measured adapter's own index build; zero for the index-free arms. */
  readonly adapterBuildMs: number;
}

/**
 * What `ingestMs` reports. Folding the probe in charged a `lancedb` row for an
 * fts5 build it never queries, which makes the one column whose purpose is
 * per-adapter attribution wrong for exactly the adapters whose cost differs.
 * The fts5 arm still counts it, because `INDEX_BUILDERS.fts5` is a no-op that
 * reads the probe — for that arm the probe IS the measured index.
 */
export const attributedIngestMs = (cost: PreparationCost): number =>
  cost.ingestMs + (cost.adapter === ADAPTER ? cost.probeMs : 0) + cost.adapterBuildMs;

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
  'domain outside the frozen ATOM_DOMAINS vocabulary (packages/gnosis/src/config.ts), which ' +
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

/** What the corpus-identity assert judges, separated so it can be tested alone. */
export interface CorpusMaterialization {
  readonly datasetId: string;
  /** Documents the dataset's `corpus.jsonl` declares. */
  readonly corpusDocCount: number;
  /** Document files observed in the ingest directory afterwards. */
  readonly materializedFileCount: number;
}

const corpusMismatchMessage = (facts: CorpusMaterialization): string =>
  `dp-gnosis-bench: dataset "${facts.datasetId}" is about to ingest ` +
  `${facts.materializedFileCount} document files from a corpus of ${facts.corpusDocCount} ` +
  'documents. A surplus is stale output from an earlier, larger corpus: those documents are ' +
  'indexed as distractors that occupy a rank and can never be credited, so every metric is ' +
  'understated (measured on vault-hu: 114 stale files cost 0.05 nDCG@10). A deficit means ' +
  'documents were never written. Delete the dataset work directory and re-run.';

/**
 * Refuse a dataset whose ingest directory is not EXACTLY its corpus. Sibling of
 * `assertIngestSound` and the same kind of check: both refuse a run whose numbers
 * would be silently wrong rather than absent. This one runs BEFORE ingest, because
 * once a stale document is an atom nothing downstream can tell it from a real one —
 * gold reachability stays 1.0000 and the run reports no anomaly at all.
 */
export const assertCorpusMaterialized = (facts: CorpusMaterialization): void => {
  if (facts.materializedFileCount !== facts.corpusDocCount) {
    fail(corpusMismatchMessage(facts), CORPUS_MISMATCH_CAUSE);
  }
};

interface IndexedPathRow {
  readonly path: string;
}

interface StampValueRow {
  readonly value: string;
}

/**
 * How many atoms the probe index carries enrichment text for. An index built
 * before the stamp existed has no row and reads as {@link NO_ENRICHMENT} — it
 * merged nothing, because there was no sidecar to merge.
 */
const indexedEnrichmentRecords = (indexPath: string): number => {
  const db = new Database(indexPath, { readonly: true });
  const row = db.prepare(ENRICHMENT_STAMP_SQL).get() as StampValueRow | undefined;
  db.close();
  return row === undefined ? NO_ENRICHMENT : Number(row.value);
};

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

/** The indexed atoms as `score.ts` reads them — origins only, read from disk ONCE. */
const indexedOrigins = (atomsDir: string, relPaths: readonly string[]): readonly RankedAtom[] =>
  relPaths.map(rel => ({ originPaths: atomSources(atomsDir, rel) }));

const coveredDocIds = (origins: readonly RankedAtom[]): readonly string[] =>
  origins.flatMap(atom => atom.originPaths).map(docIdOf);

/**
 * The documents the index can actually return, through the SAME rollup that
 * scores a run (`originPaths[0]`'s basename, first occurrence wins). Anything
 * else here would judge reachability on a mapping no metric uses.
 */
const reachableDocIds = (origins: readonly RankedAtom[]): readonly string[] =>
  toDocumentRanking(origins);

/**
 * Gold is checked HERE, on the post-ingest corpus, because this is downstream of
 * the stage that loses it. A dataset that names no gold (every BEIR corpus) is
 * not judged: `goldIds` absent means the run measures no golden set of ours.
 */
const assertGoldIndexed = (
  options: PrepareDatasetOptions,
  origins: readonly RankedAtom[]
): void => {
  if (options.goldIds === undefined) return;
  assertIndexedGoldReachable({
    datasetId: options.id,
    goldDocIds: options.goldIds,
    reachableDocIds: reachableDocIds(origins),
  });
};

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
 *
 * `analyzer` is passed to the BUILD, which is wholesale (`buildFts5Index` removes
 * the file first): two analyzers over one dataset id therefore produce two
 * indexes in sequence, never a reused one. Nothing here may skip the build on an
 * existing file — a cached index carries the earlier chain's stamp, and the query
 * side would then analyze against a chain the run does not claim.
 */
const runIngest = async (
  paths: DatasetPaths,
  options: PrepareDatasetOptions
): Promise<IngestSummary> =>
  ingest({
    corpusRoots: paths.profile.corpusRoots,
    outputDir: paths.atomsDir,
    repoRoot: paths.workDir,
    profile: paths.profile,
    ...(options.goldIds === undefined ? {} : { goldIds: options.goldIds }),
  });

const ingestAndProbe = async (
  paths: DatasetPaths,
  options: PrepareDatasetOptions
): Promise<Omit<PreparationCost, 'adapter' | 'adapterBuildMs'>> => {
  const startedAt = Date.now();
  await runIngest(paths, options);
  const ingestedAt = Date.now();
  buildFts5Index({
    atomsDir: paths.atomsDir,
    indexPath: paths.indexPath,
    ...(options.analyzer === undefined ? {} : { analyzer: options.analyzer }),
    ...(options.enrichmentPath === undefined ? {} : { enrichmentPath: options.enrichmentPath }),
    ...(options.bodySource === undefined ? {} : { bodySource: options.bodySource }),
    ...(options.keywordFilter === undefined ? {} : { keywordFilter: options.keywordFilter }),
    ...(options.enrichmentColumns === undefined
      ? {}
      : { enrichmentColumns: options.enrichmentColumns }),
  });
  return { ingestMs: ingestedAt - startedAt, probeMs: Date.now() - ingestedAt };
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
  'lancedb-vec': '-lancedb-vec',
  'lancedb-hybrid': '-lancedb-hybrid',
  // The ONE shared stem, and the same exception `cli/adapter.ts` states: the two
  // hybrid routes build byte-identical trees and differ only in what they do
  // with the fused order, so sharing keeps the embedding sidecar warm across the
  // pair instead of re-embedding the corpus for the second arm.
  'lancedb-hybrid-full': '-lancedb-hybrid',
};

interface IndexLocation {
  readonly atomsDir: string;
  readonly indexPath: string;
}

const buildRefusedMessage = (adapter: AdapterName, datasetId: string): string =>
  `dp-gnosis-bench: dataset "${datasetId}" could not build a "${adapter}" index — the adapter's ` +
  'optional dependency did not load. Install it, or measure an arm whose adapter is available; ' +
  'querying without its own index would retrieve nothing and record an all-zero row as a result.';

/**
 * `undefined` is the ONE refusal here — the adapter's optional dependency did
 * not load, so nothing could be built. A count of 0 is a different fact (an
 * index WAS built and holds nothing) and is caught downstream by the artefact
 * and soundness probes, exactly as before this returned a flag.
 */
const requireBuilt = (
  indexed: number | undefined,
  adapter: AdapterName,
  datasetId: string
): void => {
  if (indexed === undefined) fail(buildRefusedMessage(adapter, datasetId), ADAPTER_INDEX_CAUSE);
};

/**
 * One dense builder per NAME, with the leg taken from the engine's own
 * `DENSE_ROUTES` — the bench never restates which leg a name opens.
 */
const buildDense =
  (adapter: DenseAdapterName) =>
    async (location: IndexLocation, datasetId: string): Promise<void> =>
      requireBuilt(
        await buildLanceDbDenseIndex({
          atomsDir: location.atomsDir,
          indexDir: location.indexPath,
          route: DENSE_ROUTES[adapter],
        }),
        adapter,
        datasetId
      );

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
  'lancedb-vec': buildDense('lancedb-vec'),
  'lancedb-hybrid': buildDense('lancedb-hybrid'),
  'lancedb-hybrid-full': buildDense('lancedb-hybrid-full'),
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
 * Materialize into the dataset's own `docs` directory, then PROVE that directory
 * holds exactly this corpus before a single atom is written from it.
 */
const materializeChecked = (
  options: PrepareDatasetOptions,
  paths: DatasetPaths
): MaterializedCorpus => {
  const corpus = materializeCorpus(options.docs, resolve(paths.workDir, CORPUS_DIR_NAME));
  assertCorpusMaterialized({
    datasetId: options.id,
    corpusDocCount: corpus.docCount,
    materializedFileCount: corpus.presentFileCount,
  });
  return corpus;
};

/**
 * Materialize, ingest, index, verify. Every path handed to the engine is
 * ABSOLUTE and the profile is the in-memory object — nothing is read from the
 * process's working directory and nothing is written outside `workRoot/<id>`.
 * The index BUILT is the requested arm's own, and `ingestMs` covers ingest plus
 * that build (`attributedIngestMs`); the always-built fts5 probe is reported
 * separately as `probeMs`, so no arm's cost is hidden and none is misattributed.
 */
export const prepareDataset = async (
  options: PrepareDatasetOptions
): Promise<PreparedDataset> => {
  const adapter = options.adapter ?? ADAPTER;
  const paths = datasetPaths(options);
  const corpus = materializeChecked(options, paths);
  const probed = await ingestAndProbe(paths, options);
  const indexed = indexedAtomPaths(paths.indexPath);
  const origins = indexedOrigins(paths.atomsDir, indexed);
  assertIngestSound({
    datasetId: options.id,
    indexedAtomCount: indexed.length,
    coveredDocIds: coveredDocIds(origins),
    inputDocIds: [...corpus.fileNameById.keys()],
  });
  assertGoldIndexed(options, origins);
  const built = await buildAdapterIndex({ adapter, datasetId: options.id, paths });
  return {
    atomsDir: paths.atomsDir,
    indexPath: built.indexPath,
    adapter,
    analyzer: options.analyzer,
    atomCount: indexed.length,
    enrichmentRecords: indexedEnrichmentRecords(paths.indexPath),
    docCount: corpus.docCount,
    ingestMs: attributedIngestMs({ adapter, ...probed, adapterBuildMs: built.ms }),
    probeMs: probed.probeMs,
  };
};

/** The ingest skip reason that names a surviving atom, verbatim from `ingest.ts`. */
const DUPLICATE_REASON_PREFIX = 'duplicate-body-of:';

/**
 * One document the exact-body dedupe refused, and the document whose copy of that
 * body survived in its place. Both sides are DOCUMENT ids — `score.ts`'s rollup
 * key — because a judgment credits a document, never an atom.
 */
export interface DuplicateLink {
  readonly orphanDocId: string;
  readonly survivorDocId: string;
}

const survivorAtomId = (skip: IngestSkip): string | undefined =>
  skip.reasons
    .find(reason => reason.startsWith(DUPLICATE_REASON_PREFIX))
    ?.slice(DUPLICATE_REASON_PREFIX.length);

/**
 * The refused document → the surviving one, resolved through the SURVIVOR'S OWN
 * atom file: its frontmatter `sources` is where the winning document id is
 * recorded, and `atomSources` is the same reader `prepareDataset` judges gold
 * reachability with. Nothing here re-hashes a body — the grouping decision stays
 * the engine's, and this only reads back which side it took.
 */
const duplicateLink = (atomsDir: string, skip: IngestSkip): DuplicateLink | undefined => {
  const atomId = survivorAtomId(skip);
  if (atomId === undefined) return undefined;
  const [source] = atomSources(atomsDir, `${atomId}${MARKDOWN_EXT}`);
  return source === undefined
    ? undefined
    : { orphanDocId: docIdOf(skip.source), survivorDocId: docIdOf(source) };
};

const isLink = (link: DuplicateLink | undefined): link is DuplicateLink => link !== undefined;

/**
 * The audit's THROWAWAY parent, one level under the dataset's work dir and never
 * beside its atoms. `ingest` writes AND prunes its output directory and
 * `writeManifest` writes `corpus-manifest.json` to that directory's parent, so an
 * audit run over the dataset's own `atomsDir` re-ingests the measured corpus
 * under different options and replaces it — measured on `vault`, 6628 → 6619
 * atoms, nine judged documents gone with no error anywhere (GNOSIS-GUIDE
 * § Landmines, "shared work directory destroys corpora").
 */
const AUDIT_SCRATCH_DIR = 'gold-audit-scratch';

const auditScratchDir = (options: PrepareDatasetOptions): string =>
  resolve(options.workRoot, options.id, AUDIT_SCRATCH_DIR);

/**
 * The documents the WRITTEN atoms still point back to, read off the audit's own
 * scratch atoms dir before it is removed. No index exists here, so the atom
 * files themselves are the population — the same `sources` frontmatter
 * `prepareDataset` judges reachability with.
 */
const representedDocIds = (atomsDir: string): readonly string[] =>
  readdirSync(atomsDir)
    .filter(name => name.endsWith(MARKDOWN_EXT))
    .flatMap(name => atomSources(atomsDir, name))
    .map(docIdOf);

/** What one gold audit read off a corpus the dedupe has run over. */
export interface DuplicateAudit {
  readonly links: readonly DuplicateLink[];
  /** Document ids an atom written by the audit's ingest still reaches. */
  readonly representedDocIds: readonly string[];
}

/**
 * MEASUREMENT ONLY: materialize and ingest, then report which documents the
 * exact-body dedupe orphaned and where their body survived.
 *
 * No index is built and no adapter is opened, so this costs one ingest and zero
 * GPU. It deliberately runs neither `assertIngestSound` nor `assertGoldIndexed`
 * — the whole point is to quantify a corpus those gates would refuse or, for a
 * gold-blind dataset, never look at.
 */
export const auditDuplicates = async (
  options: PrepareDatasetOptions
): Promise<DuplicateAudit> => {
  const scratch = auditScratchDir(options);
  const paths = datasetPaths({ ...options, workRoot: scratch });
  try {
    materializeChecked(options, paths);
    const summary = await runIngest(paths, options);
    return {
      links: summary.skipped.map(skip => duplicateLink(paths.atomsDir, skip)).filter(isLink),
      representedDocIds: representedDocIds(paths.atomsDir),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  /**
   * The DENSE leg's weight for a hybrid route, `0` = pure lexical and `1` = pure
   * dense. Absent means the engine's `HYBRID_FUSION`, which is what every
   * recorded hybrid row was measured under. Only a hybrid adapter reads it; the
   * flag that carries it refuses on any other, so a row can never name a leg
   * weight nothing fused with.
   */
  readonly hybridWeight?: number | undefined;
  /**
   * The `bm25()` weight per column the port READS the index with. Absent means
   * the engine's `DEFAULT_FIELD_WEIGHTS` — body only, the ranking every recorded
   * row was measured on. Only `fts5` reads it; the flag that carries it refuses
   * on any other adapter, so a row can never name a weight nothing scored with.
   */
  readonly fieldWeights?: FieldWeights | undefined;
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
/**
 * The dense counterpart of `openLinearPort`, and for the same reason: `createPort`
 * takes no tuning arguments, so a measured leg weight reaches the adapter through
 * the SAME factory `createPort` would use, with the parameter attached. The leg
 * itself comes from the engine's `DENSE_ROUTES`, never from a local table.
 */
const openDensePort = (
  prepared: PreparedDataset,
  route: DenseRoute,
  hybridWeight: number
): KnowledgePort =>
  createLanceDbDenseAdapter({
    atomsDir: prepared.atomsDir,
    indexDir: prepared.indexPath,
    route,
    now: new Date(),
    hybridWeight,
  });

/** The ports that need a parameter attached; `undefined` means the plain path. */
const openTunedPort = (
  prepared: PreparedDataset,
  options: PortOptions
): KnowledgePort | undefined => {
  if (options.adapter === 'linear') return openLinearPort(prepared, options);
  const route = denseRouteOf(options.adapter);
  return route === undefined || options.hybridWeight === undefined
    ? undefined
    : openDensePort(prepared, route, options.hybridWeight);
};

export const openPort = (
  prepared: PreparedDataset,
  options: PortOptions = DEFAULT_PORT_OPTIONS
): KnowledgePort => {
  assertPreparedFor(prepared, options.adapter);
  return (
    openTunedPort(prepared, options) ??
    createPort(options.adapter, prepared.atomsDir, prepared.indexPath, {
      ...(options.fieldWeights === undefined ? {} : { fieldWeights: options.fieldWeights }),
      ...(prepared.analyzer === undefined ? {} : { expectedAnalyzer: prepared.analyzer }),
    })
  );
};

/** How many of the dataset's own topics the post-open probe asks the port. */
export const PORT_PROBE_TOPICS = 5;

/** The probe asks only "is there ANY atom at all", so one is the whole question. */
const PROBE_K = 1;

/** What the port-soundness assert judges, separated so it can be tested alone. */
export interface PortSoundness {
  readonly datasetId: string;
  /** The adapter actually OPENED — the one whose index the numbers come from. */
  readonly adapter: AdapterName;
  /** The state each probed topic's retrieval reported, in probe order. */
  readonly indexStates: readonly IndexState[];
  readonly probedTopicCount: number;
  /** Atoms returned across the WHOLE sample — never per topic. */
  readonly totalAtomCount: number;
}

const portStateMessage = (facts: PortSoundness, state: IndexState): string =>
  `dp-gnosis-bench: dataset "${facts.datasetId}" opened its "${facts.adapter}" port and probed ` +
  `${facts.probedTopicCount} of its own judged topics, but the index reported "${state}" rather ` +
  'than "ready" — no search ran against a current index of this corpus, so every metric would be ' +
  'recorded as 0.0 as if it were a quality finding. The ingest assert cannot see this: it ' +
  'inspects the fts5 PROBE index at the unsuffixed stem, never the index this arm measures.';

const portSilentMessage = (facts: PortSoundness): string =>
  `dp-gnosis-bench: dataset "${facts.datasetId}" opened its "${facts.adapter}" port, which ` +
  `reported a ready index, yet ${facts.probedTopicCount} of the dataset's own judged topics ` +
  'returned ZERO atoms between them. A ready index that answers nothing to the queries it was ' +
  'built to serve is not a null result — the row would be all-zero and recorded as data.';

/**
 * Refuse a run whose MEASURED adapter retrieved nothing, whatever the fts5 probe
 * says. State is checked FIRST because the two diagnose differently: a non-ready
 * state names a missing or lagging index, while a ready port returning nothing
 * names an index that was built and holds no reachable atom.
 *
 * The atom count is judged over the WHOLE sample — one topic legitimately
 * matching nothing is not a defect. A dataset with zero scorable topics probes
 * nothing and passes trivially: nothing was asked, so nothing was detected.
 */
export const assertPortSound = (facts: PortSoundness): void => {
  if (facts.probedTopicCount === 0) return;
  const notReady = facts.indexStates.find(state => state !== 'ready');
  if (notReady !== undefined) fail(portStateMessage(facts, notReady), PORT_INDEX_STATE_CAUSE);
  if (facts.totalAtomCount === 0) fail(portSilentMessage(facts), PORT_SILENT_CAUSE);
};

/** The port to probe, who it belongs to, and the dataset's own query texts. */
export interface PortProbeRequest {
  readonly port: KnowledgePort;
  readonly datasetId: string;
  readonly adapter: AdapterName;
  /** Scorable query texts in dataset order; at most `PORT_PROBE_TOPICS` are asked. */
  readonly topicTexts: readonly string[];
}

/**
 * Collect the facts by calling `port.retrieve` DIRECTLY — `retrieveDocs` drops
 * `indexState`, which is half of what this gate reads.
 *
 * It changes what a run REFUSES, never what it MEASURES: the probe is its own
 * `k=1` call and no result of it reaches scoring. Its one measurable effect is
 * on ATTRIBUTION of cost — the port's one-time cold work (the corpus-mtime
 * sweep, the index open) is now paid here instead of landing on topic 1's
 * `queryMs`, so the p50/p95 medians the suite reports are unmoved.
 *
 * Sequential by design, exactly like the measured loop (`rankAllTopics`): one
 * port, one index, one query at a time. Concurrent probes are not merely
 * redundant here, they are unsafe — the adapters cache their handle in a plain
 * mutable cell with no single-flight guard, so simultaneous first-calls all see
 * an empty cell, all reopen, and each reopen releases the connection a sibling
 * probe is about to read.
 */
export const probePortSoundness = async (request: PortProbeRequest): Promise<void> => {
  const sample = request.topicTexts.slice(0, PORT_PROBE_TOPICS);
  const results = await sample.reduce<Promise<readonly RetrievalResult[]>>(
    async (pending, text) => [
      ...(await pending),
      await request.port.retrieve(text, { k: PROBE_K }),
    ],
    Promise.resolve([])
  );
  assertPortSound({
    datasetId: request.datasetId,
    adapter: request.adapter,
    indexStates: results.map(result => result.indexState),
    probedTopicCount: sample.length,
    totalAtomCount: results.reduce((total, result) => total + result.atoms.length, 0),
  });
};

/**
 * The measured call. `rawQueryText` is the dataset's query VERBATIM — the same
 * string `retrieveCommand` hands the port.
 *
 * `prf` is the RM3 term model the port builds from its OWN first pass — the
 * bench names the three knobs and never computes a weight, so the expansion the
 * engine ships is what gets measured. Absent, the option is `undefined` and the
 * call is the one every recorded run made, byte for byte.
 *
 * A port that reports an un-truncated pool (`lancedb-hybrid-full`) is measured on
 * THAT pool: it is the candidate set the arm exists to hand the reranker, and its
 * head is `result.atoms` by construction, so a BM25-only arm over the same port
 * scores exactly what it scored before. Every other port reports no pool and is
 * read as it always was. The realised pool SIZE is `result.poolAtoms.length` —
 * it varies with the query and with how much the two legs overlapped, is bounded
 * by `2 * depth` (a union of two top-`depth` lists) and lands near `1.55 *
 * depth` on the real corpora. A reranker arm therefore costs ~1.5× a plain one,
 * not ~16×.
 */
export const retrieveDocs = async (
  port: KnowledgePort,
  rawQueryText: string,
  depth: number,
  adjacency = false,
  prf?: PrfParams
): Promise<readonly RetrievedAtom[]> => {
  // The key is OMITTED when no expansion was asked for: `RetrieveOptions.prf`
  // is optional and present-but-undefined is a different state under
  // `exactOptionalPropertyTypes`.
  const result = await port.retrieve(rawQueryText, {
    k: depth,
    adjacency,
    ...(prf === undefined ? {} : { prf }),
  });
  return result.poolAtoms ?? result.atoms;
};

/**
 * The `--rerank` arm. A refusal FAILS the dataset: falling back to the BM25
 * order would record a rerank run that never reranked, which is the one error
 * this suite exists to make impossible. `rerankAtoms` already refuses loudly
 * when 127.0.0.1:9292 is down or serves no reranker; the message is carried
 * through verbatim.
 *
 * `arm` is passed straight through to the engine: `fusion` is the ENGINE's own
 * resolution of a named protocol, and `model` the cross-encoder id it scores
 * with. Omitting either measures the shipped default, so this stays the one seam
 * — the bench selects a rule and a model, it never builds one.
 */
/**
 * A measured rerank arm. It pins `backend: 'http'` at both call sites below
 * rather than carrying the key: a bench row names the model and the pool it was
 * measured under, and an exported `DP_GNOSIS_RERANK_BACKEND` that silently swapped
 * the SCORER would produce a row indistinguishable from the served one.
 */
export interface RerankArm {
  readonly fusion?: RerankFusion;
  /** Absent means the engine's shipped `RERANK_MODEL_ID` — today's every run. */
  readonly model?: string | undefined;
  /**
   * WHAT the reranker is shown — how much of an atom body, and which part.
   * Absent on either means the engine's shipped `RERANK_DOC_MAX_CHARS` /
   * `EXTRACT_STRATEGY`, so an arm that names neither is bit-identical.
   */
  readonly rerankDocMaxChars?: number | undefined;
  readonly rerankExtract?: ExtractStrategy | undefined;
}

export const rerankIfRequested = async (
  query: string,
  atoms: readonly RetrievedAtom[],
  requested: boolean,
  arm: RerankArm = {}
): Promise<readonly RetrievedAtom[]> => {
  if (!requested) return atoms;
  const outcome = await rerankAtoms(query, atoms, { ...arm, backend: 'http' });
  return outcome.ok
    ? outcome.atoms
    : fail(`dp-gnosis-bench: rerank refused — ${outcome.error}`, RERANK_REFUSED_CAUSE);
};

/**
 * The rerank arm's ENTRY GATE, run once per dataset before its first rerank
 * call. A reranker whose rank head this llama.cpp build does not support answers
 * HTTP 200 with well-formed scores that do not depend on the document; the arm
 * then completes and records "reranking barely helped" — a plausible number, the
 * project's worst failure class. Nothing downstream of `rerankAtoms` can see it,
 * so it is asserted HERE, on a fixed pair, before any topic is scored.
 *
 * The engine owns the probe and its message; this carries the message through
 * verbatim, exactly as `rerankIfRequested` carries a refusal.
 */
export const assertRerankDiscriminates = async (arm: RerankArm = {}): Promise<void> => {
  const outcome = await probeRerankDiscrimination({ ...arm, backend: 'http' });
  if (!outcome.ok) {
    fail(`dp-gnosis-bench: rerank discrimination probe FAILED — ${outcome.error}`, RERANK_PROBE_CAUSE);
  }
};
