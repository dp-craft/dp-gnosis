import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { buildFts5Index, createFts5Adapter, toMatchExpression } from '../src/adapters/fts5Adapter.js';
import type { KnowledgePort } from '../src/port.js';
import { stemText } from '../src/query.js';

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

const build = (): void => buildFts5Index({ atomsDir, indexPath });

/** A SECOND corpus + index in the same root, deliberately left stale. */
const staleSiblingPort = (): KnowledgePort => {
  const otherAtoms = resolve(root, 'atoms-two');
  const otherIndex = resolve(root, 'index-two', 'atoms.db');
  mkdirSync(otherAtoms, { recursive: true });
  writeFileSync(
    resolve(otherAtoms, 'a.md'),
    atomText({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' }),
    'utf8'
  );
  buildFts5Index({ atomsDir: otherAtoms, indexPath: otherIndex });
  const ahead = new Date(statSync(otherIndex).mtimeMs + 60_000);
  utimesSync(resolve(otherAtoms, 'a.md'), ahead, ahead);
  return createFts5Adapter({ atomsDir: otherAtoms, indexPath: otherIndex, now: NOW });
};

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

  it('excludes foreign-type atoms when a type filter is set', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'knowledge', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', type: 'adr', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5, types: ['adr'] });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-b']);
  });

  it('keeps every atom whose type is a member of a multi-type filter', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'knowledge', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', type: 'adr', body: 'shared token here' });
    writeAtom({ file: 'c.md', id: 'atom-c', type: 'review', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5, types: ['adr', 'review'] });

    expect([...result.atoms.map(atom => atom.id)].sort()).toEqual(['atom-b', 'atom-c']);
  });

  it('refuses an empty type list instead of matching nothing', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'adr', body: 'shared token here' });
    build();

    const attempt = async (): Promise<unknown> =>
      await port().retrieve('shared token', { k: 5, types: [] });

    await expect(attempt()).rejects.toThrow(/"types" MUST name at least one type/);
  });

  it('keeps an atom whose type is outside the closed vocabulary under the default type', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', type: 'invented_type', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5, types: ['knowledge'] });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
    expect(result.atoms[0]?.type).toBe('knowledge');
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

  it('indexes an atom whose x_domain is outside the SHIPPED vocabulary, carrying the label through', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', domain: 'invented', body: 'shared token here' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'shared token here' });
    build();

    const result = await port().retrieve('shared token', { k: 5 });

    expect([...result.atoms.map(atom => atom.id)].sort()).toEqual(['atom-a', 'atom-b']);
    expect(result.atoms.find(atom => atom.id === 'atom-a')?.domain).toBe('invented');
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

  /**
   * REGRESSION GUARD. Re-opening the database per call made the benchmark's warm
   * regime a second measurement of the cold regime. `prepare` is the observable:
   * a reopen must re-prepare, so a constant prepare count across N retrieves
   * pins that one handle served them all.
   */
  it('opens and prepares once per instance however many retrieves it serves', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    build();
    const instance = port();
    const spy = vi.spyOn(Database.prototype, 'prepare');

    await instance.retrieve('zustand', { k: 5 });
    const afterFirst = spy.mock.calls.length;
    await instance.retrieve('zustand', { k: 5 });
    await instance.retrieve('selector', { k: 5 });

    expect(afterFirst).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBe(afterFirst);
    spy.mockRestore();
    instance.close?.();
  });

  it('picks up an index built after the instance exists, so unavailable is not sticky', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    const instance = port();
    expect((await instance.retrieve('zustand', { k: 5 })).indexState).toBe('unavailable');

    build();
    settleCorpusBehindIndex(['a.md']);

    const result = await instance.retrieve('zustand', { k: 5 });

    expect(result.indexState).toBe('ready');
    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
    instance.close?.();
  });

  it('serves a rebuilt index to a live instance instead of the deleted file it held open', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only' });
    build();
    const instance = port();
    expect((await instance.retrieve('newterm', { k: 5 })).atoms).toEqual([]);

    writeAtom({ file: 'a.md', id: 'atom-a', body: 'alpha only newterm' });
    build();

    const result = await instance.retrieve('newterm', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
    instance.close?.();
  });

  /**
   * AC DELTA — the corpus is FIXED for the lifetime of a process and a markdown
   * change requires a RESTART, so the staleness sweep is sampled once per
   * instance instead of per call. Measured before: ~700 ms of a ~710 ms retrieve
   * over 43 228 atoms was this sweep. Moving the corpus ahead of the index under
   * a LIVE instance is observable only if a second retrieve re-scanned — so the
   * held verdict is the assertion, and a fresh instance ("restart") sees stale.
   */
  it('samples the staleness sweep once and holds that verdict for the instance', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    build();
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
    build();
    settleCorpusBehindIndex(['a.md']);
    const readyInstance = port();
    const staleInstance = staleSiblingPort();

    expect((await readyInstance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');
    expect((await staleInstance.retrieve('zustand', { k: 5 })).indexState).toBe('stale');
    expect((await readyInstance.retrieve('zustand', { k: 5 })).indexState).toBe('ready');
    expect((await staleInstance.retrieve('zustand', { k: 5 })).indexState).toBe('stale');
    readyInstance.close?.();
    staleInstance.close?.();
  });

  it('re-reads the body from disk on every call of one long-lived instance', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability' });
    build();
    settleCorpusBehindIndex(['a.md']);
    const instance = port();
    await instance.retrieve('zustand', { k: 5 });

    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selector stability REWRITTEN BODY' });

    const result = await instance.retrieve('zustand', { k: 5 });

    expect(result.atoms[0]?.body).toContain('REWRITTEN BODY');
    instance.close?.();
  });

  it('tolerates close being called twice', async () => {
    build();
    const instance = port();
    await instance.retrieve('zustand', { k: 1 });

    expect(() => {
      instance.close?.();
      instance.close?.();
    }).not.toThrow();
  });

  it('reports the fts5 mode on every call', async () => {
    build();

    expect((await port().retrieve('zustand', { k: 1 })).mode).toBe('fts5');
  });

  /**
   * The row walk must stop once the answer is settled. `b.md` is replaced by a
   * DIRECTORY after the index is built, so any read of it throws EISDIR: only a
   * scan that runs past the settled point can touch it.
   */
  it('stops reading rows once the answer is settled', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand zustand zustand' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: `zustand ${'filler '.repeat(40)}` });
    build();
    rmSync(resolve(atomsDir, 'b.md'));
    mkdirSync(resolve(atomsDir, 'b.md'));

    const result = await port().retrieve('zustand', { k: 1 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-a']);
  });

  it('returns the same k atoms an unbounded full scan would when far more rows match', async () => {
    const count = 40;
    Array.from({ length: count }, (_unused, i) => i).forEach(i => {
      const tag = String(i).padStart(2, '0');
      writeAtom({ file: `m${tag}.md`, id: `atom-${tag}`, body: `zustand ${'filler '.repeat(i)}selector` });
    });
    build();

    const bounded = await port().retrieve('zustand selector', { k: 5 });
    const fullScan = await port().retrieve('zustand selector', { k: count });

    expect(bounded.atoms).toEqual(fullScan.atoms.slice(0, 5));
  });

  it('reads every row tied at the k-th score so the id tie-break stays stable', async () => {
    ['e', 'd', 'c', 'b', 'a'].forEach(letter =>
      writeAtom({ file: `${letter}.md`, id: `atom-${letter}`, body: 'identical tie body text' })
    );
    build();

    const bounded = await port().retrieve('identical tie', { k: 2 });
    const fullScan = await port().retrieve('identical tie', { k: 5 });

    expect(bounded.atoms.map(atom => atom.id)).toEqual(['atom-a', 'atom-b']);
    expect(bounded.atoms).toEqual(fullScan.atoms.slice(0, 2));
  });

  it('scans past missing and non-retrievable atoms to still return k', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand zustand zustand' });
    writeAtom({ file: 'b.md', id: 'atom-b', body: 'zustand zustand zustand' });
    writeAtom({ file: 'c.md', id: 'atom-c', body: 'zustand zustand' });
    writeAtom({ file: 'd.md', id: 'atom-d', body: 'zustand' });
    build();
    rmSync(resolve(atomsDir, 'a.md'));
    writeAtom({ file: 'b.md', id: 'atom-b', status: 'deprecated', body: 'zustand zustand zustand' });

    const result = await port().retrieve('zustand', { k: 2 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-c', 'atom-d']);
  });

  it('returns k when a domain filter matches only low-ranked rows', async () => {
    ['r1', 'r2', 'r3'].forEach(name =>
      writeAtom({ file: `${name}.md`, id: `atom-${name}`, domain: 'runner', body: 'zustand zustand zustand' })
    );
    writeAtom({ file: 's1.md', id: 'atom-s1', domain: 'standards', body: 'zustand filler filler filler' });
    writeAtom({
      file: 's2.md',
      id: 'atom-s2',
      domain: 'standards',
      body: 'zustand filler filler filler filler filler',
    });
    build();

    const result = await port().retrieve('zustand', { k: 2, domain: 'standards' });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-s1', 'atom-s2']);
  });

  it('returns k when a type filter matches only low-ranked rows', async () => {
    ['k1', 'k2', 'k3'].forEach(name =>
      writeAtom({ file: `${name}.md`, id: `atom-${name}`, type: 'knowledge', body: 'zustand zustand zustand' })
    );
    writeAtom({ file: 'x1.md', id: 'atom-x1', type: 'adr', body: 'zustand filler filler filler' });
    writeAtom({
      file: 'x2.md',
      id: 'atom-x2',
      type: 'adr',
      body: 'zustand filler filler filler filler filler',
    });
    build();

    const result = await port().retrieve('zustand', { k: 2, types: ['adr'] });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-x1', 'atom-x2']);
  });
});

/**
 * The index CARRIES the analysis chain that built it, and the query side reads
 * it back — so symmetry between hop 7 and hop 11 is a property of the artifact
 * rather than a convention two call sites happen to honour.
 */
describe('fts5 analyzer stamp', () => {
  /** A corpus of realistic atom bodies, several of them stemming-sensitive. */
  const FIXTURE: readonly AtomSpec[] = [
    {
      file: 'a.md',
      id: 'atom-selectors',
      body: 'Zustand selectors MUST return stable references; unstable selectors cause render loops.',
    },
    {
      file: 'b.md',
      id: 'atom-fts5',
      body: 'The fts5 table is contentless, so bodies are re-read from disk at call time.',
    },
    {
      file: 'c.md',
      id: 'atom-adr',
      body: 'adr-018 supersedes the six-category mandate and defines the layered test model.',
    },
    {
      file: 'd.md',
      id: 'atom-stemming',
      body: 'Porter stemming folds selectors and selector onto one term, so both spellings match.',
    },
    {
      file: 'e.md',
      id: 'atom-cafe',
      body: 'A café note about diacritic folding and the unicode61 tokenizer of SQLite.',
    },
  ];

  const QUERIES: readonly string[] = [
    'zustand selectors',
    'adr-018',
    'diacritic folding cafe',
    'contentless bodies disk',
    'stemming spellings',
  ];

  const writeFixture = (): void => FIXTURE.forEach(writeAtom);

  /**
   * The PRE-CHANGE writer, reproduced verbatim: `stemText` bodies, no
   * `index_meta`. It is both the back-compat artifact and the reference the
   * default path is compared against.
   */
  const buildLegacyIndex = (): void => {
    rmSync(indexPath, { force: true });
    mkdirSync(dirname(indexPath), { recursive: true });
    const db = new Database(indexPath);
    db.exec(
      'CREATE TABLE atom_meta(rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, path TEXT NOT NULL)'
    );
    db.exec('CREATE VIRTUAL TABLE atom_fts USING fts5(body, content=\'\', detail=full)');
    const meta = db.prepare('INSERT INTO atom_meta(rowid, id, path) VALUES (?, ?, ?)');
    const fts = db.prepare('INSERT INTO atom_fts(rowid, body) VALUES (?, ?)');
    db.transaction(() =>
      [...FIXTURE]
        .sort((left, right) => (left.file < right.file ? -1 : 1))
        .forEach((spec, index) => {
          meta.run(index + 1, spec.id, spec.file);
          fts.run(index + 1, stemText(spec.body));
        })
    )();
    db.close();
  };

  const readStamp = (): string | undefined => {
    const db = new Database(indexPath, { readonly: true });
    const table = db
      .prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'index_meta\'')
      .get();
    const row =
      table === undefined
        ? undefined
        : (db.prepare('SELECT value AS value FROM index_meta WHERE key = \'analyzer\'').get() as
            | { value: string }
            | undefined);
    db.close();
    return row?.value;
  };

  const restamp = (value: string): void => {
    const db = new Database(indexPath);
    db.prepare('UPDATE index_meta SET value = ? WHERE key = \'analyzer\'').run(value);
    db.close();
  };

  const answers = async (): Promise<unknown> => {
    const instance = port();
    const results = [];
    for (const query of QUERIES) results.push(await instance.retrieve(query, { k: 5 }));
    instance.close?.();
    return results.map(result => result.atoms);
  };

  // `porter-fold` is named EXPLICITLY: it is the chain the pre-stamp writer used,
  // and naming it keeps this case pinned to that chain however the default moves.
  it('answers a porter-fold build exactly as the pre-stamp writer did, rows and ranking alike', async () => {
    writeFixture();
    buildFts5Index({ atomsDir, indexPath, analyzer: 'porter-fold' });
    const stamped = await answers();

    buildLegacyIndex();
    const legacy = await answers();

    expect(stamped).toEqual(legacy);
    expect(legacy).not.toEqual([[], [], [], [], []]);
  });

  it('stamps the default analyzer when no analyzer is named', () => {
    writeFixture();

    buildFts5Index({ atomsDir, indexPath });

    expect(readStamp()).toBe('porter-fold');
  });

  it('round-trips a named analyzer: stamped on build, read back on query', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selectors stability' });
    buildFts5Index({ atomsDir, indexPath, analyzer: 'nostem-fold' });

    expect(readStamp()).toBe('nostem-fold');
    expect((await port().retrieve('selectors', { k: 5 })).atoms.map(atom => atom.id)).toEqual([
      'atom-a',
    ]);
  });

  it('answers differently under nostem-fold than under porter-fold for a stemmed term', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selectors stability' });

    buildFts5Index({ atomsDir, indexPath, analyzer: 'nostem-fold' });
    const unstemmed = await port().retrieve('selector', { k: 5 });
    buildFts5Index({ atomsDir, indexPath, analyzer: 'porter-fold' });
    const stemmed = await port().retrieve('selector', { k: 5 });

    expect(unstemmed.atoms).toEqual([]);
    expect(stemmed.atoms.map(atom => atom.id)).toEqual(['atom-a']);
  });

  it('reads an index carrying no index_meta as porter-fold, without throwing or rebuilding', async () => {
    writeFixture();
    buildLegacyIndex();

    const result = await port().retrieve('zustand selectors', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-selectors', 'atom-stemming']);
    expect(readStamp()).toBeUndefined();
  });

  it('refuses an index stamped with an analyzer outside the known chains', async () => {
    writeAtom({ file: 'a.md', id: 'atom-a', body: 'zustand selectors stability' });
    buildFts5Index({ atomsDir, indexPath });
    restamp('klingon-fold');

    const attempt = async (): Promise<unknown> => await port().retrieve('zustand', { k: 5 });

    await expect(attempt()).rejects.toThrow(/unknown analyzer "klingon-fold"/);
  });

  it('keeps a multi-token chunk an adjacency phrase under the stamped analyzer', async () => {
    writeAtom({ file: 'a.md', id: 'atom-adjacent', body: 'adr-018 defines the layered test model' });
    writeAtom({ file: 'b.md', id: 'atom-apart', body: 'adr work covers 018 somewhere else' });
    buildFts5Index({ atomsDir, indexPath });

    const result = await port().retrieve('adr-018', { k: 5 });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-adjacent']);
  });
});

/**
 * THE REGRESSION CONTRACT of the query-adjacency treatment: with `adjacency`
 * absent or false the expression is what it has always been, byte for byte, for
 * every shape of input — so every recorded fts5 run stays reproducible.
 */
describe('toMatchExpression — adjacency OFF is byte-identical', () => {
  const cases: readonly (readonly [string, string | undefined])[] = [
    ['lint:test-shape', '"lint test shape"'],
    ['dirty-tree', '"dirti tree"'],
    ['zustand', '"zustand"'],
    ['adr-018 store', '"adr 018" OR "store"'],
    ['e2e   spacing', '"e2" OR "space"'],
    ['say "hi" now', '"sai" OR "hi" OR "now"'],
    ['', undefined],
    ['   ', undefined],
    ['"', undefined],
  ];

  cases.forEach(([query, expected]) => {
    it(`emits ${String(expected)} for ${JSON.stringify(query)} when adjacency is absent`, () => {
      expect(toMatchExpression(query, 'porter-fold')).toBe(expected);
    });

    it(`emits ${String(expected)} for ${JSON.stringify(query)} when adjacency is false`, () => {
      expect(toMatchExpression(query, 'porter-fold', false)).toBe(expected);
    });
  });
});

/**
 * The treatment itself: an ADDED disjunct, never a substituted one and never a
 * filter — the individual terms stay in the expression.
 */
describe('toMatchExpression — adjacency ON', () => {
  it('adds the multi-term phrase BESIDE the individual terms of one raw token', () => {
    expect(toMatchExpression('lint:test-shape', 'porter-fold', true)).toBe(
      '"lint" OR "test" OR "shape" OR "lint test shape"'
    );
  });

  it('adds one phrase per multi-token raw token, in query order', () => {
    expect(toMatchExpression('adr-018 dirty-tree', 'porter-fold', true)).toBe(
      '"adr" OR "018" OR "adr 018" OR "dirti" OR "tree" OR "dirti tree"'
    );
  });

  it('leaves a single-token raw token exactly as adjacency-off emits it', () => {
    expect(toMatchExpression('zustand selectors', 'porter-fold', true)).toBe(
      toMatchExpression('zustand selectors', 'porter-fold')
    );
  });

  it('still emits undefined for a term-free query', () => {
    expect(toMatchExpression('  "  ', 'porter-fold', true)).toBeUndefined();
  });

  it('honours the stamped analyzer when building the phrase', () => {
    expect(toMatchExpression('dirty-tree', 'nostem-fold', true)).toBe(
      '"dirty" OR "tree" OR "dirty tree"'
    );
  });
});

describe('fts5 adjacency retrieval', () => {
  const writePair = (): void => {
    writeAtom({ file: 'a.md', id: 'atom-adjacent', body: 'adr-018 defines the layered test model' });
    writeAtom({ file: 'b.md', id: 'atom-apart', body: 'adr work covers 018 somewhere else' });
    buildFts5Index({ atomsDir, indexPath });
  };

  it('scores additively: an atom holding the terms APART still matches', async () => {
    writePair();

    const result = await port().retrieve('adr-018', { k: 5, adjacency: true });

    expect(result.atoms.map(atom => atom.id).sort()).toEqual(['atom-adjacent', 'atom-apart']);
  });

  it('ranks the atom carrying the phrase first, the point of the extra disjunct', async () => {
    writePair();

    const result = await port().retrieve('adr-018', { k: 5, adjacency: true });

    expect(result.atoms[0]?.id).toBe('atom-adjacent');
  });

  it('leaves the ranking of adjacency-off untouched', async () => {
    writePair();

    const result = await port().retrieve('adr-018', { k: 5, adjacency: false });

    expect(result.atoms.map(atom => atom.id)).toEqual(['atom-adjacent']);
  });
});
