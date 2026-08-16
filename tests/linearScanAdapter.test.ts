import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLinearScanAdapter } from '../src/adapters/linearScanAdapter.js';
import type { AtomFrontmatter } from '../src/atom.js';
import { serializeAtom } from '../src/atom.js';
import type { RetrievalResult } from '../src/port.js';

const NOW = new Date('2026-08-08T00:00:00.000Z');

const frontmatter = (id: string, overrides: Partial<AtomFrontmatter> = {}): AtomFrontmatter => ({
  type: 'knowledge_atom',
  id,
  title: `Title ${id}`,
  x_domain: 'runner',
  status: 'stable',
  sources: ['RUNNER-GUIDE.md'],
  ...overrides,
});

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly body: string;
  readonly overrides?: Partial<AtomFrontmatter>;
}

const writeAtom = async (dir: string, spec: AtomSpec): Promise<void> => {
  const fm = frontmatter(spec.id, spec.overrides ?? {});
  await writeFile(join(dir, spec.file), serializeAtom(fm, `${spec.body}\n`), 'utf8');
};

const writeAll = async (dir: string, specs: readonly AtomSpec[]): Promise<void> => {
  for (const spec of specs) {
    await writeAtom(dir, spec);
  }
};

const ids = (result: RetrievalResult): readonly string[] => result.atoms.map(atom => atom.id);

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gnosis-linear-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const atomsDir = async (name = 'atoms'): Promise<string> => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
};

describe('createLinearScanAdapter', () => {
  it('names itself after the scan strategy', async () => {
    expect(createLinearScanAdapter(await atomsDir()).name).toBe('linear-scan');
  });

  it('ranks the denser match first and drops non-matching atoms', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'a.md', id: 'dense', body: 'bm25 bm25 bm25 ranking of atoms' },
      { file: 'b.md', id: 'sparse', body: 'bm25 is mentioned once here only' },
      { file: 'c.md', id: 'other', body: 'zustand selector stability rules' },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('bm25', { k: 10 });

    expect(ids(result)).toEqual(['dense', 'sparse']);
    expect(result.indexState).toBe('ready');
  });

  it('produces a byte-identical ranking regardless of file creation order', async () => {
    const forward = await atomsDir('forward');
    const reverse = await atomsDir('reverse');
    const specs: readonly AtomSpec[] = [
      { file: 'zulu.md', id: 'alpha-atom', body: 'index scan determinism' },
      { file: 'mike.md', id: 'bravo-atom', body: 'index scan determinism' },
      { file: 'alfa.md', id: 'charlie-atom', body: 'index scan determinism' },
    ];
    await writeAll(forward, specs);
    await writeAll(reverse, [...specs].reverse());

    const first = await createLinearScanAdapter(forward, { now: NOW }).retrieve('index', { k: 10 });
    const second = await createLinearScanAdapter(reverse, { now: NOW }).retrieve('index', { k: 10 });

    expect(ids(first)).toEqual(['alpha-atom', 'bravo-atom', 'charlie-atom']);
    expect(ids(second)).toEqual(ids(first));
    expect(second.atoms.map(a => a.score)).toEqual(first.atoms.map(a => a.score));
  });

  it('breaks a deliberate score tie by atomId ascending', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'first-written.md', id: 'zeta', body: 'identical tie breaking text' },
      { file: 'second-written.md', id: 'alpha', body: 'identical tie breaking text' },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('tie', { k: 10 });

    expect(ids(result)).toEqual(['alpha', 'zeta']);
  });

  it('returns no atoms and an empty index state for an empty corpus', async () => {
    const result = await createLinearScanAdapter(await atomsDir(), { now: NOW }).retrieve('bm25', {
      k: 5,
    });

    expect(result.atoms).toEqual([]);
    expect(result.indexState).toBe('empty');
  });

  it('reports unavailable without throwing when the corpus root does not exist', async () => {
    const missing = join(root, 'never-created');

    const result = await createLinearScanAdapter(missing, { now: NOW }).retrieve('bm25', { k: 5 });

    expect(result.atoms).toEqual([]);
    expect(result.indexState).toBe('unavailable');
  });

  it('keeps a missing corpus root distinct from a corpus holding no atoms', async () => {
    const missing = join(root, 'also-never-created');

    const absent = await createLinearScanAdapter(missing, { now: NOW }).retrieve('bm25', { k: 5 });
    const empty = await createLinearScanAdapter(await atomsDir('vacant'), { now: NOW }).retrieve(
      'bm25',
      { k: 5 }
    );

    expect(absent.indexState).toBe('unavailable');
    expect(empty.indexState).toBe('empty');
  });

  it('truncates to exactly k when more atoms match', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'a.md', id: 'a', body: 'retrieval retrieval retrieval' },
      { file: 'b.md', id: 'b', body: 'retrieval retrieval' },
      { file: 'c.md', id: 'c', body: 'retrieval' },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('retrieval', { k: 2 });

    expect(ids(result)).toEqual(['a', 'b']);
  });

  it('never pads when k exceeds the corpus size', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'retrieval scoring' }]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('retrieval', {
      k: 50,
    });

    expect(result.atoms).toHaveLength(1);
  });

  it('returns no atoms for a term absent from the corpus, with a ready index', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'retrieval scoring' }]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('kubernetes', {
      k: 5,
    });

    expect(result.atoms).toEqual([]);
    expect(result.indexState).toBe('ready');
  });

  it('excludes foreign domains when a domain filter is given', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'a.md', id: 'runner-atom', body: 'gate pipeline escalation' },
      {
        file: 'b.md',
        id: 'standards-atom',
        body: 'gate pipeline escalation',
        overrides: { x_domain: 'standards' },
      },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('pipeline', {
      k: 10,
      domain: 'standards',
    });

    expect(ids(result)).toEqual(['standards-atom']);
    expect(result.atoms[0]?.domain).toBe('standards');
  });

  it('excludes foreign types when a type filter is given', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      {
        file: 'a.md',
        id: 'knowledge-atom',
        body: 'gate pipeline escalation',
        overrides: { type: 'knowledge' },
      },
      {
        file: 'b.md',
        id: 'adr-atom',
        body: 'gate pipeline escalation',
        overrides: { type: 'adr' },
      },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('pipeline', {
      k: 10,
      types: ['adr'],
    });

    expect(ids(result)).toEqual(['adr-atom']);
    expect(result.atoms[0]?.type).toBe('adr');
  });

  /**
   * The single-element regression gate: `types: ['adr']` MUST return exactly
   * what the pre-list `type: 'adr'` returned, so widening the filter to a list
   * cannot have moved the one-type case.
   */
  it('returns the same atoms for a one-element list as the single-type filter returned', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'a.md', id: 'knowledge-atom', body: 'gate pipeline escalation', overrides: { type: 'knowledge' } },
      { file: 'b.md', id: 'adr-atom', body: 'gate pipeline escalation', overrides: { type: 'adr' } },
      { file: 'c.md', id: 'review-atom', body: 'gate pipeline escalation', overrides: { type: 'review' } },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('pipeline', {
      k: 10,
      types: ['adr'],
    });

    expect(ids(result)).toEqual(['adr-atom']);
  });

  it('keeps every atom whose type is a member of a multi-type filter', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'a.md', id: 'knowledge-atom', body: 'gate pipeline escalation', overrides: { type: 'knowledge' } },
      { file: 'b.md', id: 'adr-atom', body: 'gate pipeline escalation', overrides: { type: 'adr' } },
      { file: 'c.md', id: 'review-atom', body: 'gate pipeline escalation', overrides: { type: 'review' } },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('pipeline', {
      k: 10,
      types: ['adr', 'review'],
    });

    expect([...ids(result)].sort()).toEqual(['adr-atom', 'review-atom']);
  });

  it('refuses an empty type list instead of matching nothing', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'a.md', id: 'adr-atom', body: 'gate pipeline escalation' }]);

    const attempt = async (): Promise<RetrievalResult> =>
      await createLinearScanAdapter(dir, { now: NOW }).retrieve('pipeline', { k: 10, types: [] });

    await expect(attempt()).rejects.toThrow(/"types" MUST name at least one type/);
  });

  it('keeps an atom whose type is outside the closed vocabulary under the default type', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'a.md', id: 'odd-atom', body: 'gate pipeline escalation' }]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('pipeline', {
      k: 10,
      types: ['knowledge'],
    });

    expect(ids(result)).toEqual(['odd-atom']);
    expect(result.atoms[0]?.type).toBe('knowledge');
  });

  it('reads the body from disk on every call, so an edit needs no reindex', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'original oscillation text' }]);
    const port = createLinearScanAdapter(dir, { now: NOW });

    const before = await port.retrieve('oscillation', { k: 5 });
    await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'rewritten oscillation text' }]);
    const after = await port.retrieve('oscillation', { k: 5 });

    expect(before.atoms[0]?.body).toContain('original');
    expect(after.atoms[0]?.body).toContain('rewritten');
  });

  it('skips a corrupt atom and a non-markdown file instead of throwing', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'good.md', id: 'good', body: 'compaction budget' }]);
    await writeFile(join(dir, 'broken.md'), 'no frontmatter compaction here\n', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'compaction compaction compaction\n', 'utf8');

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('compaction', {
      k: 10,
    });

    expect(ids(result)).toEqual(['good']);
  });

  it('applies the shared retrievability rule to deprecated and expired atoms', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'a.md', id: 'live', body: 'telemetry ledger' },
      { file: 'b.md', id: 'dead', body: 'telemetry ledger', overrides: { status: 'deprecated' } },
      {
        file: 'c.md',
        id: 'expired',
        body: 'telemetry ledger',
        overrides: { stale_after: '2026-08-07' },
      },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('telemetry', {
      k: 10,
    });

    expect(ids(result)).toEqual(['live']);
  });

  it('reports an empty index when every atom in the corpus is unretrievable', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [
      { file: 'a.md', id: 'dead', body: 'telemetry ledger', overrides: { status: 'deprecated' } },
    ]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('telemetry', {
      k: 10,
    });

    expect(result.indexState).toBe('empty');
  });

  it('cannot reach a markdown file that sits in the proposals directory', async () => {
    const atoms = await atomsDir('atoms');
    const proposals = await atomsDir('proposals');
    await writeAll(atoms, [{ file: 'a.md', id: 'curated', body: 'shared vault text' }]);
    await writeAll(proposals, [{ file: 'b.md', id: 'proposed', body: 'shared vault text' }]);

    const result = await createLinearScanAdapter(atoms, { now: NOW }).retrieve('vault', { k: 10 });

    expect(ids(result)).toEqual(['curated']);
  });

  it('applies an injected processTerm on both the document side and the query side', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'the qqindex rebuild step' }]);
    const dropPrefix = (term: string): string => (term.startsWith('qq') ? term.slice(2) : term);

    const processed = await createLinearScanAdapter(dir, {
      now: NOW,
      processTerm: dropPrefix,
    }).retrieve('qqindex', { k: 5 });
    const raw = await createLinearScanAdapter(dir, {
      now: NOW,
      processTerm: term => term,
    }).retrieve('index', { k: 5 });

    expect(ids(processed)).toEqual(['a']);
    expect(raw.atoms).toEqual([]);
  });

  it('defaults processTerm to the shared English stemmer', async () => {
    const dir = await atomsDir();
    await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'the index rebuild step' }]);

    const result = await createLinearScanAdapter(dir, { now: NOW }).retrieve('indexing', { k: 5 });

    expect(ids(result)).toEqual(['a']);
  });

  describe('BM25 parameters', () => {
    // `long` has twice the term frequency but ~6x the length; `b` decides which wins.
    const lengthSpecs: readonly AtomSpec[] = [
      { file: 'a.md', id: 'short', body: 'bm25 tuning' },
      {
        file: 'b.md',
        id: 'long',
        body: `bm25 bm25 ${'filler words about unrelated topics '.repeat(12)}`,
      },
    ];

    it('defaults to k1 1.2 and b 0.75 when neither is passed', async () => {
      const dir = await atomsDir();
      await writeAll(dir, lengthSpecs);

      const implicit = await createLinearScanAdapter(dir, { now: NOW }).retrieve('bm25', { k: 5 });
      const explicit = await createLinearScanAdapter(dir, {
        now: NOW,
        k1: 1.2,
        b: 0.75,
      }).retrieve('bm25', { k: 5 });

      expect(explicit.atoms.map(atom => atom.score)).toEqual(implicit.atoms.map(atom => atom.score));
    });

    it('drops the length penalty at b 0, flipping the ranking', async () => {
      const dir = await atomsDir();
      await writeAll(dir, lengthSpecs);

      const normalized = await createLinearScanAdapter(dir, { now: NOW, b: 0.75 }).retrieve('bm25', {
        k: 5,
      });
      const flat = await createLinearScanAdapter(dir, { now: NOW, b: 0 }).retrieve('bm25', { k: 5 });

      expect(ids(normalized)).toEqual(['short', 'long']);
      expect(ids(flat)).toEqual(['long', 'short']);
    });

    it('saturates term frequency harder as k1 falls', async () => {
      const dir = await atomsDir();
      await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'bm25 bm25 bm25 bm25 tuning' }]);

      const wide = await createLinearScanAdapter(dir, { now: NOW, k1: 1.2 }).retrieve('bm25', {
        k: 5,
      });
      const tight = await createLinearScanAdapter(dir, { now: NOW, k1: 0.8 }).retrieve('bm25', {
        k: 5,
      });

      expect(tight.atoms[0]!.score).toBeLessThan(wide.atoms[0]!.score);
    });
  });

  describe('cacheCorpusScan', () => {
    const specs: readonly AtomSpec[] = [
      { file: 'a.md', id: 'short', body: 'bm25 tuning' },
      {
        file: 'b.md',
        id: 'long',
        body: `bm25 bm25 ${'filler words about unrelated topics '.repeat(12)}`,
      },
    ];

    it('is off by default, so an on-disk edit is visible to the very next call', async () => {
      const dir = await atomsDir();
      await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'bm25 tuning' }]);
      const port = createLinearScanAdapter(dir, { now: NOW });

      const before = await port.retrieve('zustand', { k: 5 });
      await writeAtom(dir, { file: 'b.md', id: 'b', body: 'zustand selector stability' });
      const after = await port.retrieve('zustand', { k: 5 });

      expect(ids(before)).toEqual([]);
      expect(ids(after)).toEqual(['b']);
    });

    it('ranks identically whether the scan is cached or not', async () => {
      const plain = await atomsDir('plain');
      const cached = await atomsDir('cached');
      await writeAll(plain, specs);
      await writeAll(cached, specs);

      const uncached = await createLinearScanAdapter(plain, { now: NOW }).retrieve('bm25', { k: 5 });
      const hot = createLinearScanAdapter(cached, { now: NOW, cacheCorpusScan: true });
      await hot.retrieve('bm25', { k: 5 });
      const second = await hot.retrieve('bm25', { k: 5 });

      expect(ids(second)).toEqual(ids(uncached));
      expect(second.atoms.map(atom => atom.score)).toEqual(uncached.atoms.map(atom => atom.score));
    });

    it('still re-scores when k1 or b changes, proving only the scan is cached', async () => {
      const dir = await atomsDir();
      await writeAll(dir, specs);
      const cache = { now: NOW, cacheCorpusScan: true } as const;

      const normalized = await createLinearScanAdapter(dir, { ...cache, b: 0.75 }).retrieve('bm25', {
        k: 5,
      });
      const flat = await createLinearScanAdapter(dir, { ...cache, b: 0 }).retrieve('bm25', { k: 5 });

      expect(ids(normalized)).toEqual(['short', 'long']);
      expect(ids(flat)).toEqual(['long', 'short']);
    });

    it('reuses the scan when the signature is unchanged, so a size- and mtime-preserving edit is not seen', async () => {
      const dir = await atomsDir();
      const stamp = new Date(2026, 0, 1);
      await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'bm25 tuning' }]);
      await utimes(join(dir, 'a.md'), stamp, stamp);
      const port = createLinearScanAdapter(dir, { now: NOW, cacheCorpusScan: true });
      await port.retrieve('bm25', { k: 5 });

      await writeAtom(dir, { file: 'a.md', id: 'a', body: 'zustand xyz' });
      await utimes(join(dir, 'a.md'), stamp, stamp);

      expect(ids(await port.retrieve('zustand', { k: 5 }))).toEqual([]);
    });

    it('invalidates the cache on a count-preserving swap at an unchanged newest mtime', async () => {
      const dir = await atomsDir();
      const stamp = new Date(2026, 0, 1);
      await writeAll(dir, [
        { file: 'a.md', id: 'a', body: 'bm25 tuning' },
        { file: 'b.md', id: 'b', body: 'bm25 tuning' },
      ]);
      await utimes(join(dir, 'a.md'), stamp, stamp);
      await utimes(join(dir, 'b.md'), stamp, stamp);
      const port = createLinearScanAdapter(dir, { now: NOW, cacheCorpusScan: true });

      const before = await port.retrieve('zustand', { k: 5 });
      await rm(join(dir, 'b.md'));
      await writeAtom(dir, { file: 'c.md', id: 'c', body: 'zustand xyz' });
      await utimes(join(dir, 'c.md'), stamp, stamp);
      const after = await port.retrieve('zustand', { k: 5 });

      expect(ids(before)).toEqual([]);
      expect(ids(after)).toEqual(['c']);
    });

    it('invalidates the cache when a file is restored to an OLDER mtime', async () => {
      const dir = await atomsDir();
      const stamp = new Date(2026, 0, 1);
      await writeAll(dir, [
        { file: 'a.md', id: 'a', body: 'bm25 tuning' },
        { file: 'b.md', id: 'b', body: 'bm25 tuning' },
      ]);
      await utimes(join(dir, 'a.md'), stamp, stamp);
      const port = createLinearScanAdapter(dir, { now: NOW, cacheCorpusScan: true });

      const before = await port.retrieve('zustand', { k: 5 });
      await writeAtom(dir, { file: 'a.md', id: 'a', body: 'zustand selector stability' });
      const older = new Date(2025, 0, 1);
      await utimes(join(dir, 'a.md'), older, older);
      const after = await port.retrieve('zustand', { k: 5 });

      expect(ids(before)).toEqual([]);
      expect(ids(after)).toEqual(['a']);
    });

    it('invalidates the cache when the corpus file count changes', async () => {
      const dir = await atomsDir();
      await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'bm25 tuning' }]);
      const port = createLinearScanAdapter(dir, { now: NOW, cacheCorpusScan: true });

      const before = await port.retrieve('zustand', { k: 5 });
      await writeAtom(dir, { file: 'b.md', id: 'b', body: 'zustand selector stability' });
      const after = await port.retrieve('zustand', { k: 5 });

      expect(ids(before)).toEqual([]);
      expect(ids(after)).toEqual(['b']);
    });

    it('invalidates the cache when an atom is rewritten with a newer mtime', async () => {
      const dir = await atomsDir();
      await writeAll(dir, [{ file: 'a.md', id: 'a', body: 'bm25 tuning' }]);
      const port = createLinearScanAdapter(dir, { now: NOW, cacheCorpusScan: true });

      const before = await port.retrieve('zustand', { k: 5 });
      await writeAtom(dir, { file: 'a.md', id: 'a', body: 'zustand selector stability' });
      const later = new Date(Date.now() + 60_000);
      await utimes(join(dir, 'a.md'), later, later);
      const after = await port.retrieve('zustand', { k: 5 });

      expect(ids(before)).toEqual([]);
      expect(ids(after)).toEqual(['a']);
    });
  });
});
