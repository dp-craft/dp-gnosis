import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  buildLanceDbIndex,
  createLanceDbAdapter,
  lanceDbAvailability
} from '../src/adapters/lanceDbAdapter.js';
import type { KnowledgePort } from '../src/port.js';

const NOW = new Date('2026-08-08T00:00:00.000Z');

/** LanceDB builds a real on-disk index per case; 5s is not enough on a cold FS. */
const CASE_TIMEOUT_MS = 30_000;

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly domain?: string;
  readonly type?: string;
  readonly status?: string;
  readonly staleAfter?: string;
  readonly body: string;
}

const atomText = (spec: AtomSpec): string =>
  [
    '---',
    `type: ${spec.type ?? 'knowledge'}`,
    `id: ${spec.id}`,
    `title: title of ${spec.id}`,
    `x_domain: ${spec.domain ?? 'runner'}`,
    `status: ${spec.status ?? 'stable'}`,
    ...(spec.staleAfter === undefined ? [] : [`stale_after: ${spec.staleAfter}`]),
    'sources:',
    '  - https://example.com/src',
    '---',
    spec.body,
    '',
  ].join('\n');

let root = '';
let atomsDir = '';
let indexDir = '';

const writeAtom = (spec: AtomSpec): void => {
  writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8');
};

/** Push every corpus mtime behind the index so `stale` is asserted, not accidental. */
const settleCorpusBehindIndex = (files: readonly string[]): void => {
  const when = new Date(statSync(indexDir).mtimeMs - 60_000);
  files.forEach(file => utimesSync(resolve(atomsDir, file), when, when));
  utimesSync(atomsDir, when, when);
};

const touchAhead = (file: string): void => {
  const when = new Date(statSync(indexDir).mtimeMs + 60_000);
  utimesSync(resolve(atomsDir, file), when, when);
};

const build = (): Promise<boolean> => buildLanceDbIndex({ atomsDir, indexDir });

const port = (): KnowledgePort => createLanceDbAdapter({ atomsDir, indexDir, now: NOW });

/** A SECOND corpus + index in the same root, deliberately left stale. */
const staleSiblingPort = async (): Promise<KnowledgePort> => {
  const otherAtoms = resolve(root, 'atoms-two');
  const otherIndex = resolve(root, 'index-two', 'atoms-lancedb');
  mkdirSync(otherAtoms, { recursive: true });
  writeFileSync(
    resolve(otherAtoms, 'a.md'),
    atomText({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' }),
    'utf8'
  );
  await buildLanceDbIndex({ atomsDir: otherAtoms, indexDir: otherIndex });
  const ahead = new Date(statSync(otherIndex).mtimeMs + 60_000);
  utimesSync(resolve(otherAtoms, 'a.md'), ahead, ahead);
  return createLanceDbAdapter({ atomsDir: otherAtoms, indexDir: otherIndex, now: NOW });
};

const ids = (atoms: readonly { readonly id: string }[]): readonly string[] =>
  atoms.map(atom => atom.id);

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-lancedb-'));
  atomsDir = resolve(root, 'atoms');
  indexDir = resolve(root, 'index', 'atoms-lancedb');
  mkdirSync(atomsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createLanceDbAdapter', () => {
  it(
    'names itself lancedb-fts and reports the lancedb-fts mode',
    async () => {
      await build();

      const instance = port();
      expect(instance.name).toBe('lancedb-fts');
      expect((await instance.retrieve('zustand', { k: 1 })).mode).toBe('lancedb-fts');
      instance.close?.();
    },
    CASE_TIMEOUT_MS
  );

  it(
    'reports the optional dependency as available when it is installed',
    async () => {
      const availability = await lanceDbAvailability();

      expect(availability.available).toBe(true);
      expect(availability.reason).toBeUndefined();
    },
    CASE_TIMEOUT_MS
  );

  it(
    'reports unavailable and searches nothing when the index directory is missing',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });

      const result = await port().retrieve('zustand', { k: 5 });

      expect(result.indexState).toBe('unavailable');
      expect(result.atoms).toEqual([]);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'reports empty when a real search ran against an index holding no atoms',
    async () => {
      await build();

      const result = await port().retrieve('zustand', { k: 5 });

      expect(result.indexState).toBe('empty');
      expect(result.atoms).toEqual([]);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'does not throw when the corpus root is missing',
    async () => {
      await build();
      rmSync(atomsDir, { recursive: true, force: true });

      const result = await port().retrieve('zustand', { k: 5 });

      expect(result.indexState).toBe('unavailable');
      expect(result.atoms).toEqual([]);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'reports ready and ranks the matching atom first',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability rules' });
      writeAtom({ file: 'b.md', id: 'atom-b', body: 'sqlite fts5 bm25 ranking notes' });
      await build();
      settleCorpusBehindIndex(['a.md', 'b.md']);

      const result = await port().retrieve('zustand selector', { k: 5 });

      expect(result.indexState).toBe('ready');
      expect(ids(result.atoms)).toEqual(['atom-a']);
      expect(result.atoms[0]?.score).toBeGreaterThan(0);
      expect(result.atoms[0]?.title).toBe('title of atom-a');
      expect(result.atoms[0]?.sourcePath).toBe(resolve(atomsDir, 'a.md'));
    },
    CASE_TIMEOUT_MS
  );

  it(
    'reads the body from disk so an edit lands in the very next retrieve',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      await build();
      settleCorpusBehindIndex(['a.md']);
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability REWRITTEN BODY' });

      const result = await port().retrieve('zustand', { k: 5 });

      expect(result.atoms[0]?.body).toContain('REWRITTEN BODY');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'reports stale when the corpus is newer than the index',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      await build();
      settleCorpusBehindIndex(['a.md']);
      touchAhead('a.md');

      const result = await port().retrieve('zustand', { k: 5 });

      expect(result.indexState).toBe('stale');
      expect(ids(result.atoms)).toEqual(['atom-a']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'truncates to k when more atoms match',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand one' });
      writeAtom({ file: 'b.md', id: 'atom-b', body: 'zustand two' });
      writeAtom({ file: 'c.md', id: 'atom-c', body: 'zustand three' });
      await build();

      const result = await port().retrieve('zustand', { k: 2 });

      expect(result.atoms).toHaveLength(2);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'returns fewer than k without padding',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand one' });
      await build();

      const result = await port().retrieve('zustand', { k: 9 });

      expect(result.atoms).toHaveLength(1);
    },
    CASE_TIMEOUT_MS
  );

  /**
   * MEASURED: LanceDB's BM25 ordering of equally-scored rows is NOT stable — the
   * same three tied rows came back `mmm, zzz, aaa` from a sorted-order build and
   * `zzz, mmm, aaa` from a reversed-order build. The port's own
   * `(score DESC, atomId ASC)` sort is what makes this assertion hold.
   */
  it(
    'breaks an exact score tie by ascending atom id',
    async () => {
      // Ids are ANTI-CORRELATED with the insertion (sorted-path) order on
      // purpose: if the engine's own order were trusted, this returns
      // `zzz, aaa` and the assertion fails.
      writeAtom({ file: 'a-first.md', id: 'zzz-atom', body: 'identical tie body text' });
      writeAtom({ file: 'z-second.md', id: 'aaa-atom', body: 'identical tie body text' });
      await build();

      const result = await port().retrieve('identical tie', { k: 5 });

      expect(ids(result.atoms)).toEqual(['aaa-atom', 'zzz-atom']);
    },
    CASE_TIMEOUT_MS
  );

  /**
   * MEASURED: asking LanceDB for exactly `k` on a three-way tie returned a
   * DIFFERENT arbitrary subset than the top-`k` of the unlimited result, so the
   * adapter over-fetches and truncates itself.
   */
  it(
    'truncates a tie wider than k by atom id rather than by engine order',
    async () => {
      // Insertion order is a.md, m.md, z.md — so the ids go zzz, mmm, aaa. An
      // engine-side `limit(2)` yields the first two ROWS (`zzz, mmm`); only
      // over-fetching and sorting ourselves yields `aaa, mmm`.
      writeAtom({ file: 'a.md', id: 'zzz-atom', body: 'identical tie body text' });
      writeAtom({ file: 'm.md', id: 'mmm-atom', body: 'identical tie body text' });
      writeAtom({ file: 'z.md', id: 'aaa-atom', body: 'identical tie body text' });
      await build();

      const result = await port().retrieve('identical tie', { k: 2 });

      expect(ids(result.atoms)).toEqual(['aaa-atom', 'mmm-atom']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'produces identical ranking when the same files are created in a different order',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha beta gamma delta' });
      writeAtom({ file: 'b.md', id: 'atom-b', body: 'alpha beta gamma' });
      writeAtom({ file: 'c.md', id: 'atom-c', body: 'alpha beta' });
      await build();
      const first = await port().retrieve('alpha beta gamma delta', { k: 5 });

      rmSync(atomsDir, { recursive: true, force: true });
      mkdirSync(atomsDir, { recursive: true });
      writeAtom({ file: 'c.md', id: 'atom-c', body: 'alpha beta' });
      writeAtom({ file: 'b.md', id: 'atom-b', body: 'alpha beta gamma' });
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha beta gamma delta' });
      await build();
      const second = await port().retrieve('alpha beta gamma delta', { k: 5 });

      expect(ids(second.atoms)).toEqual(ids(first.atoms));
      expect(second.atoms).toEqual(first.atoms);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'returns nothing for a term absent from the corpus',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      await build();
      settleCorpusBehindIndex(['a.md']);

      const result = await port().retrieve('nonexistentterm', { k: 5 });

      expect(result.atoms).toEqual([]);
      expect(result.indexState).toBe('ready');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'returns nothing for an all-whitespace query without throwing',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      await build();

      const result = await port().retrieve('   ', { k: 5 });

      expect(result.atoms).toEqual([]);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'excludes foreign-domain atoms when a domain filter is set',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', domain: 'runner', body: 'shared token here' });
      writeAtom({ file: 'b.md', id: 'atom-b', domain: 'standards', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5, domain: 'standards' });

      expect(ids(result.atoms)).toEqual(['atom-b']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'excludes foreign-type atoms when a type filter is set',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', type: 'knowledge', body: 'shared token here' });
      writeAtom({ file: 'b.md', id: 'atom-b', type: 'adr', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5, types: ['adr'] });

      expect(ids(result.atoms)).toEqual(['atom-b']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'keeps every atom whose type is a member of a multi-type filter',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', type: 'knowledge', body: 'shared token here' });
      writeAtom({ file: 'b.md', id: 'atom-b', type: 'adr', body: 'shared token here' });
      writeAtom({ file: 'c.md', id: 'atom-c', type: 'review', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5, types: ['adr', 'review'] });

      expect([...ids(result.atoms)].sort()).toEqual(['atom-b', 'atom-c']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'refuses an empty type list instead of matching nothing',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', type: 'adr', body: 'shared token here' });
      await build();

      const attempt = async (): Promise<unknown> =>
        await port().retrieve('shared token', { k: 5, types: [] });

      await expect(attempt()).rejects.toThrow(/"types" MUST name at least one type/);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'keeps an atom whose type is outside the closed vocabulary under the default type',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', type: 'invented_type', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5, types: ['knowledge'] });

      expect(ids(result.atoms)).toEqual(['atom-a']);
      expect(result.atoms[0]?.type).toBe('knowledge');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'excludes deprecated and expired atoms via the shared retrievability rule',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', status: 'deprecated', body: 'shared token here' });
      writeAtom({ file: 'b.md', id: 'atom-b', staleAfter: '2026-08-07', body: 'shared token here' });
      writeAtom({ file: 'c.md', id: 'atom-c', staleAfter: '2026-08-08', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5 });

      expect(ids(result.atoms)).toEqual(['atom-c']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'skips a corrupt atom and a non-markdown file instead of throwing',
    async () => {
      writeFileSync(resolve(atomsDir, 'broken.md'), 'no frontmatter shared token here', 'utf8');
      writeFileSync(resolve(atomsDir, 'notes.txt'), 'shared token here', 'utf8');
      writeAtom({ file: 'good.md', id: 'atom-good', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5 });

      expect(ids(result.atoms)).toEqual(['atom-good']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'skips an atom whose x_domain is outside the closed vocabulary',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', domain: 'invented', body: 'shared token here' });
      writeAtom({ file: 'b.md', id: 'atom-b', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5 });

      expect(ids(result.atoms)).toEqual(['atom-b']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'indexes only the injected atoms directory, never a sibling proposals directory',
    async () => {
      const proposals = resolve(root, 'proposals');
      mkdirSync(proposals, { recursive: true });
      writeFileSync(
        resolve(proposals, 'draft.md'),
        atomText({ file: 'draft.md', id: 'atom-draft', body: 'shared token here' }),
        'utf8'
      );
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'shared token here' });
      await build();

      const result = await port().retrieve('shared token', { k: 5 });

      expect(ids(result.atoms)).toEqual(['atom-a']);
    },
    CASE_TIMEOUT_MS
  );

  /** The SHARED stemmer runs index-side AND query-side, so an inflection matches. */
  it(
    'matches an inflected query term against the uninflected document term',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'the index of every atom' });
      await build();

      const result = await port().retrieve('indexing', { k: 5 });

      expect(ids(result.atoms)).toEqual(['atom-a']);
    },
    CASE_TIMEOUT_MS
  );

  /**
   * The stem is the SHARED one, not LanceDB's own `<lang>_stem` tokenizer: the
   * inverted index holds `stabil`, the stem `stemTerm('stability')` produces, and
   * a query for the raw surface form `stability` reaches it only because the
   * query side is stemmed by the same function.
   */
  it(
    'indexes the shared stem rather than the raw surface form',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'selector stability' });
      await build();

      const stemmed = await port().retrieve('stabil', { k: 5 });
      const surface = await port().retrieve('stability', { k: 5 });

      expect(ids(stemmed.atoms)).toEqual(['atom-a']);
      expect(ids(surface.atoms)).toEqual(['atom-a']);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'picks up an index built after the instance exists, so unavailable is not sticky',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      const instance = port();
      expect((await instance.retrieve('zustand', { k: 5 })).indexState).toBe('unavailable');

      await build();
      settleCorpusBehindIndex(['a.md']);

      const result = await instance.retrieve('zustand', { k: 5 });

      expect(result.indexState).toBe('ready');
      expect(ids(result.atoms)).toEqual(['atom-a']);
      instance.close?.();
    },
    CASE_TIMEOUT_MS
  );

  /**
   * The corpus is FIXED for the lifetime of a process — a markdown change needs a
   * RESTART — so the staleness sweep (measured at ~700 ms of a ~710 ms retrieve
   * over 43 228 atoms) is sampled once per instance. Moving the corpus ahead of
   * the index under a LIVE instance is observable only if a second retrieve
   * re-scanned; a fresh instance ("restart") does see stale.
   */
  it(
    'samples the staleness sweep once and holds that verdict for the instance',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      await build();
      settleCorpusBehindIndex(['a.md']);
      const instance = port();
      expect((await instance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');

      touchAhead('a.md');

      expect((await instance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');
      const restarted = port();
      expect((await restarted.retrieve('zustand', { k: 5 })).indexState).toBe('stale');
      instance.close?.();
      restarted.close?.();
    },
    CASE_TIMEOUT_MS
  );

  /** The sweep is memoized on the INSTANCE, so two atom dirs never share a verdict. */
  it(
    'gives each instance over a different atoms dir its own staleness verdict',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      await build();
      settleCorpusBehindIndex(['a.md']);
      const readyInstance = port();
      const staleInstance = await staleSiblingPort();

      expect((await readyInstance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');
      expect((await staleInstance.retrieve('zustand', { k: 5 })).indexState).toBe('stale');
      expect((await readyInstance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');
      expect((await staleInstance.retrieve('zustand', { k: 5 })).indexState).toBe('stale');
      readyInstance.close?.();
      staleInstance.close?.();
    },
    CASE_TIMEOUT_MS
  );

  it(
    'serves a rebuilt index to a live instance instead of the one it already opened',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only' });
      await build();
      const instance = port();
      expect((await instance.retrieve('newterm', { k: 5 })).atoms).toEqual([]);

      writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only newterm' });
      await build();

      const result = await instance.retrieve('newterm', { k: 5 });

      expect(ids(result.atoms)).toEqual(['atom-a']);
      instance.close?.();
    },
    CASE_TIMEOUT_MS
  );

  it(
    'tolerates close being called twice',
    async () => {
      await build();
      const instance = port();
      await instance.retrieve('zustand', { k: 1 });

      expect(() => {
        instance.close?.();
        instance.close?.();
      }).not.toThrow();
    },
    CASE_TIMEOUT_MS
  );

  /**
   * `@lancedb/lancedb` can fail at IMPORT time with a native BINDING error on a
   * platform whose prebuilt binary lags the root version — not a
   * MODULE_NOT_FOUND. The loader catches EVERY import error, so this leg skips
   * with a reportable reason instead of failing the suite.
   */
  it(
    'skips cleanly when the optional dependency fails to import for any reason',
    async () => {
      writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
      await build();
      vi.doMock('@lancedb/lancedb', () => {
        throw new Error('simulated native binding failure');
      });
      vi.resetModules();

      const reloaded = await import('../src/adapters/lanceDbAdapter.js');
      const availability = await reloaded.lanceDbAvailability();
      const result = await reloaded
        .createLanceDbAdapter({ atomsDir, indexDir, now: NOW })
        .retrieve('zustand', { k: 5 });

      // The reason TEXT is owned by whatever failed the import (here vitest's own
      // mock loader rewrites it), so only its presence is asserted — the point is
      // that a non-MODULE_NOT_FOUND failure is caught and reported, not swallowed.
      expect(availability.available).toBe(false);
      expect(availability.reason).toEqual(expect.any(String));
      expect(availability.reason?.length).toBeGreaterThan(0);
      expect(result.indexState).toBe('unavailable');
      expect(result.atoms).toEqual([]);
      expect(await reloaded.buildLanceDbIndex({ atomsDir, indexDir })).toBe(false);
      vi.doUnmock('@lancedb/lancedb');
      vi.resetModules();
    },
    CASE_TIMEOUT_MS
  );
});
