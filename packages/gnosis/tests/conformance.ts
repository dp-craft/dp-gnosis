/**
 * ONE body of tests, run against EVERY real adapter.
 *
 * The point is comparability: `--adapter` may later change ranking and speed,
 * and nothing else. A behaviour asserted for one adapter and not the other is
 * exactly how an adapter switch starts changing what a prompt can see, so the
 * cases live here — parameterized — rather than being copied per adapter.
 *
 * Fixtures are built in temp directories with `serializeAtom`, never hand-rolled
 * strings: a hand-written fixture drifts from the real atom grammar the moment
 * the grammar changes, and then the suite asserts against a format nobody ships.
 * The real `benchmark-data/vault/atoms/` vault is NEVER touched.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildFts5Index, createFts5Adapter } from '../src/adapters/fts5Adapter.js';
import { createLinearScanAdapter } from '../src/adapters/linearScanAdapter.js';
import type { AtomFrontmatter, AtomStatus } from '../src/atom.js';
import { serializeAtom } from '../src/atom.js';
import { REPO_ROOT } from '../src/paths.js';
import type { KnowledgePort, RetrievedAtom } from '../src/port.js';

const execFileAsync = promisify(execFile);

/** Builds a ready-to-query port over a fixture atoms directory. */
export type AdapterFactory = (atomsDir: string) => Promise<KnowledgePort>;

/** Index location derived from the atoms dir, so the child process agrees with the parent. */
export const indexPathFor = (atomsDir: string): string =>
  resolve(atomsDir, '..', 'index', 'atoms.db');

/**
 * The adapters under conformance, keyed by name. A NAME rather than a closure
 * because the process-boundary case has to rebuild the same adapter in a child
 * process, and a function cannot cross that boundary.
 */
export const createLinearScanPort: AdapterFactory = (atomsDir: string): Promise<KnowledgePort> =>
  Promise.resolve(createLinearScanAdapter(atomsDir));

/** The FTS5 port needs its index built first — that build IS part of "ready to query". */
export const createFts5Port: AdapterFactory = (atomsDir: string): Promise<KnowledgePort> => {
  const indexPath = indexPathFor(atomsDir);
  buildFts5Index({ atomsDir, indexPath });
  return Promise.resolve(createFts5Adapter({ atomsDir, indexPath, now: new Date() }));
};

export const CONFORMANCE_ADAPTERS: Readonly<Record<string, AdapterFactory | undefined>> = {
  'linear-scan': createLinearScanPort,
  fts5: createFts5Port,
};

/** One fixture atom, described at the level the cases care about. */
export interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly domain?: string;
  readonly status?: AtomStatus;
  readonly staleAfter?: string;
  readonly body: string;
}

const frontmatterOf = (spec: AtomSpec): AtomFrontmatter => ({
  type: 'knowledge',
  id: spec.id,
  title: `title of ${spec.id}`,
  x_domain: spec.domain ?? 'runner',
  status: spec.status ?? 'stable',
  ...(spec.staleAfter === undefined ? {} : { stale_after: spec.staleAfter }),
  sources: ['https://example.com/src'],
});

/** Real format by construction — the serializer, never a hand-rolled string. */
export const atomText = (spec: AtomSpec): string =>
  serializeAtom(frontmatterOf(spec), `${spec.body}\n`);

const roots: string[] = [];

const newRoot = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-conformance-'));
  roots.push(root);
  return root;
};

export const cleanupFixtures = (): void => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
};

const writeAtomTo = (dir: string, spec: AtomSpec): void => {
  writeFileSync(resolve(dir, spec.file), atomText(spec), 'utf8');
};

/** Write a corpus into a fresh temp atoms dir; returns that dir. */
export const makeCorpus = (specs: readonly AtomSpec[]): string => {
  const atomsDir = resolve(newRoot(), 'atoms');
  mkdirSync(atomsDir, { recursive: true });
  specs.forEach(spec => writeAtomTo(atomsDir, spec));
  return atomsDir;
};

/**
 * Push the whole corpus behind whatever index was just built, so a later edit is
 * unambiguously NEWER than the index. Without it, an mtime tie makes the
 * ranking-freshness case (10b) pass or fail on filesystem timestamp resolution.
 */
const settleCorpusBehind = (atomsDir: string, specs: readonly AtomSpec[]): void => {
  const when = new Date(Date.now() - 60_000);
  specs.forEach(spec => utimesSync(resolve(atomsDir, spec.file), when, when));
  utimesSync(atomsDir, when, when);
};

const idsOf = (atoms: readonly RetrievedAtom[]): readonly string[] => atoms.map(atom => atom.id);

const shapeOf = (atoms: readonly RetrievedAtom[]): readonly (readonly [string, number])[] =>
  atoms.map(atom => [atom.id, atom.score] as const);

const CHILD_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'conformanceChild.ts');

/**
 * Case 4, process-boundary axis: a REAL child `node --import tsx` run that builds
 * and queries the same fixture from scratch. In-process repetition only proves
 * same-process repeatability, which is not what byte-stability claims.
 */
const retrieveInChildProcess = async (
  adapterName: string,
  atomsDir: string,
  query: string
): Promise<readonly (readonly [string, number])[]> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', CHILD_SCRIPT, adapterName, atomsDir, query],
    { cwd: REPO_ROOT }
  );
  const parsed: unknown = JSON.parse(stdout);
  return Array.isArray(parsed) ? (parsed as readonly (readonly [string, number])[]) : [];
};

const TIE_SPECS: readonly AtomSpec[] = [
  { file: 'z-first.md', id: 'zzz-atom', body: 'identical tie body text' },
  { file: 'a-second.md', id: 'aaa-atom', body: 'identical tie body text' },
];

const RANKED_SPECS: readonly AtomSpec[] = [
  { file: 'a.md', id: 'atom-a', body: 'alpha beta gamma delta' },
  { file: 'b.md', id: 'atom-b', body: 'alpha beta gamma' },
  { file: 'c.md', id: 'atom-c', body: 'alpha beta' },
];

const RANKED_QUERY = 'alpha beta gamma delta';

/** A `mode` names legs, e.g. `fts5` or `lexical:bm25-linear` — one token, no prose. */
const MODE_RE = /^[a-z0-9]+(?:[:+-][a-z0-9]+)*$/;

/**
 * Run the 15 conformance cases against `createAdapter`. `adapterName` must be a
 * key of `CONFORMANCE_ADAPTERS` — the process-boundary case looks it up there.
 */
export const describeConformance = (adapterName: string, createAdapter: AdapterFactory): void => {
  const portFor = (specs: readonly AtomSpec[]): Promise<KnowledgePort> =>
    createAdapter(makeCorpus(specs));

  describe(`KnowledgePort conformance — ${adapterName}`, () => {
    afterEach(cleanupFixtures);

    // 1
    it('returns no atoms for an empty corpus without throwing', async () => {
      const result = await (await portFor([])).retrieve('alpha', { k: 5 });

      expect(result.atoms).toEqual([]);
    });

    // 2
    it('returns exactly k when more atoms match than k', async () => {
      const port = await portFor(RANKED_SPECS);

      const result = await port.retrieve(RANKED_QUERY, { k: 2 });

      expect(result.atoms).toHaveLength(2);
    });

    // 3
    it('returns fewer than k without padding when k exceeds the corpus', async () => {
      const port = await portFor(RANKED_SPECS);

      const result = await port.retrieve(RANKED_QUERY, { k: 99 });

      expect(result.atoms).toHaveLength(3);
    });

    // 4a
    it('is deterministic across repeated in-process calls', async () => {
      const port = await portFor(RANKED_SPECS);

      const first = await port.retrieve(RANKED_QUERY, { k: 5 });
      const second = await port.retrieve(RANKED_QUERY, { k: 5 });

      expect(shapeOf(second.atoms)).toEqual(shapeOf(first.atoms));
    });

    // 4b
    it('is deterministic across a process boundary', async () => {
      const atomsDir = makeCorpus(RANKED_SPECS);
      const port = await createAdapter(atomsDir);

      const inProcess = await port.retrieve(RANKED_QUERY, { k: 10 });
      const child = await retrieveInChildProcess(adapterName, atomsDir, RANKED_QUERY);

      expect(child).toEqual(shapeOf(inProcess.atoms).map(([id, score]) => [id, score]));
    });

    // 4c
    it('is deterministic when the same corpus is written in a shuffled order', async () => {
      const first = await (await portFor(RANKED_SPECS)).retrieve(RANKED_QUERY, { k: 5 });

      const shuffled = await portFor([...RANKED_SPECS].reverse());
      const second = await shuffled.retrieve(RANKED_QUERY, { k: 5 });

      expect(shapeOf(second.atoms)).toEqual(shapeOf(first.atoms));
    });

    // 4d
    it('is deterministic on a deliberate tie between two identically-worded atoms', async () => {
      const port = await portFor(TIE_SPECS);

      const first = await port.retrieve('identical tie body', { k: 5 });
      const second = await port.retrieve('identical tie body', { k: 5 });

      expect(idsOf(first.atoms)).toEqual(['aaa-atom', 'zzz-atom']);
      expect(shapeOf(second.atoms)).toEqual(shapeOf(first.atoms));
    });

    // 5
    it('breaks an exact score tie by ascending atom id', async () => {
      const port = await portFor(TIE_SPECS);

      const result = await port.retrieve('identical tie body', { k: 5 });

      expect(idsOf(result.atoms)).toEqual(['aaa-atom', 'zzz-atom']);
    });

    // 6
    it('never returns a foreign-domain atom when a domain filter is set', async () => {
      const port = await portFor([
        { file: 'a.md', id: 'atom-a', domain: 'runner', body: 'shared token here' },
        { file: 'b.md', id: 'atom-b', domain: 'standards', body: 'shared token here' },
      ]);

      const result = await port.retrieve('shared token', { k: 5, domains: ['standards'] });

      expect(idsOf(result.atoms)).toEqual(['atom-b']);
    });

    // 7
    it('returns no atoms for a term absent from the corpus', async () => {
      const port = await portFor(RANKED_SPECS);

      const result = await port.retrieve('nonexistentterm', { k: 5 });

      expect(result.atoms).toEqual([]);
    });

    // 8
    it('matches a diacritic-folded term against its unfolded spelling', async () => {
      const port = await portFor([
        { file: 'a.md', id: 'atom-a', body: 'the café pattern is documented' },
      ]);

      const result = await port.retrieve('cafe', { k: 5 });

      expect(idsOf(result.atoms)).toEqual(['atom-a']);
    });

    // 9 — the ONE shared stemmer (`stemTerm`, `query.ts`), applied index-side
    // and query-side by every adapter. FTS5 keeps `unicode61` and stems its
    // text before insert rather than switching to the built-in `porter`
    // tokenizer: a second Porter implementation on one adapter only would turn
    // this suite's comparability guarantee into a comparison of tokenizers.
    it('matches an inflected query against a base-form document', async () => {
      const port = await portFor([
        { file: 'a.md', id: 'atom-a', body: 'the index is rebuilt wholesale' },
      ]);

      const result = await port.retrieve('indexing', { k: 5 });

      expect(idsOf(result.atoms)).toEqual(['atom-a']);
    });

    // 10a
    it('returns the edited body on the very next retrieval, with no reindex', async () => {
      const specs: readonly AtomSpec[] = [
        { file: 'a.md', id: 'atom-a', body: 'alpha beta original body' },
      ];
      const atomsDir = makeCorpus(specs);
      const port = await createAdapter(atomsDir);
      settleCorpusBehind(atomsDir, specs);
      writeAtomTo(atomsDir, { file: 'a.md', id: 'atom-a', body: 'alpha beta REWRITTEN BODY' });

      const result = await port.retrieve('alpha beta', { k: 5 });

      expect(result.atoms[0]?.body).toContain('REWRITTEN BODY');
    });

    // 10b — ranking MAY lag, but `indexState` MUST say so. Expressed as the
    // invariant rather than as a per-adapter constant: an adapter whose ranking
    // is current reports `ready`; one whose ranking lags reports `stale`.
    it('reports stale whenever its ranking lags the corpus, and ready when it does not', async () => {
      const specs: readonly AtomSpec[] = [{ file: 'a.md', id: 'atom-a', body: 'alpha beta' }];
      const atomsDir = makeCorpus(specs);
      const port = await createAdapter(atomsDir);
      settleCorpusBehind(atomsDir, specs);
      writeAtomTo(atomsDir, { file: 'a.md', id: 'atom-a', body: 'alpha beta freshterm' });

      const result = await port.retrieve('freshterm', { k: 5 });
      const rankingIsCurrent = idsOf(result.atoms).includes('atom-a');

      expect(result.indexState).toBe(rankingIsCurrent ? 'ready' : 'stale');
    });

    // 11
    it('skips a corrupt atom and a non-markdown file instead of throwing', async () => {
      const atomsDir = makeCorpus([{ file: 'good.md', id: 'atom-good', body: 'shared token here' }]);
      writeFileSync(resolve(atomsDir, 'broken.md'), 'no frontmatter shared token here', 'utf8');
      writeFileSync(resolve(atomsDir, 'notes.txt'), 'shared token here', 'utf8');
      const port = await createAdapter(atomsDir);

      const result = await port.retrieve('shared token', { k: 5 });

      expect(idsOf(result.atoms)).toEqual(['atom-good']);
    });

    // 12 — `mode` names which legs ran. Adapter-appropriate rather than one
    // hardcoded string: it must be non-empty, stable, and must not claim to be
    // the known-answer fake.
    it('reports a non-empty, stable, adapter-appropriate mode', async () => {
      const port = await portFor(RANKED_SPECS);

      const hit = await port.retrieve(RANKED_QUERY, { k: 5 });
      const miss = await port.retrieve('nonexistentterm', { k: 5 });

      expect(hit.mode.length).toBeGreaterThan(0);
      expect(hit.mode).not.toBe('fake');
      expect(hit.mode).toMatch(MODE_RE);
      expect(miss.mode).toBe(hit.mode);
    });

    // 13 — LOCATION, not filtering. The adapter is rooted at the atoms dir and
    // structurally cannot reach a sibling `proposals/`, so every returned
    // sourcePath must live under the atoms dir.
    it('cannot reach a sibling proposals directory', async () => {
      const atomsDir = makeCorpus([{ file: 'a.md', id: 'atom-a', body: 'shared token here' }]);
      const proposals = resolve(atomsDir, '..', 'proposals');
      mkdirSync(proposals, { recursive: true });
      writeAtomTo(proposals, { file: 'draft.md', id: 'atom-draft', body: 'shared token here' });
      const port = await createAdapter(atomsDir);

      const result = await port.retrieve('shared token', { k: 5 });

      expect(idsOf(result.atoms)).toEqual(['atom-a']);
      result.atoms.forEach(atom =>
        expect(resolve(atom.sourcePath).startsWith(resolve(atomsDir))).toBe(true)
      );
    });

    // 14
    it('never returns a deprecated atom', async () => {
      const port = await portFor([
        { file: 'a.md', id: 'atom-old', status: 'deprecated', body: 'shared token here' },
        { file: 'b.md', id: 'atom-live', body: 'shared token here' },
      ]);

      const result = await port.retrieve('shared token', { k: 5 });

      expect(idsOf(result.atoms)).toEqual(['atom-live']);
    });

    // 15
    it('never returns an atom whose stale_after is in the past', async () => {
      const port = await portFor([
        { file: 'a.md', id: 'atom-expired', staleAfter: '2000-01-01', body: 'shared token here' },
        { file: 'b.md', id: 'atom-fresh', staleAfter: '2999-12-31', body: 'shared token here' },
      ]);

      const result = await port.retrieve('shared token', { k: 5 });

      expect(idsOf(result.atoms)).toEqual(['atom-fresh']);
    });
  });
};
