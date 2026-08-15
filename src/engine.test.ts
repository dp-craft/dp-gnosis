import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdapterName } from '../../dp-gnosis/src/cli/adapter.js';
import { runCli } from '../../dp-gnosis/src/cli/cli.js';
import type { KnowledgePort, RetrievedAtom } from '../../dp-gnosis/src/port.js';
import type { BeirDoc } from './beir.js';
import {
  assertIngestSound,
  EMPTY_INDEX_CAUSE,
  LOW_COVERAGE_CAUSE,
  openPort,
  prepareDataset,
  type PreparedDataset,
  retrieveDocs
} from './engine.js';

const DATASET_ID = 'fixture';
const DEPTH = 5;

const root = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-engine-'));

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
});

/**
 * CLI-EQUIVALENCE GUARD — the case that stops `engine.ts` drifting into a second
 * `beirIndex.ts`. `runCli` is the SHIPPED entry point (`src/cli/main.ts` calls
 * exactly this), so the comparison covers argument resolution, context building,
 * `createPort` and `port.retrieve`. `--max-tokens` is raised only to defeat the
 * CLI's PRESENTATION budget, which is the one step `engine.ts` deliberately
 * omits; everything that decides ORDER is identical on both sides.
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
