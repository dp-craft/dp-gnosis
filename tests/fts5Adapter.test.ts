import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { buildFts5Index, createFts5Adapter } from '../src/adapters/fts5Adapter.js';
import type { KnowledgePort } from '../src/port.js';

const NOW = new Date('2026-08-08T00:00:00.000Z');

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly domain?: string;
  readonly status?: string;
  readonly staleAfter?: string;
  readonly body: string;
}

const atomText = (spec: AtomSpec): string =>
  [
    '---',
    'type: knowledge',
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

const build = (): void => buildFts5Index({ atomsDir, indexPath });

const port = (): KnowledgePort => createFts5Adapter({ atomsDir, indexPath, now: NOW });

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-fts5-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  mkdirSync(atomsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createFts5Adapter', () => {
  it('names itself fts5', () => {
    expect(port().name).toBe('fts5');
  });

  it('reports unavailable and searches nothing when the index file is missing', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('unavailable');
    expect(result.atoms).toEqual([]);
  });

  it('reports empty when a real search ran against an index holding no atoms', async () => {
    build();

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('empty');
    expect(result.atoms).toEqual([]);
  });

  it('reports ready and ranks the matching atom first', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability rules' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'sqlite fts5 bm25 ranking notes' });
    build();
    settleCorpusBehindIndex(['a.md', 'b.md']);

    const result = await port().retrieve('zustand selector', { k: 5 });

    expect(result.indexState).toBe('ready');
    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
    expect(result.atoms[0]?.score).toBeGreaterThan(0);
    expect(result.atoms[0]?.title).toBe('title of atom-a');
  });

  it('reads the body from disk so an edit lands in the very next retrieve', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    build();
    settleCorpusBehindIndex(['a.md']);
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability REWRITTEN BODY' });

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.atoms[0]?.body).toContain('REWRITTEN BODY');
  });

  it('reports stale when the corpus is newer than the index', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    build();
    settleCorpusBehindIndex(['a.md']);
    touchAhead('a.md');

    const result = await port().retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('stale');
    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
  });

  it('truncates to k when more atoms match', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand one' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'zustand two' });
    writeAtom({ file: 'c.md', id: 'atom-c', body: 'zustand three' });
    build();

    const result = await port().retrieve('zustand', { k: 2 });

    expect(result.atoms).toHaveLength(2);
  });

  it('returns fewer than k without padding', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand one' });
    build();

    const result = await port().retrieve('zustand', { k: 9 });

    expect(result.atoms).toHaveLength(1);
  });

  it('breaks an exact score tie by ascending atom id', async () => {
    writeAtom({ file: 'z-first.md', id: 'zzz-atom', body: 'identical tie body text' });
    writeAtom({ file: 'a-second.md', id: 'aaa-atom', body: 'identical tie body text' });
    build();

    const result = await port().retrieve('identical tie', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['aaa-atom', 'zzz-atom']);
  });

  it('returns nothing for a term absent from the corpus', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    build();
    settleCorpusBehindIndex(['a.md']);

    const result = await port().retrieve('nonexistentterm', { k: 5 });

    expect(result.atoms).toEqual([]);
    expect(result.indexState).toBe('ready');
  });

  it('matches terms carrying FTS5 syntax characters instead of throwing', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'adr-018 covers ns:key and c++ and a*b and ^caret' });
    build();

    const result = await port().retrieve('adr-018 ns:key c++ a*b ^caret "', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
  });

  it('returns nothing for an all-whitespace query without throwing', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    build();

    const result = await port().retrieve('   ', { k: 5 });

    expect(result.atoms).toEqual([]);
  });

  it('excludes foreign-domain atoms when a domain filter is set', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', domain: 'runner', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', domain: 'standards', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5, domain: 'standards' });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-b']);
  });

  it('excludes deprecated and expired atoms via the shared retrievability rule', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', status: 'deprecated', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', staleAfter: '2026-08-07', body: 'shared token here' });
    writeAtom({ file: 'c.md', id: 'atom-c', staleAfter: '2026-08-08', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-c']);
  });

  it('skips a corrupt atom and a non-markdown file instead of throwing', async () => {
    writeFileSync(resolve(atomsDir, 'broken.md'), 'no frontmatter shared token here', 'utf8');
    writeFileSync(resolve(atomsDir, 'notes.txt'), 'shared token here', 'utf8');
    writeAtom({ file: 'good.md', id: 'atom-good', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-good']);
  });

  it('skips an atom whose x_domain is outside the closed vocabulary', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', domain: 'invented', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-b']);
  });

  it('produces identical ranking when the same files are created in a different order', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha beta gamma delta' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'alpha beta gamma' });
    writeAtom({ file: 'c.md', id: 'atom-c', body: 'alpha beta' });
    build();
    const first = await port().retrieve('alpha beta gamma delta', { k: 5 });

    rmSync(atomsDir, { recursive: true, force: true });
    mkdirSync(atomsDir, { recursive: true });
    writeAtom({ file: 'c.md', id: 'atom-c', body: 'alpha beta' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'alpha beta gamma' });
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha beta gamma delta' });
    build();
    const second = await port().retrieve('alpha beta gamma delta', { k: 5 });

    expect(second.atoms).toEqual(first.atoms);
  });

  it('reflects a single-atom edit in the ranking after a rebuild', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'beta only' });
    build();
    expect((await port().retrieve('newterm', { k: 5 })).atoms).toEqual([]);

    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only newterm' });
    build();

    const result = await port().retrieve('newterm', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
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
    build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
  });

  it('reports the fts5 mode on every call', async () => {
    build();

    expect((await port().retrieve('zustand', { k: 1 })).mode).toBe('fts5');
  });
});
