import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lanceDbAvailability } from '../src/adapters/lanceDbAdapter.js';
import { miniSearchAvailability } from '../src/adapters/miniSearchAdapter.js';
import { mapSequential } from '../src/bench/sequential.js';
import { runCli } from '../src/cli/cli.js';

/** Both section bodies clear `ATOM_MIN_CHARS`, so the doc stays two atoms. */
const DOC = [
  '# Layered Test Model',
  '',
  'intro text about retrieval and the layered test model',
  '',
  '## Unit tier',
  '',
  'fast retrieval tests over the unit tier corpus atoms',
  '',
].join('\n');

interface Fixture {
  readonly repoRoot: string;
  readonly source: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-cli-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  const source = join(corpus, 'TS-TESTING.md');
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
  '--atoms-dir',
  fixture.atomsDir,
  '--repo-root',
  fixture.repoRoot,
];

/** Distinct per adapter so one adapter's build cannot clobber another's index. */
const indexPathFor = (fixture: Fixture, adapter: string): string =>
  join(fixture.repoRoot, 'index', `atoms-${adapter}`);

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
  indexPathFor(fixture, adapter),
  '--json',
];

const indexArgv = (fixture: Fixture, adapter: string): readonly string[] => [
  'index',
  '--adapter',
  adapter,
  '--atoms-dir',
  fixture.atomsDir,
  '--index-path',
  indexPathFor(fixture, adapter),
  '--json',
];

/**
 * The adapters whose optional dependency actually loaded here. An absent one is
 * SKIPPED rather than failed: the parity property is about the adapters that can
 * run, and a missing optional package is not a contract violation.
 */
const availableAdapters = async (): Promise<readonly string[]> => {
  const probes = [
    ['minisearch', (await miniSearchAvailability()).available] as const,
    ['lancedb', (await lanceDbAvailability()).available] as const,
  ];
  return ['linear', 'fts5', ...probes.filter(([, ok]) => ok).map(([name]) => name)];
};

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
  /**
   * The fixture repo carries a `doc/` tree alone, so the scope is narrowed to it
   * here — the real default also names `claude-artifacts` and `RUNNER-*.md`, and
   * a root matching nothing is a refusal by design.
   */
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('ingest', () => {
    it('writes atoms from a fixture source and exits 0', async () => {
      const fixture = await makeFixture();

      const result = await runCli(ingestArgv(fixture));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('2');
      expect(result.stderr).toBe('');
    });

    /**
     * The refusal needs a file the corpus scope REACHES but the domain table
     * does not claim, so the scope is widened here through the documented
     * override — which also pins that the override is honoured end-to-end.
     */
    it('exits 3 and names each skip reason when a source is refused', async () => {
      const fixture = await makeFixture();
      const notes = join(fixture.repoRoot, 'notes');
      await mkdir(notes, { recursive: true });
      await writeFile(join(notes, 'stray.md'), DOC, 'utf8');
      vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc,notes');

      const result = await runCli([
        'ingest',
        '--atoms-dir',
        fixture.atomsDir,
        '--repo-root',
        fixture.repoRoot,
        '--json',
      ]);
      vi.unstubAllEnvs();

      expect(result.exitCode).toBe(3);
      const data = parseJson(result.stdout);
      expect(data['written']).toBe(2);
      const skipped = data['skipped'] as readonly Record<string, unknown>[];
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.['source']).toBe('notes/stray.md');
      expect(String((skipped[0]?.['reasons'] as readonly string[])[0])).toContain(
        'outside every declared ingest root'
      );
    });

    it('exits 2 naming the correction when a source path is passed', async () => {
      const result = await runCli(['ingest', 'doc/some-file.md']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('takes no source path');
      expect(result.stderr).toContain('DP_GNOSIS_CORPUS_ROOTS');
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

    // AC delta: `minisearch` and `lancedb` are now VALID adapters, so the
    // unknown-adapter probe uses a name outside the vocabulary and the message
    // must name all four members of it.
    it('rejects an unknown adapter with exit 2 and names the valid adapters', async () => {
      const result = await runCli(['retrieve', 'x', '--adapter', 'elasticsearch']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('elasticsearch');
      expect(result.stderr).toContain('linear');
      expect(result.stderr).toContain('fts5');
      expect(result.stderr).toContain('minisearch');
      expect(result.stderr).toContain('lancedb');
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

    it('names every valid adapter in --help so the set is discoverable', async () => {
      const result = await runCli(['--help']);

      expect(result.stdout).toContain('linear');
      expect(result.stdout).toContain('fts5');
      expect(result.stdout).toContain('minisearch');
      expect(result.stdout).toContain('lancedb');
    });
  });

  // Adapter parity. Ranking ORDER and score VALUES legitimately differ between a
  // linear BM25 scan and SQLite FTS5, and `mode` / `indexState` are by
  // construction adapter-specific ('lexical:bm25-linear'/'ready' vs
  // 'fts5'/'ready'). So this asserts the OUTPUT CONTRACT — key set plus the
  // typeof of every value, at the envelope and at one atom — and asserts
  // `mode`/`indexState` only as "present and well-typed", never as equal.
  describe('adapter parity', () => {
    const retrieveThrough = async (
      fixture: Fixture,
      adapter: string
    ): Promise<Record<string, unknown>> => {
      const built = await runCli(indexArgv(fixture, adapter));
      expect(built.exitCode).toBe(0);
      const result = await runCli(retrieveArgv(fixture, adapter));
      expect(result.exitCode).toBe(0);
      return parseJson(result.stdout);
    };

    it('emits an identically shaped retrieve payload through every available adapter', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));
      const adapters = await availableAdapters();
      expect(adapters).toContain('linear');
      expect(adapters).toContain('fts5');

      const payloads = await mapSequential(adapters, adapter =>
        retrieveThrough(fixture, adapter)
      );

      const baseline = payloads[0] as Record<string, unknown>;
      payloads.forEach(data => {
        expect(shapeOf(data)).toEqual(shapeOf(baseline));
        expect(shapeOf(firstAtom(data))).toEqual(shapeOf(firstAtom(baseline)));
        expect(data['mode']).toBeTypeOf('string');
        expect(String(data['indexState']).length).toBeGreaterThan(0);
      });
    });
  });
});
