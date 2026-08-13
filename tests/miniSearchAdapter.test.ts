import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  buildMiniSearchIndex,
  createMiniSearchAdapter,
  miniSearchAvailability
} from '../src/adapters/miniSearchAdapter.js';
import type { KnowledgePort } from '../src/port.js';

const NOW = new Date('2026-08-08T00:00:00.000Z');

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
let indexPath = '';

const writeAtom = (spec: AtomSpec): void => {
  writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8');
};

/** Push every corpus mtime behind the index so `stale` is asserted, not accidental. */
const settleCorpusBehindIndex = (files: readonly string[]): void => {
  const when = new Date(statSync(indexPath).mtimeMs - 60_000);
  files.forEach(file => utimesSync(resolve(atomsDir, file), when, when));
  utimesSync(atomsDir, when, when);
};

const touchAhead = (file: string): void => {
  const when = new Date(statSync(indexPath).mtimeMs + 60_000);
  utimesSync(resolve(atomsDir, file), when, when);
};

const build = (): Promise<boolean> => buildMiniSearchIndex({ atomsDir, indexPath });

const port = (): KnowledgePort => createMiniSearchAdapter({ atomsDir, indexPath, now: NOW });

/** A SECOND corpus + index in the same root, deliberately left stale. */
const staleSiblingPort = async (): Promise<KnowledgePort> => {
  const otherAtoms = resolve(root, 'atoms-two');
  const otherIndex = resolve(root, 'index-two', 'atoms-minisearch.json');
  mkdirSync(otherAtoms, { recursive: true });
  writeFileSync(
    resolve(otherAtoms, 'a.md'),
    atomText({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' }),
    'utf8'
  );
  await buildMiniSearchIndex({ atomsDir: otherAtoms, indexPath: otherIndex });
  const ahead = new Date(statSync(otherIndex).mtimeMs + 60_000);
  utimesSync(resolve(otherAtoms, 'a.md'), ahead, ahead);
  return createMiniSearchAdapter({ atomsDir: otherAtoms, indexPath: otherIndex, now: NOW });
};

const ids = (atoms: readonly { readonly id: string }[]): readonly string[] =>
  atoms.map(atom => atom.id);

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-minisearch-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms-minisearch.json');
  mkdirSync(atomsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createMiniSearchAdapter', () => {
  it('names itself minisearch and reports the minisearch mode', async () => {
    await build();

    const instance = port();
    expect(instance.name).toBe('minisearch');
    expect((await instance.retrieve('zustand', { k: 1 })).mode).toBe('minisearch');
  });

  it('reports the optional dependency as available when it is installed', async () => {
    const availability = await miniSearchAvailability();

    expect(availability.available).toBe(true);
    expect(availability.reason).toBeUndefined();
  });

  it('reports unavailable and searches nothing when the index file is missing', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('unavailable');
    expect(result.atoms).toEqual([]);
  });

  it('reports empty when a real search ran against an index holding no atoms', async () => {
    await build();

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('empty');
    expect(result.atoms).toEqual([]);
  });

  it('does not throw when the corpus root is missing', async () => {
    await build();
    rmSync(atomsDir, { recursive: true, force: true });

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('unavailable');
    expect(result.atoms).toEqual([]);
  });

  it('reports ready and ranks the matching atom first', async () => {
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
  });

  it('reads the body from disk so an edit lands in the very next retrieve', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    await build();
    settleCorpusBehindIndex(['a.md']);
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability REWRITTEN BODY' });

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.atoms[0]?.body).toContain('REWRITTEN BODY');
  });

  it('reports stale when the corpus is newer than the index', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    await build();
    settleCorpusBehindIndex(['a.md']);
    touchAhead('a.md');

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('stale');
    expect(ids(result.atoms)).toEqual(['atom-a']);
  });

  it('truncates to k when more atoms match', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand one' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'zustand two' });
    writeAtom({ file: 'c.md', id: 'atom-c', body: 'zustand three' });
    await build();

    const result = await port().retrieve('zustand', { k: 2 });

    expect(result.atoms).toHaveLength(2);
  });

  it('returns fewer than k without padding', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand one' });
    await build();

    const result = await port().retrieve('zustand', { k: 9 });

    expect(result.atoms).toHaveLength(1);
  });

  it('breaks an exact score tie by ascending atom id', async () => {
    writeAtom({ file: 'z-first.md', id: 'zzz-atom', body: 'identical tie body text' });
    writeAtom({ file: 'a-second.md', id: 'aaa-atom', body: 'identical tie body text' });
    await build();

    const result = await port().retrieve('identical tie', { k: 5 });

    expect(ids(result.atoms)).toEqual(['aaa-atom', 'zzz-atom']);
  });

  it('produces identical ranking when the same files are created in a different order', async () => {
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

    expect(second.atoms).toEqual(first.atoms);
  });

  it('returns nothing for a term absent from the corpus', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    await build();
    settleCorpusBehindIndex(['a.md']);

    const result = await port().retrieve('nonexistentterm', { k: 5 });

    expect(result.atoms).toEqual([]);
    expect(result.indexState).toBe('ready');
  });

  it('returns nothing for an all-whitespace query without throwing', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    await build();

    const result = await port().retrieve('   ', { k: 5 });

    expect(result.atoms).toEqual([]);
  });

  it('excludes foreign-domain atoms when a domain filter is set', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', domain: 'runner', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', domain: 'standards', body: 'shared token here' });
    await build();

    const result = await port().retrieve('shared token', { k: 5, domain: 'standards' });

    expect(ids(result.atoms)).toEqual(['atom-b']);
  });

  it('excludes foreign-type atoms when a type filter is set', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'knowledge', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', type: 'adr', body: 'shared token here' });
    await build();

    const result = await port().retrieve('shared token', { k: 5, types: ['adr'] });

    expect(ids(result.atoms)).toEqual(['atom-b']);
  });

  it('keeps every atom whose type is a member of a multi-type filter', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'knowledge', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', type: 'adr', body: 'shared token here' });
    writeAtom({ file: 'c.md', id: 'atom-c', type: 'review', body: 'shared token here' });
    await build();

    const result = await port().retrieve('shared token', { k: 5, types: ['adr', 'review'] });

    expect([...ids(result.atoms)].sort()).toEqual(['atom-b', 'atom-c']);
  });

  it('refuses an empty type list instead of matching nothing', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'adr', body: 'shared token here' });
    await build();

    const attempt = async (): Promise<unknown> =>
      await port().retrieve('shared token', { k: 5, types: [] });

    await expect(attempt()).rejects.toThrow(/"types" MUST name at least one type/);
  });

  it('keeps an atom whose type is outside the closed vocabulary under the default type', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'invented_type', body: 'shared token here' });
    await build();

    const result = await port().retrieve('shared token', { k: 5, types: ['knowledge'] });

    expect(ids(result.atoms)).toEqual(['atom-a']);
    expect(result.atoms[0]?.type).toBe('knowledge');
  });

  it('excludes deprecated and expired atoms via the shared retrievability rule', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', status: 'deprecated', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', staleAfter: '2026-08-07', body: 'shared token here' });
    writeAtom({ file: 'c.md', id: 'atom-c', staleAfter: '2026-08-08', body: 'shared token here' });
    await build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect(ids(result.atoms)).toEqual(['atom-c']);
  });

  it('skips a corrupt atom and a non-markdown file instead of throwing', async () => {
    writeFileSync(resolve(atomsDir, 'broken.md'), 'no frontmatter shared token here', 'utf8');
    writeFileSync(resolve(atomsDir, 'notes.txt'), 'shared token here', 'utf8');
    writeAtom({ file: 'good.md', id: 'atom-good', body: 'shared token here' });
    await build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect(ids(result.atoms)).toEqual(['atom-good']);
  });

  it('skips an atom whose x_domain is outside the closed vocabulary', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', domain: 'invented', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'shared token here' });
    await build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect(ids(result.atoms)).toEqual(['atom-b']);
  });

  it('indexes only the injected atoms directory, never a sibling proposals directory', async () => {
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
  });

  /** The shared stemmer runs index-side AND query-side, so an inflection matches. */
  it('matches an inflected query term against the uninflected document term', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'the index of every atom' });
    await build();

    const result = await port().retrieve('indexing', { k: 5 });

    expect(ids(result.atoms)).toEqual(['atom-a']);
  });

  /** An injected processTerm overrides the default on BOTH sides, never one. */
  it('applies an injected term processor index-side and query-side alike', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'the index of every atom' });
    const identity = (term: string): string => term;
    await buildMiniSearchIndex({ atomsDir, indexPath, processTerm: identity });

    const result = await createMiniSearchAdapter({
      atomsDir,
      indexPath,
      now: NOW,
      processTerm: identity,
    }).retrieve('indexing', { k: 5 });

    expect(result.atoms).toEqual([]);
  });

  /**
   * REGRESSION GUARD for the load-vs-query cost profile: the persisted index is
   * deserialized ONCE per instance, so the warm regime is not a second
   * measurement of the cold one.
   */
  it('loads the persisted index once however many retrieves one instance serves', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    await build();
    const MiniSearch = (await import('minisearch')).default;
    const spy = vi.spyOn(MiniSearch, 'loadJSON');
    const instance = port();

    await instance.retrieve('zustand', { k: 5 });
    const afterFirst = spy.mock.calls.length;
    await instance.retrieve('zustand', { k: 5 });
    await instance.retrieve('selector', { k: 5 });

    expect(afterFirst).toBe(1);
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
    instance.close?.();
  });

  it('picks up an index built after the instance exists, so unavailable is not sticky', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    const instance = port();
    expect((await instance.retrieve('zustand', { k: 5 })).indexState).toBe('unavailable');

    await build();
    settleCorpusBehindIndex(['a.md']);

    const result = await instance.retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('ready');
    expect(ids(result.atoms)).toEqual(['atom-a']);
    instance.close?.();
  });

  /**
   * The corpus is FIXED for the lifetime of a process — a markdown change needs a
   * RESTART — so the staleness sweep (measured at ~700 ms of a ~710 ms retrieve
   * over 43 228 atoms) is sampled once per instance. Moving the corpus ahead of
   * the index under a LIVE instance is observable only if a second retrieve
   * re-scanned; a fresh instance ("restart") does see stale.
   */
  it('samples the staleness sweep once and holds that verdict for the instance', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    await build();
    settleCorpusBehindIndex(['a.md']);
    const instance = port();
    expect((await instance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');

    touchAhead('a.md');

    expect((await instance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');
    expect((await port().retrieve('zustand', { k: 5 })).indexState).toBe('stale');
    instance.close?.();
  });

  /** The sweep is memoized on the INSTANCE, so two atom dirs never share a verdict. */
  it('gives each instance over a different atoms dir its own staleness verdict', async () => {
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
  });

  it('serves a rebuilt index to a live instance instead of the one it already loaded', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only' });
    await build();
    const instance = port();
    expect((await instance.retrieve('newterm', { k: 5 })).atoms).toEqual([]);

    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only newterm' });
    await build();

    const result = await instance.retrieve('newterm', { k: 5 });

    expect(ids(result.atoms)).toEqual(['atom-a']);
    instance.close?.();
  });

  it('tolerates close being called twice', async () => {
    await build();
    const instance = port();
    await instance.retrieve('zustand', { k: 1 });

    expect(() => {
      instance.close?.();
      instance.close?.();
    }).not.toThrow();
  });

  /**
   * The optional dependency may fail at import time for reasons other than
   * MODULE_NOT_FOUND, so the loader catches EVERY import error and the adapter
   * skips instead of failing the suite.
   */
  it('skips cleanly when the optional dependency fails to import for any reason', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    await build();
    vi.doMock('minisearch', () => {
      throw new Error('simulated native binding failure');
    });
    vi.resetModules();

    const reloaded = await import('../src/adapters/miniSearchAdapter.js');
    const availability = await reloaded.miniSearchAvailability();
    const result = await reloaded
      .createMiniSearchAdapter({ atomsDir, indexPath, now: NOW })
      .retrieve('zustand', { k: 5 });

    // The reason TEXT is owned by whatever failed the import (here vitest's own
    // mock loader rewrites it), so only its presence is asserted — the point is
    // that a non-MODULE_NOT_FOUND failure is caught and reported, not swallowed.
    expect(availability.available).toBe(false);
    expect(availability.reason).toEqual(expect.any(String));
    expect(availability.reason?.length).toBeGreaterThan(0);
    expect(result.indexState).toBe('unavailable');
    expect(result.atoms).toEqual([]);
    expect(await reloaded.buildMiniSearchIndex({ atomsDir, indexPath })).toBe(false);
    vi.doUnmock('minisearch');
    vi.resetModules();
  });
});
