/**
 * The two DENSE LanceDB routes — `lancedb-vec` (dense only, the control) and
 * `lancedb-hybrid` (dense ⊕ lexical, fused by `fuseRanking`'s own arithmetic).
 *
 * No live embedding server: `fetch` is stubbed, so both llama-swap calls
 * (`GET /v1/models` and `POST /v1/embeddings`) are answered in-process and the
 * transport is INJECTED rather than probed. The stub resolves a vector by
 * matching a marker in the text it is given, so a text that reached the wire
 * STEMMED matches no marker and the call REFUSES — the raw-body rule is
 * enforced by the fixture itself, not only by an assertion.
 *
 * The three properties under test are the ones that fail SILENTLY in
 * production: the vector column holds embeddings of the RAW body, a dense or
 * hybrid route REFUSES when the embedding server is down instead of degrading
 * to its lexical leg, and the frozen `lancedb` route still carries no vector
 * column and still ranks as before.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { connect } from '@lancedb/lancedb';

import { buildLanceDbIndex, createLanceDbAdapter } from '../src/adapters/lanceDbAdapter.js';
import {
  buildLanceDbDenseIndex,
  createLanceDbDenseAdapter
} from '../src/adapters/lanceDbDenseAdapter.js';
import { ADAPTER_NAMES, createPort, defaultIndexPath } from '../src/cli/adapter.js';
import { EMBED_MODEL_ID } from '../src/config.js';
import type { KnowledgePort, RetrievedAtom } from '../src/port.js';

const NOW = new Date('2026-08-08T00:00:00.000Z');

/** LanceDB builds a real on-disk index per case; 5s is not enough on a cold FS. */
const CASE_TIMEOUT_MS = 30_000;

const ALPHA_BODY = 'Ranking retrieved documents zestfully by their lexical overlap.';
const BRAVO_BODY = 'Chocolate cake baking instructions for a very sweet dessert.';
const CHARLIE_BODY = 'Vector similarity of paragraphs that share no wording at all.';

/** Dense-only: no token of it appears in any body, so the lexical leg finds nothing. */
const DENSE_QUERY = 'Semantic Neighbour probe';

/** Hybrid: the first token is lexical-only, the rest is the dense marker. */
const HYBRID_QUERY = 'zestfully Semantic Neighbour probe';

/**
 * Marker → unit vector, checked IN ORDER. `probe` is first because the hybrid
 * query carries a body marker too, and the query must embed as the query.
 */
const VECTORS: readonly (readonly [string, readonly number[]])[] = [
  ['probe', [0.8, 0.6]],
  ['zestfully', [1, 0]],
  ['Chocolate', [0, 1]],
  ['Vector similarity', [0.8, 0.6]],
];

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly body: string;
}

const ATOMS: readonly AtomSpec[] = [
  { file: 'a.md', id: 'atom-alpha', body: ALPHA_BODY },
  { file: 'b.md', id: 'atom-bravo', body: BRAVO_BODY },
  { file: 'c.md', id: 'atom-charlie', body: CHARLIE_BODY },
];

const atomText = (spec: AtomSpec): string =>
  [
    '---',
    'type: knowledge',
    `id: ${spec.id}`,
    `title: title of ${spec.id}`,
    'x_domain: runner',
    'status: stable',
    'sources:',
    '  - https://example.com/src',
    '---',
    spec.body,
    '',
  ].join('\n');

let root = '';
let atomsDir = '';
let indexDir = '';
let wireInputs: string[] = [];

const vectorFor = (text: string): readonly number[] | undefined =>
  VECTORS.find(([marker]) => text.includes(marker))?.[1];

interface EmbeddingEntry {
  readonly index: number;
  readonly embedding: readonly number[];
}

/** A text matching no marker yields NO entry — `embedTexts` then refuses. */
const entriesFor = (texts: readonly string[]): readonly EmbeddingEntry[] =>
  texts.flatMap((text, index) => {
    const embedding = vectorFor(text);
    return embedding === undefined ? [] : [{ index, embedding }];
  });

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const inputOf = (body: unknown): readonly string[] =>
  (body as { readonly input: readonly string[] }).input;

/** Answers both llama-swap endpoints and records every text put on the wire. */
const stubServer = (): void => {
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
      if (url.endsWith('/v1/models')) {
        return await Promise.resolve(okResponse({ data: [{ id: EMBED_MODEL_ID }] }));
      }
      const texts = inputOf(JSON.parse(init?.body ?? '{}'));
      wireInputs = [...wireInputs, ...texts];
      return await Promise.resolve(okResponse({ data: entriesFor(texts) }));
    }
  );
};

/** The embedding server is DOWN: the catalogue call itself does not complete. */
const stubDownServer = (): void => {
  vi.stubGlobal('fetch', async (): Promise<unknown> => {
    await Promise.resolve();
    throw new Error('connect ECONNREFUSED 127.0.0.1:9292');
  });
};

const buildDense = (route: 'vec' | 'hybrid'): Promise<boolean> =>
  buildLanceDbDenseIndex({ atomsDir, indexDir, route });

const densePort = (route: 'vec' | 'hybrid'): KnowledgePort =>
  createLanceDbDenseAdapter({ atomsDir, indexDir, route, now: NOW });

const ids = (atoms: readonly RetrievedAtom[]): readonly string[] => atoms.map(atom => atom.id);

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-lancedb-dense-'));
  atomsDir = resolve(root, 'atoms');
  indexDir = resolve(root, 'index', 'atoms-lancedb-dense');
  mkdirSync(atomsDir, { recursive: true });
  ATOMS.forEach(spec => {
    writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8');
  });
  wireInputs = [];
  stubServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('the dense LanceDB routes', () => {
  it(
    'adds lancedb-vec and lancedb-hybrid to the adapter vocabulary, each at its own path',
    () => {
      expect(ADAPTER_NAMES).toContain('lancedb-vec');
      expect(ADAPTER_NAMES).toContain('lancedb-hybrid');
      expect(defaultIndexPath('lancedb-vec')).not.toBe(defaultIndexPath('lancedb-hybrid'));
      expect(defaultIndexPath('lancedb-vec')).not.toBe(defaultIndexPath('lancedb'));
      expect(createPort('lancedb-hybrid', atomsDir, indexDir).name).toBe('lancedb-hybrid');
    }
  );

  it(
    'embeds the RAW body at build time and the RAW query at retrieve time',
    async () => {
      expect(await buildDense('vec')).toBe(true);
      expect(wireInputs.some(text => text.includes(ALPHA_BODY))).toBe(true);
      expect(wireInputs.some(text => text.includes('zest '))).toBe(false);

      const instance = densePort('vec');
      await instance.retrieve(DENSE_QUERY, { k: 3 });
      instance.close?.();

      expect(wireInputs.some(text => text.includes(DENSE_QUERY))).toBe(true);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'ranks by cosine similarity alone on lancedb-vec, with no lexical overlap at all',
    async () => {
      await buildDense('vec');

      const instance = densePort('vec');
      const result = await instance.retrieve(DENSE_QUERY, { k: 3 });
      instance.close?.();

      expect(result.mode).toBe('lancedb-vec');
      expect(result.indexState).toBe('ready');
      expect(ids(result.atoms)).toEqual(['atom-charlie', 'atom-alpha', 'atom-bravo']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'fuses the dense and lexical legs on lancedb-hybrid, keeping what only one leg found',
    async () => {
      await buildDense('hybrid');

      const instance = densePort('hybrid');
      const result = await instance.retrieve(HYBRID_QUERY, { k: 3 });
      instance.close?.();

      expect(result.mode).toBe('lancedb-hybrid');
      expect(ids(result.atoms)).toEqual(['atom-alpha', 'atom-charlie', 'atom-bravo']);
      expect(result.atoms[0]?.score).toBeCloseTo(0.5 / 21 + 0.5 / 22, 12);
      expect(result.atoms[1]?.score).toBeCloseTo(0.5 / 21, 12);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'REFUSES with a named cause when the embedding server is down, at build time',
    async () => {
      stubDownServer();

      await expect(buildDense('hybrid')).rejects.toThrow(/server down: connect ECONNREFUSED/);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'REFUSES at retrieve time rather than degrading to its lexical leg',
    async () => {
      await buildDense('hybrid');
      stubDownServer();

      const instance = densePort('hybrid');
      await expect(instance.retrieve(HYBRID_QUERY, { k: 3 })).rejects.toThrow(
        /server down: connect ECONNREFUSED/
      );
      instance.close?.();
    },
    CASE_TIMEOUT_MS
  );

  it(
    'leaves the frozen lancedb route lexical: no vector column, same ranking',
    async () => {
      const frozenDir = resolve(root, 'index', 'atoms-lancedb');
      expect(await buildLanceDbIndex({ atomsDir, indexDir: frozenDir })).toBe(true);

      const db = await connect(frozenDir);
      const table = await db.openTable('atoms');
      const fields = (await table.schema()).fields.map(field => field.name);
      db.close();

      expect(fields).toEqual(['id', 'path', 'body']);

      const instance = createLanceDbAdapter({ atomsDir, indexDir: frozenDir, now: NOW });
      const result = await instance.retrieve('zestfully', { k: 3 });
      instance.close?.();

      expect(result.mode).toBe('lancedb-fts');
      expect(ids(result.atoms)).toEqual(['atom-alpha']);
    },
    CASE_TIMEOUT_MS
  );
});
