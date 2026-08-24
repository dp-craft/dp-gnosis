import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildLanceDbIndex } from '../../dp-gnosis/src/adapters/lanceDbAdapter.js';
import type { AdapterName } from '../../dp-gnosis/src/cli/adapter.js';
import { runCli } from '../../dp-gnosis/src/cli/cli.js';
import { RERANK_MODEL_ID } from '../../dp-gnosis/src/config.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievedAtom,
  RetrieveOptions
} from '../../dp-gnosis/src/port.js';
import { type AnalyzerId, DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import type { BeirDoc } from './beir.js';
import {
  assertCorpusMaterialized,
  assertIngestSound,
  assertPortSound,
  assertRerankDiscriminates,
  attributedIngestMs,
  auditDuplicates,
  CORPUS_MISMATCH_CAUSE,
  EMPTY_INDEX_CAUSE,
  LOW_COVERAGE_CAUSE,
  openPort,
  PORT_INDEX_STATE_CAUSE,
  PORT_SILENT_CAUSE,
  prepareDataset,
  type PreparedDataset,
  probePortSoundness,
  RERANK_PROBE_CAUSE,
  rerankIfRequested,
  retrieveDocs
} from './engine.js';
import { UNREACHABLE_GOLD_CAUSE } from './fetch/vault.js';
import { auditGold, type GoldAudit } from './goldAudit.js';
import type { Qrel } from './metrics.js';
import { defaultAtomType } from '../../dp-gnosis/src/vocabulary.js';

/** A second reranker id — any id the shipped constant is not. */
const OTHER_MODEL = 'jina-reranker-v2-base-multilingual';

const DATASET_ID = 'fixture';
const DEPTH = 5;

const root = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-engine-'));

/** Every file under `dir`, as `relative path → bytes` — the before/after evidence D1 needs. */
const snapshotTree = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = resolve(entry.parentPath, entry.name);
      return `${path.slice(dir.length)}\u0000${readFileSync(path, 'utf8')}`;
    })
    .sort();

const isAtomEntry = (row: string): boolean => row.includes('-atoms/');

const docs: readonly BeirDoc[] = [
  {
    id: 'd1',
    title: 'Photosynthesis in marine algae',
    text: 'Marine algae convert sunlight into chemical energy using chlorophyll pigments.',
  },
  {
    id: 'd2',
    title: 'Mitochondrial respiration',
    text: 'Mitochondria oxidise pyruvate to produce adenosine triphosphate for the cell.',
  },
  {
    id: 'd3',
    title: 'Antibiotic resistance plasmids',
    text: 'Bacteria exchange plasmids carrying resistance genes against common antibiotics.',
  },
  {
    id: 'd4',
    title: 'Glacier retreat measurements',
    text: 'Satellite altimetry records the retreat of alpine glaciers over four decades.',
  },
];

const queries: readonly string[] = [
  'how do marine algae capture sunlight',
  'production of adenosine triphosphate in the cell',
  'plasmid exchange and antibiotic resistance in bacteria',
];

const atomIds = (atoms: readonly RetrievedAtom[]): readonly string[] => atoms.map(atom => atom.id);

let prepared: PreparedDataset;
let port: KnowledgePort;

beforeAll(async () => {
  prepared = await prepareDataset({ id: DATASET_ID, docs, workRoot: root });
  port = openPort(prepared);
});

afterAll(() => {
  port.close?.();
  rmSync(root, { recursive: true, force: true });
});

describe('prepareDataset', () => {
  it('indexes atoms for every fixture document and passes the soundness assert', () => {
    expect(prepared.atomCount).toBeGreaterThan(0);
    expect(prepared.docCount).toBe(docs.length);
    expect(prepared.ingestMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the dataset in its own parent directory, with absolute paths', () => {
    expect(isAbsolute(prepared.atomsDir)).toBe(true);
    expect(isAbsolute(prepared.indexPath)).toBe(true);
    expect(prepared.atomsDir.startsWith(resolve(root, DATASET_ID))).toBe(true);
    expect(prepared.indexPath.startsWith(resolve(root, DATASET_ID))).toBe(true);
  });
});

/**
 * PER-ADAPTER PREPARATION. `prepareDataset` used to build the fts5 index alone
 * and hand that one path to whatever adapter `openPort` was asked for:
 * `minisearch` parsed a SQLite file as JSON and threw, and `lancedb` found no
 * dataset, retrieved nothing, and recorded an all-zero row as if it were a
 * quality finding. Each arm must be measured on the index built FOR it.
 */
describe('prepareDataset — per-adapter index', () => {
  const atomsFor = async (adapter: AdapterName): Promise<number> => {
    const scoped = await prepareDataset({
      id: `${DATASET_ID}-${adapter}`,
      docs,
      workRoot: root,
      adapter,
    });
    const scopedPort = openPort(scoped, { adapter });
    const atoms = await retrieveDocs(scopedPort, queries[0]!, DEPTH);
    scopedPort.close?.();
    return atoms.length;
  };

  it('builds the minisearch index its own port reads', async () => {
    expect(await atomsFor('minisearch')).toBeGreaterThan(0);
  });

  it('builds the lancedb dataset its own port reads', async () => {
    expect(await atomsFor('lancedb')).toBeGreaterThan(0);
  }, 180_000);
});

/**
 * COST ATTRIBUTION. The fts5 soundness probe is built on EVERY arm, so charging
 * it to `ingestMs` made a lancedb row read as "lancedb build + an unrelated fts5
 * build" — the one column whose whole purpose is per-adapter attribution. The
 * probe still runs and still gates; only what is REPORTED moves.
 */
describe('attributedIngestMs', () => {
  const cost = { ingestMs: 100, probeMs: 50, adapterBuildMs: 7 };

  it('excludes the fts5 probe build from an arm that does not use that index', () => {
    expect(attributedIngestMs({ adapter: 'lancedb', ...cost })).toBe(107);
    expect(attributedIngestMs({ adapter: 'minisearch', ...cost })).toBe(107);
  });

  it('counts the probe for the fts5 arm, whose own index the probe IS', () => {
    expect(attributedIngestMs({ adapter: 'fts5', ...cost })).toBe(157);
  });

  it('charges the index-free linear arm its ingest alone', () => {
    expect(attributedIngestMs({ adapter: 'linear', ...cost, adapterBuildMs: 0 })).toBe(100);
  });
});

describe('prepareDataset — cost attribution', () => {
  it('reports the probe build as its own number rather than discarding it', () => {
    expect(prepared.probeMs).toBeGreaterThanOrEqual(0);
    expect(prepared.ingestMs).toBeGreaterThanOrEqual(prepared.probeMs);
  });

  it('changes no quality-bearing output — a re-prepared arm indexes and ranks identically', async () => {
    const again = await prepareDataset({ id: `${DATASET_ID}-again`, docs, workRoot: root });
    expect(again.atomCount).toBe(prepared.atomCount);
    expect(again.docCount).toBe(prepared.docCount);
    const againPort = openPort(again);
    const ranking = atomIds(await retrieveDocs(againPort, queries[0]!, DEPTH));
    againPort.close?.();
    expect(ranking).toEqual(atomIds(await retrieveDocs(port, queries[0]!, DEPTH)));
  });
});

/**
 * PER-ANALYZER PREPARATION. The chain is applied at BUILD time and stamped into
 * the index; the query side reads it back off that stamp, so a reused index from
 * another chain would analyze every query under a label the run does not claim.
 * `buildFts5Index` rebuilds wholesale, and these two cases are what proves it.
 */
describe('prepareDataset — per-analyzer index', () => {
  const ANALYZER_DATASET = `${DATASET_ID}-analyzer`;
  /** Singular; the corpus holds only "pigments", so only a stemmer can match it. */
  const STEMMED_QUERY = 'pigment';

  const prepareWith = async (analyzer?: AnalyzerId): Promise<PreparedDataset> =>
    prepareDataset({
      id: ANALYZER_DATASET,
      docs,
      workRoot: root,
      ...(analyzer === undefined ? {} : { analyzer }),
    });

  const stampOf = (indexPath: string): string | undefined => {
    const db = new Database(indexPath, { readonly: true });
    const row = db.prepare('SELECT value AS value FROM index_meta WHERE key = ?').get('analyzer') as
      | { readonly value?: string }
      | undefined;
    db.close();
    return row?.value;
  };

  const hitsFor = async (scoped: PreparedDataset): Promise<number> => {
    const scopedPort = openPort(scoped);
    const atoms = await retrieveDocs(scopedPort, STEMMED_QUERY, DEPTH);
    scopedPort.close?.();
    return atoms.length;
  };

  it('stamps the DEFAULT chain when the caller names none', async () => {
    expect(stampOf((await prepareWith()).indexPath)).toBe(DEFAULT_ANALYZER);
  });

  it('REBUILDS under the named chain rather than reusing the index already there', async () => {
    const porter = await prepareWith('porter-fold');
    const porterHits = await hitsFor(porter);
    const nostem = await prepareWith('nostem-fold');
    expect(nostem.indexPath).toBe(porter.indexPath);
    expect(stampOf(nostem.indexPath)).toBe('nostem-fold');
    expect(porterHits).toBeGreaterThan(0);
    expect(await hitsFor(nostem)).toBeLessThan(porterHits);
  });
});

/**
 * The silent-zero guard: an adapter needing a persistent index MUST NOT be
 * opened against an index another adapter built. Refusing at `openPort` fires
 * before the query loop, so no metric row can be produced from a foreign index.
 */
describe('openPort — foreign index refusal', () => {
  it('refuses a persistent-index adapter the dataset was not prepared for', () => {
    expect(() => openPort(prepared, { adapter: 'minisearch' })).toThrow(/minisearch/);
    expect(() => openPort(prepared, { adapter: 'lancedb' })).toThrow(/lancedb/);
  });

  it('still opens the index-free linear adapter over any prepared dataset', () => {
    const linear = openPort(prepared, { adapter: 'linear' });
    expect(linear.name).toBe('linear-scan');
    linear.close?.();
  });

  /**
   * A tuned leg weight reaches the adapter the way `k1`/`b` reach `linear` — the
   * engine's own factory, with the parameter attached. The dataset is opened
   * lazily, so no dense index has to exist for the wiring to be observable.
   */
  it('opens a hybrid route with the leg weight attached', () => {
    const hybrid: PreparedDataset = { ...prepared, adapter: 'lancedb-hybrid-full' };
    const tuned = openPort(hybrid, { adapter: 'lancedb-hybrid-full', hybridWeight: 0.8 });
    expect(tuned.name).toBe('lancedb-hybrid-full');
    tuned.close?.();
  });
});

describe('assertIngestSound', () => {
  it('throws with a named cause when nothing was indexed', () => {
    const act = (): void =>
      assertIngestSound({
        datasetId: 'nfcorpus',
        indexedAtomCount: 0,
        coveredDocIds: [],
        inputDocIds: ['a', 'b'],
      });
    expect(act).toThrow(/indexed ZERO atoms.*ATOM_DOMAINS/s);
    expect(act).toThrow(expect.objectContaining({ cause: EMPTY_INDEX_CAUSE }));
  });

  it('throws with a named cause when fewer than 90% of documents are represented', () => {
    const inputDocIds = Array.from({ length: 10 }, (_unused, index) => `d${index}`);
    const act = (): void =>
      assertIngestSound({
        datasetId: 'nfcorpus',
        indexedAtomCount: 8,
        coveredDocIds: inputDocIds.slice(0, 8),
        inputDocIds,
      });
    expect(act).toThrow(/covering only 8 of 10 documents/);
    expect(act).toThrow(expect.objectContaining({ cause: LOW_COVERAGE_CAUSE }));
  });

  it('accepts exactly the 90% floor', () => {
    const inputDocIds = Array.from({ length: 10 }, (_unused, index) => `d${index}`);
    expect(() =>
      assertIngestSound({
        datasetId: 'nfcorpus',
        indexedAtomCount: 9,
        coveredDocIds: inputDocIds.slice(0, 9),
        inputDocIds,
      })
    ).not.toThrow();
  });
});

describe('assertCorpusMaterialized', () => {
  it('throws naming both counts when stale documents outnumber the corpus', () => {
    const act = (): void =>
      assertCorpusMaterialized({
        datasetId: 'vault-hu',
        corpusDocCount: 454,
        materializedFileCount: 568,
      });
    expect(act).toThrow(/vault-hu.*568 document files.*454 documents/s);
    expect(act).toThrow(expect.objectContaining({ cause: CORPUS_MISMATCH_CAUSE }));
  });

  it('accepts a directory holding exactly the corpus', () => {
    expect(() =>
      assertCorpusMaterialized({
        datasetId: 'vault-hu',
        corpusDocCount: 454,
        materializedFileCount: 454,
      })
    ).not.toThrow();
  });
});

/**
 * THE ADAPTER-BLIND GATE. `assertIngestSound` reads the fts5 PROBE index at the
 * unsuffixed stem whatever adapter is under measurement, so a `lancedb` /
 * `minisearch` index that indexed NOTHING passed it and recorded all-zero
 * metrics as data. This assert judges the port that actually answers the
 * queries, and only that.
 */
describe('assertPortSound', () => {
  const facts = (over: Partial<Parameters<typeof assertPortSound>[0]>): void =>
    assertPortSound({
      datasetId: 'vault-hu',
      adapter: 'lancedb',
      indexStates: ['ready', 'ready'],
      probedTopicCount: 2,
      totalAtomCount: 7,
      ...over,
    });

  const notReady: readonly IndexState[] = ['unavailable', 'empty', 'stale'];

  it.each(notReady)('throws with the state cause when a probe reported "%s"', state => {
    const act = (): void => facts({ indexStates: ['ready', state] });
    expect(act).toThrow(new RegExp(`reported "${state}"`));
    expect(act).toThrow(expect.objectContaining({ cause: PORT_INDEX_STATE_CAUSE }));
  });

  /** A DIFFERENT diagnosis: the index exists and is current, and holds nothing reachable. */
  it('throws with the silent cause when a ready port returned nothing at all', () => {
    const act = (): void => facts({ totalAtomCount: 0 });
    expect(act).toThrow(/ready index, yet 2 of the dataset's own judged topics returned ZERO/);
    expect(act).toThrow(expect.objectContaining({ cause: PORT_SILENT_CAUSE }));
  });

  /** The TOTAL is judged, never a topic: one topic matching nothing is not a defect. */
  it('accepts a sample whose atoms all came from one topic', () => {
    expect(() => facts({ probedTopicCount: 3, indexStates: ['ready', 'ready', 'ready'] })).not
      .toThrow();
  });

  it('passes trivially when there was nothing to probe', () => {
    expect(() => facts({ indexStates: [], probedTopicCount: 0, totalAtomCount: 0 })).not.toThrow();
  });
});

/**
 * The end-to-end form of the gate, on the adapter that motivated it. The empty
 * index is built DELIBERATELY — `prepareDataset` would refuse this corpus at
 * `assertIngestSound` long before a port opened, which is exactly why the port
 * gate has to exist separately.
 */
describe('probePortSoundness', () => {
  it('REFUSES a lancedb port opened over an index that indexed nothing', async () => {
    const atomsDir = resolve(root, 'empty-lancedb', 'atoms');
    const indexPath = resolve(root, 'empty-lancedb', 'index-lancedb');
    mkdirSync(atomsDir, { recursive: true });
    expect(await buildLanceDbIndex({ atomsDir, indexDir: indexPath })).toBe(0);
    const empty: PreparedDataset = {
      atomsDir,
      indexPath,
      adapter: 'lancedb',
      atomCount: 0,
      enrichmentRecords: 0,
      docCount: 0,
      ingestMs: 0,
      probeMs: 0,
    };
    const emptyPort = openPort(empty, { adapter: 'lancedb' });
    await expect(
      probePortSoundness({
        port: emptyPort,
        datasetId: 'empty-lancedb',
        adapter: 'lancedb',
        topicTexts: queries,
      })
    ).rejects.toThrow(expect.objectContaining({ cause: PORT_INDEX_STATE_CAUSE }));
    emptyPort.close?.();
  }, 180_000);

  /** The regression side: the healthy fts5 arm every recorded run measured still passes. */
  it('accepts the healthy fts5 dataset', async () => {
    await expect(
      probePortSoundness({ port, datasetId: DATASET_ID, adapter: 'fts5', topicTexts: queries })
    ).resolves.toBeUndefined();
  });

  /**
   * The concurrency regression: the adapters cache their handle in an unguarded
   * mutable cell, so two probes in flight at once can close each other's
   * connection. The probe must never have more than one retrieve outstanding.
   */
  it('never has two retrieves in flight at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const serialPort: KnowledgePort = {
      name: 'serial-probe',
      retrieve: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(done => setTimeout(done, 1));
        inFlight -= 1;
        return { atoms: [], mode: 'stub', indexState: 'ready' };
      },
    };
    await probePortSoundness({
      port: serialPort,
      datasetId: 'serial-probe',
      adapter: 'fts5',
      topicTexts: ['a', 'b', 'c'],
    }).catch(() => undefined);
    expect(maxInFlight).toBe(1);
  });
});

describe('retrieveDocs', () => {
  it('returns atoms whose first origin path names a fixture document', async () => {
    const atoms = await retrieveDocs(port, queries[0]!, DEPTH);
    expect(atoms.length).toBeGreaterThan(0);
    const originIds = atoms.map(atom => basename(atom.originPaths[0] ?? '', '.md'));
    expect(originIds.every(id => docs.some(doc => doc.id === id))).toBe(true);
    expect(originIds[0]).toBe('d1');
  });

  it('ranks the topically matching document first for each query', async () => {
    const rankings = await Promise.all(
      queries.map(query => retrieveDocs(port, query, DEPTH))
    );
    const tops = rankings.map(atoms => basename(atoms[0]?.originPaths[0] ?? '', '.md'));
    expect(tops).toEqual(['d1', 'd2', 'd3']);
  });

  /**
   * The un-truncated route hands the reranker the whole union; the port's own
   * `atoms` stays capped at `k`. A route that reports no pool is unaffected.
   */
  it('hands the reranker the POOL when the port reports one, its atoms otherwise', async () => {
    const atom = (id: string): RetrievedAtom => ({
      id,
      title: id,
      domain: 'docs',
      type: defaultAtomType(),
      body: id,
      score: 1,
      sourcePath: `${id}.md`,
      originPaths: [`docs/${id}.md`],
    });
    const pooled: KnowledgePort = {
      name: 'lancedb-hybrid-full',
      retrieve: async () =>
        await Promise.resolve({
          atoms: [atom('a')],
          poolAtoms: [atom('a'), atom('b'), atom('c')],
          mode: 'lancedb-hybrid-full',
          indexState: 'ready' as IndexState,
        }),
    };
    const plain: KnowledgePort = {
      name: 'lancedb-hybrid',
      retrieve: async () =>
        await Promise.resolve({
          atoms: [atom('a')],
          mode: 'lancedb-hybrid',
          indexState: 'ready' as IndexState,
        }),
    };

    expect((await retrieveDocs(pooled, 'q', 1)).map(a => a.id)).toEqual(['a', 'b', 'c']);
    expect((await retrieveDocs(plain, 'q', 1)).map(a => a.id)).toEqual(['a']);
  });

  /**
   * The query-adjacency treatment is applied by the PORT, so the measured call
   * has to carry it: a run recording the treatment while retrieving without it
   * records a treatment it never applied.
   */
  it('hands the port the adjacency treatment it was asked for, OFF by default', async () => {
    const seen: RetrieveOptions[] = [];
    const spy: KnowledgePort = {
      name: 'fts5',
      retrieve: async (_query: string, opts: RetrieveOptions) => {
        seen.push(opts);
        return await Promise.resolve({
          atoms: [],
          mode: 'fts5',
          indexState: 'ready' as IndexState,
        });
      },
    };

    await retrieveDocs(spy, 'lint:test-shape', 10, true);
    await retrieveDocs(spy, 'lint:test-shape', 10, false);
    await retrieveDocs(spy, 'lint:test-shape', 10);

    expect(seen.map(opts => opts.adjacency)).toEqual([true, false, false]);
  });
});

/**
 * CLI-EQUIVALENCE GUARD — the case that stops `engine.ts` drifting into a second
 * `beirIndex.ts`. `runCli` is the SHIPPED entry point (`src/cli/main.ts` calls
 * exactly this), so the comparison covers argument resolution, context building,
 * `createPort` and `port.retrieve`. `--max-tokens` is raised only to defeat the
 * CLI's PRESENTATION budget and `--no-prf` turns off the profile's retrieve-time
 * feedback default — the two steps `engine.ts` deliberately omits, both CLI-only
 * by design; everything that decides ORDER is identical on both sides.
 */
describe('CLI equivalence', () => {
  const cliRanking = async (query: string): Promise<readonly string[]> => {
    const result = await runCli([
      'retrieve',
      query,
      '--adapter',
      'fts5',
      '--atoms-dir',
      prepared.atomsDir,
      '--index-path',
      prepared.indexPath,
      '-k',
      String(DEPTH),
      '--max-tokens',
      '10000000',
      '--no-prf',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { readonly atoms: readonly RetrievedAtom[] };
    return atomIds(payload.atoms);
  };

  it('produces the same ranking as the dp-gnosis retrieve command', async () => {
    const harness = await Promise.all(
      queries.map(query => retrieveDocs(port, query, DEPTH).then(atomIds))
    );
    const cli = await Promise.all(queries.map(cliRanking));
    expect(harness).toEqual(cli);
    expect(harness.every(ranking => ranking.length > 0)).toBe(true);
  });
});

/**
 * The sweep's seam. `openPort` gains an adapter and a BM25 operating point so
 * `sweep.ts` can drive the REAL engine at each grid cell; the equivalence case
 * below is what stops that branch becoming a second BM25 implementation.
 */
describe('openPort — linear adapter with BM25 parameters', () => {
  const scoresAt = async (options: {
    readonly k1?: number;
    readonly b?: number;
  }): Promise<readonly number[]> => {
    const scoped = openPort(prepared, { adapter: 'linear', ...options });
    const atoms = await retrieveDocs(scoped, queries[0]!, DEPTH);
    scoped.close?.();
    return atoms.map(atom => atom.score);
  };

  it('builds the linear-scan adapter, not the default fts5 one', () => {
    const linear = openPort(prepared, { adapter: 'linear' });
    expect(linear.name).toBe('linear-scan');
    expect(openPort(prepared).name).not.toBe('linear-scan');
    linear.close?.();
  });

  it('defaults to the shipped operating point when k1 and b are omitted', async () => {
    expect(await scoresAt({})).toEqual(await scoresAt({ k1: 1.2, b: 0.75 }));
  });

  it('carries k1 and b through to the scorer', async () => {
    const baseline = await scoresAt({ k1: 1.2, b: 0.75 });
    expect(await scoresAt({ k1: 1.2, b: 0.3 })).not.toEqual(baseline);
    expect(await scoresAt({ k1: 0.8, b: 0.75 })).not.toEqual(baseline);
  });

  /**
   * The anti-fork guard: at default parameters the sweep's port must rank
   * exactly as the shipped `--adapter linear` CLI does. A re-implemented BM25
   * here would pass every case above and fail this one.
   */
  it('ranks identically to the dp-gnosis retrieve command at default parameters', async () => {
    const linear = openPort(prepared, { adapter: 'linear' });
    const harness = await retrieveDocs(linear, queries[0]!, DEPTH).then(atomIds);
    linear.close?.();
    const result = await runCli([
      'retrieve',
      queries[0]!,
      '--adapter',
      'linear',
      '--atoms-dir',
      prepared.atomsDir,
      '--index-path',
      prepared.indexPath,
      '-k',
      String(DEPTH),
      '--max-tokens',
      '10000000',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { readonly atoms: readonly RetrievedAtom[] };
    expect(harness).toEqual(atomIds(payload.atoms));
    expect(harness.length).toBeGreaterThan(0);
  });
});

/**
 * The seam the recorded `rerankModel` claims: the id on the row MUST be the id
 * that scored the documents. Asserted on the WIRE — the `/v1/rerank` payload —
 * because a model that never left the bench would still be recorded, and the
 * label would then describe a run nothing produced.
 */
describe('rerankIfRequested — the model reaches the reranker', () => {
  const atom: RetrievedAtom = {
    id: 'a1',
    title: 'Photosynthesis',
    domain: 'docs',
    type: defaultAtomType(),
    body: 'Marine algae convert sunlight into chemical energy.',
    score: 1,
    sourcePath: 'doc/a1.md',
    originPaths: ['doc/a1.md'],
  };

  /** Answers both llama-swap endpoints and records every request payload. */
  const stubServer = (served: readonly string[]): Record<string, unknown>[] => {
    const payloads: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
        if (url.endsWith('/v1/models')) {
          return {
            ok: true,
            status: 200,
            text: async (): Promise<string> =>
              JSON.stringify({ data: served.map(id => ({ id })) }),
          };
        }
        payloads.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> =>
            JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }),
        };
      }
    );
    return payloads;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the NAMED model to /v1/rerank', async () => {
    const payloads = stubServer([OTHER_MODEL]);
    await rerankIfRequested('algae', [atom], true, { model: OTHER_MODEL });
    expect(payloads.map(payload => payload['model'])).toEqual([OTHER_MODEL]);
  });

  it('sends the SHIPPED model when the arm names none — every run to date', async () => {
    const payloads = stubServer([RERANK_MODEL_ID]);
    await rerankIfRequested('algae', [atom], true, {});
    expect(payloads.map(payload => payload['model'])).toEqual([RERANK_MODEL_ID]);
  });

  /**
   * A model the server does not serve REFUSES — it must never degrade into the
   * BM25 order under a rerank label.
   */
  it('REFUSES a named model the server does not serve, naming that model', async () => {
    stubServer([RERANK_MODEL_ID]);
    await expect(rerankIfRequested('algae', [atom], true, { model: OTHER_MODEL })).rejects.toThrow(
      new RegExp(OTHER_MODEL)
    );
  });
});

/**
 * The arm's entry gate. `mxbai-rerank-large-v2` returns HTTP 200 with a score
 * invariant to the DOCUMENT, so equal scores leave the first-pass order
 * essentially intact and the arm would record a plausible number. The gate turns
 * that into a named failure before any topic is scored.
 */
describe('assertRerankDiscriminates', () => {
  /** Answers both endpoints; `scores` is indexed by probe document position. */
  const stubProbe = (scores: readonly number[]): void => {
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
      const payload = url.endsWith('/v1/models')
        ? { data: [{ id: OTHER_MODEL }] }
        : { results: scores.map((relevance_score, index) => ({ index, relevance_score })) };
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => JSON.stringify(payload),
      };
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('FAILS the arm on constant scores, under its own cause', async () => {
    stubProbe([0.11378549039363861, 0.11378549039363861]);

    await expect(assertRerankDiscriminates({ model: OTHER_MODEL })).rejects.toThrow(
      new RegExp(OTHER_MODEL)
    );
    await expect(assertRerankDiscriminates({ model: OTHER_MODEL })).rejects.toMatchObject({
      cause: RERANK_PROBE_CAUSE,
    });
  });

  it('passes a reranker that discriminates', async () => {
    stubProbe([2.07, -11]);

    await expect(assertRerankDiscriminates({ model: OTHER_MODEL })).resolves.toBeUndefined();
  });
});

/**
 * GOLD-AWARE DEDUPE, end to end. The exact-body dedupe keeps ONE copy of a
 * mirrored document, and before `goldIds` it chose gold-blind: on `vault` it
 * kept the mirror and dropped the copy the golden set judges, which cost 8
 * topics their `recall@100` outright (GNOSIS-BENCH § Known harness gaps). The
 * ids therefore have to reach `ingest()` on the MEASURED path — the field
 * existing on `IngestOptions` proves nothing while no bench caller passes it.
 */
describe('prepareDataset — the golden set decides which duplicate survives', () => {
  const MIRROR_TITLE = 'Shared mirror body';
  /** ≥ DEDUPE_MIN_BODY_CHARS (200), or the dedupe treats it as boilerplate. */
  const MIRROR_TEXT =
    'The two source documents below carry byte-identical prose so the exact-body dedupe groups ' +
    'them together and keeps exactly one of the pair. Which one it keeps is the whole question: ' +
    'the golden set judges only one of them, and the other is an unjudged mirror of it.';

  /** `dup-aaa` wins the id tie-break, so gold-blind dedupe keeps it. */
  const MIRRORS: readonly BeirDoc[] = [
    { id: 'dup-aaa', title: MIRROR_TITLE, text: MIRROR_TEXT },
    { id: 'dup-zzz', title: MIRROR_TITLE, text: MIRROR_TEXT },
  ];

  /** Enough distinct documents that dropping one duplicate clears the 90% coverage floor. */
  const fillers: readonly BeirDoc[] = Array.from({ length: 10 }, (_unused, index) => ({
    id: `filler-${index}`,
    title: `Filler subject ${index}`,
    text: `Distinct filler prose number ${index} about an unrelated subject entirely.`,
  }));

  const survivorsIn = (atomsDir: string): readonly string[] =>
    readdirSync(atomsDir).filter(name => name.startsWith('dup-'));

  it('keeps the JUDGED copy of a byte-identical pair and drops the unjudged mirror', async () => {
    const scoped = await prepareDataset({
      id: `${DATASET_ID}-gold`,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
      goldIds: ['dup-zzz'],
    });
    const survivors = survivorsIn(scoped.atomsDir);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatch(/^dup-zzz/);
  });

  it('falls back to the id tie-break when no golden set names either copy', async () => {
    const scoped = await prepareDataset({
      id: `${DATASET_ID}-blind`,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
    });
    const survivors = survivorsIn(scoped.atomsDir);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatch(/^dup-aaa/);
  });

  /**
   * The T2.1d case: BOTH members of a byte-identical group are judged, so keep-one
   * would delete a gold document outright. Recorded on `vault`: 10 such groups, 9
   * gold documents absent from the indexed corpus, 8 topics losing `recall@100`.
   */
  it('keeps BOTH copies when the golden set judges each side of the pair', async () => {
    const scoped = await prepareDataset({
      id: `${DATASET_ID}-double-gold`,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
      goldIds: ['dup-aaa', 'dup-zzz'],
    });

    expect(survivorsIn(scoped.atomsDir)).toHaveLength(2);
  });

  /**
   * The refusal moved onto the INDEXED corpus. `fetch/vault.ts` derives its count
   * from the SOURCE projection, before ingest runs, so it printed a 1.0000 recall
   * ceiling over a corpus the dedupe had already stripped of gold.
   */
  it('REFUSES a dataset whose indexed atoms cannot reach a judged document', async () => {
    await expect(
      prepareDataset({
        id: `${DATASET_ID}-lost-gold`,
        docs: [...fillers],
        workRoot: root,
        goldIds: ['filler-0', 'never-ingested'],
      })
    ).rejects.toMatchObject({ cause: UNREACHABLE_GOLD_CAUSE });
  });
});

/**
 * THE INSTRUMENT AUDIT. `run.ts:goldIdsOf` returns `undefined` for every
 * non-derived dataset, so a BEIR corpus is deduped GOLD-BLIND and never reaches
 * `assertGoldIndexed` — the orphaned judgments are real and invisible. This
 * reports them without building an index, so the count costs one ingest and no
 * GPU, and it MUST NOT change which copy the dedupe kept.
 */
describe('auditDuplicates — which document the dedupe orphaned, and where its body survived', () => {
  const MIRROR_TITLE = 'Audited mirror body';
  /** ≥ DEDUPE_MIN_BODY_CHARS (200), or the dedupe treats it as boilerplate. */
  const MIRROR_TEXT =
    'Two source documents carry byte-identical prose here so the exact-body dedupe groups them ' +
    'and refuses one of the pair outright. The audit has to name the refused document and the ' +
    'one whose copy of the body survived, at document granularity and not atom granularity.';

  const MIRRORS: readonly BeirDoc[] = [
    { id: 'aud-aaa', title: MIRROR_TITLE, text: MIRROR_TEXT },
    { id: 'aud-zzz', title: MIRROR_TITLE, text: MIRROR_TEXT },
  ];

  const fillers: readonly BeirDoc[] = Array.from({ length: 10 }, (_unused, index) => ({
    id: `audfill-${index}`,
    title: `Audit filler subject ${index}`,
    text: `Distinct audit filler prose number ${index} about an unrelated subject entirely.`,
  }));

  it('maps the gold-blind orphan to the id that won the tie-break', async () => {
    const audited = await auditDuplicates({
      id: `${DATASET_ID}-audit-blind`,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
    });
    expect(audited.links).toEqual([{ orphanDocId: 'aud-zzz', survivorDocId: 'aud-aaa' }]);
  });

  it('follows the golden set when it decides which copy survives', async () => {
    const audited = await auditDuplicates({
      id: `${DATASET_ID}-audit-gold`,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
      goldIds: ['aud-zzz'],
    });
    expect(audited.links).toEqual([{ orphanDocId: 'aud-aaa', survivorDocId: 'aud-zzz' }]);
  });

  it('reports nothing for a corpus holding no byte-identical pair', async () => {
    const audited = await auditDuplicates({
      id: `${DATASET_ID}-audit-clean`,
      docs: fillers,
      workRoot: root,
    });
    expect(audited.links).toEqual([]);
  });

  it('builds no index — the audit is ingest-only', async () => {
    const scoped = `${DATASET_ID}-audit-noindex`;
    await auditDuplicates({ id: scoped, docs: fillers, workRoot: root });
    expect(existsSync(resolve(root, scoped, `${scoped}-index`))).toBe(false);
  });

  /**
   * D1. `ingest` WRITES and PRUNES its output directory, so an audit pointed at
   * the dataset's own atoms dir re-ingests the measured corpus under different
   * options and silently replaces it — measured on `vault`, 6628 → 6619 atoms.
   * The dataset's work directory MUST come back byte-identical.
   */
  it('leaves the dataset\'s own atoms, index and manifest byte-unchanged', async () => {
    const scoped = `${DATASET_ID}-audit-nonmutating`;
    const prepared = await prepareDataset({
      id: scoped,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
      goldIds: ['aud-zzz'],
    });
    const before = snapshotTree(resolve(root, scoped));
    await auditDuplicates({ id: scoped, docs: [...MIRRORS, ...fillers], workRoot: root });
    expect(snapshotTree(resolve(root, scoped))).toEqual(before);
    expect(readdirSync(prepared.atomsDir)).toHaveLength(before.filter(isAtomEntry).length);
  });

  /**
   * D2, restated by the PROVENANCE MERGE (R0). The survivor of a byte-identical
   * group now names every refused member's source path, so `representedDocIds`
   * covers the whole group and NEITHER audit can lose a judgment — a gold-blind
   * ingest included. That is the R0 gate: 0 orphaned golds.
   *
   * The goldIds still decide WHICH copy is refused, which is why the `links`
   * assertions above stay: the gold-awareness signal moved from "was the
   * judgment lost" to "which document holds the surviving atom", and it MUST NOT
   * disappear with the loss it used to cause.
   */
  it('loses no judgment either way once the survivor carries the orphan\u2019s provenance', async () => {
    const judged = new Map<string, Qrel>([['q1', new Map([['aud-zzz', 1]])]]);
    const corpusDocIds = [...MIRRORS, ...fillers].map(doc => doc.id);
    const aware = await auditDuplicates({
      id: `${DATASET_ID}-audit-aware`,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
      goldIds: ['aud-zzz'],
    });
    const blind = await auditDuplicates({
      id: `${DATASET_ID}-audit-unaware`,
      docs: [...MIRRORS, ...fillers],
      workRoot: root,
    });
    const auditOf = (represented: readonly string[]): GoldAudit =>
      auditGold({ datasetId: 'fixture', corpusDocIds, representedDocIds: represented, qrels: judged });
    expect(auditOf(aware.representedDocIds).lostJudgments).toBe(0);
    expect(auditOf(blind.representedDocIds).lostJudgments).toBe(0);
    expect(aware.links).not.toEqual(blind.links);
  });
});
