import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';

const DOC = '# Layered Test Model\n\nintro text about retrieval\n\n## Unit tier\n\nfast retrieval tests\n';

interface Fixture {
  readonly repoRoot: string;
  readonly source: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-cli-'));
  const standards = join(repoRoot, 'claude-artifacts', 'standards');
  await mkdir(standards, { recursive: true });
  const source = join(standards, 'TS-TESTING.md');
  await writeFile(source, DOC, 'utf8');
  return {
    repoRoot,
    source,
    atomsDir: join(repoRoot, 'atoms'),
    indexPath: join(repoRoot, 'index', 'atoms.db'),
  };
};

const ingestArgv = (fixture: Fixture): readonly string[] => [
  'ingest',
  fixture.source,
  '--atoms-dir',
  fixture.atomsDir,
  '--repo-root',
  fixture.repoRoot,
];

const retrieveArgv = (fixture: Fixture, adapter: string): readonly string[] => [
  'retrieve',
  'retrieval',
  '-k',
  '3',
  '--adapter',
  adapter,
  '--atoms-dir',
  fixture.atomsDir,
  '--index-path',
  fixture.indexPath,
  '--json',
];

const parseJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

/** typeof map of an object's own keys — the unit the parity test compares. */
const shapeOf = (value: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.keys(value).sort().map(key => [key, typeof value[key]]));

const firstAtom = (data: Record<string, unknown>): Record<string, unknown> => {
  const atoms = data['atoms'] as readonly Record<string, unknown>[];
  expect(atoms.length).toBeGreaterThan(0);
  return atoms[0] as Record<string, unknown>;
};

describe('runCli', () => {
  describe('ingest', () => {
    it('writes atoms from a fixture source and exits 0', async () => {
      const fixture = await makeFixture();

      const result = await runCli(ingestArgv(fixture));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('2');
      expect(result.stderr).toBe('');
    });

    it('exits 3 and names each skip reason when a source is refused', async () => {
      const fixture = await makeFixture();
      const stray = join(fixture.repoRoot, 'notes.md');
      await writeFile(stray, DOC, 'utf8');

      const result = await runCli([
        'ingest',
        fixture.source,
        stray,
        '--atoms-dir',
        fixture.atomsDir,
        '--repo-root',
        fixture.repoRoot,
        '--json',
      ]);

      expect(result.exitCode).toBe(3);
      const data = parseJson(result.stdout);
      expect(data['written']).toBe(2);
      const skipped = data['skipped'] as readonly Record<string, unknown>[];
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.['source']).toBe('notes.md');
      expect(String((skipped[0]?.['reasons'] as readonly string[])[0])).toContain(
        'outside every declared ingest root'
      );
    });

    it('exits 2 naming the correction when no source path is given', async () => {
      const result = await runCli(['ingest']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('at least one source path');
      expect(result.stdout).toBe('');
    });
  });

  describe('index', () => {
    it('exits 0 as a stated no-op for the linear adapter', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli([
        'index',
        '--adapter',
        'linear',
        '--atoms-dir',
        fixture.atomsDir,
        '--json',
      ]);

      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);
      expect(data['built']).toBe(false);
      expect(data['indexPath']).toBeNull();
      expect(String(data['note'])).toContain('no persistent index');
    });

    it('builds the fts5 index and reports its path', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli([
        'index',
        '--adapter',
        'fts5',
        '--atoms-dir',
        fixture.atomsDir,
        '--index-path',
        fixture.indexPath,
        '--json',
      ]);

      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);
      expect(data['built']).toBe(true);
      expect(data['indexPath']).toBe(fixture.indexPath);
    });
  });

  describe('retrieve', () => {
    it('ranks atoms and reports mode plus indexState', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli(retrieveArgv(fixture, 'linear'));

      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);
      expect(data['command']).toBe('retrieve');
      expect(data['query']).toBe('retrieval');
      expect(data['k']).toBe(3);
      expect(data['indexState']).toBe('ready');
      expect(data['count']).toBeGreaterThan(0);
      expect(firstAtom(data)['id']).toBeTypeOf('string');
    });

    it('prints ranked ids in human mode', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli([
        'retrieve',
        'retrieval',
        '--atoms-dir',
        fixture.atomsDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ts-testing-layered-test-model');
    });

    it('exits 2 naming the correction for a non-numeric -k', async () => {
      const fixture = await makeFixture();

      const result = await runCli([
        'retrieve',
        'retrieval',
        '-k',
        'many',
        '--atoms-dir',
        fixture.atomsDir,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('-k');
      expect(result.stderr).toContain('positive integer');
    });

    it('reports indexState unavailable rather than an empty result when no index exists', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli(retrieveArgv(fixture, 'fts5'));

      expect(result.exitCode).toBe(3);
      expect(parseJson(result.stdout)['indexState']).toBe('unavailable');
    });

    it('exits 3 naming the correction when the corpus directory does not exist', async () => {
      const fixture = await makeFixture();

      const result = await runCli([
        'retrieve',
        'retrieval',
        '--atoms-dir',
        fixture.atomsDir,
      ]);

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toContain('unavailable');
      expect(result.stdout).toContain('gnosis ingest');
    });

    it('keeps indexState machine-readable in --json when the corpus is missing', async () => {
      const fixture = await makeFixture();

      const result = await runCli(retrieveArgv(fixture, 'linear'));

      expect(result.exitCode).toBe(3);
      const data = parseJson(result.stdout);
      expect(data['indexState']).toBe('unavailable');
      expect(data['count']).toBe(0);
      expect(data['exitCode']).toBe(3);
    });
  });

  describe('usage errors', () => {
    it('rejects an unknown flag with exit 2 and names the valid flags', async () => {
      const result = await runCli(['retrieve', 'x', '--jsn']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--jsn');
      expect(result.stderr).toContain('--json');
      expect(result.stderr).toContain('--adapter');
      expect(result.stdout).toBe('');
    });

    it('rejects an unknown adapter with exit 2 and names the valid adapters', async () => {
      const result = await runCli(['retrieve', 'x', '--adapter', 'lancedb']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('lancedb');
      expect(result.stderr).toContain('linear');
      expect(result.stderr).toContain('fts5');
    });

    it('rejects an unknown subcommand with exit 2 and names the valid ones', async () => {
      const result = await runCli(['serach', 'x']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('serach');
      expect(result.stderr).toContain('retrieve');
    });

    it('rejects a value flag given no value', async () => {
      const result = await runCli(['retrieve', 'x', '--adapter']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--adapter');
      expect(result.stderr).toContain('value');
    });

    it('documents the exit codes in --help and exits 0', async () => {
      const result = await runCli(['--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('exit 0');
      expect(result.stdout).toContain('exit 2');
      expect(result.stdout).toContain('exit 3');
      expect(result.stdout).toContain('ingest');
      expect(result.stdout).toContain('index');
      expect(result.stdout).toContain('retrieve');
    });
  });

  // Adapter parity. Ranking ORDER and score VALUES legitimately differ between a
  // linear BM25 scan and SQLite FTS5, and `mode` / `indexState` are by
  // construction adapter-specific ('lexical:bm25-linear'/'ready' vs
  // 'fts5'/'ready'). So this asserts the OUTPUT CONTRACT — key set plus the
  // typeof of every value, at the envelope and at one atom — and asserts
  // `mode`/`indexState` only as "present and well-typed", never as equal.
  describe('adapter parity', () => {
    it('emits an identically shaped retrieve payload through both adapters', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));
      await runCli([
        'index',
        '--adapter',
        'fts5',
        '--atoms-dir',
        fixture.atomsDir,
        '--index-path',
        fixture.indexPath,
      ]);

      const linear = await runCli(retrieveArgv(fixture, 'linear'));
      const fts5 = await runCli(retrieveArgv(fixture, 'fts5'));

      expect(linear.exitCode).toBe(fts5.exitCode);
      expect(fts5.exitCode).toBe(0);
      const linearData = parseJson(linear.stdout);
      const fts5Data = parseJson(fts5.stdout);
      expect(shapeOf(fts5Data)).toEqual(shapeOf(linearData));
      expect(shapeOf(firstAtom(fts5Data))).toEqual(shapeOf(firstAtom(linearData)));
      expect(linearData['mode']).toBeTypeOf('string');
      expect(fts5Data['mode']).toBeTypeOf('string');
      expect(String(linearData['indexState']).length).toBeGreaterThan(0);
      expect(String(fts5Data['indexState']).length).toBeGreaterThan(0);
    });
  });
});
