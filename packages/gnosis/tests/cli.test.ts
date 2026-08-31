import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lanceDbAvailability } from '../src/adapters/lanceDbAdapter.js';
import { miniSearchAvailability } from '../src/adapters/miniSearchAdapter.js';
import { mapSequential } from '../src/bench/sequential.js';
import { FLAGS } from '../src/cli/args.js';
import { internalFailure, runCli, SCOPED_FLAG_LISTS } from '../src/cli/cli.js';

/** Both section bodies clear `ATOM_MIN_CHARS`, so the doc stays two atoms. */
const DOC = [
  '# Layered Test Model',
  '',
  'intro text about retrieval and the layered test model, describing how each tier is retrieved and scored, and why an intro section carries enough prose of its own to stand as a separate atom of the whole corpus',
  '',
  '## Unit tier',
  '',
  'fast retrieval tests over the unit tier corpus atoms, exercising the unit tier of the layered test model with enough prose that this section stands alone as an atom instead of folding into the one just above it',
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
  'search',
  'retrieval',
  '-k',
  '3',
  '--adapter',
  adapter,
  // The PLAIN first pass on every adapter: the shipped profile serves a
  // feedback default that only `fts5` carries, and this argv compares adapters.
  '--no-prf',
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

/**
 * A second corpus root the shipped domain table maps to `standards`. Two
 * domains are the smallest fixture in which a domain filter can be proved to
 * SELECT — over a single-domain corpus an unfiltered run and a filtered one are
 * indistinguishable. The prose is distinct from {@link DOC} because ingest
 * dedupes by body hash, so a copy would be skipped rather than ingested.
 */
const STANDARDS_DOC = [
  '# Retrieval Standards',
  '',
  'standards prose about retrieval conventions and how a knowledge domain is labelled, carrying enough sentences of its own that this section stands alone as an atom of the corpus rather than folding into a neighbouring one',
  '',
].join('\n');

/** Widen the scope to both roots through the documented override. */
const withStandardsDoc = async (fixture: Fixture): Promise<void> => {
  const dir = join(fixture.repoRoot, 'claude-artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'STD.md'), STANDARDS_DOC, 'utf8');
  vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc,claude-artifacts');
};

/** Every delivered atom's domain, in delivery order. */
const domainsOf = (data: Record<string, unknown>): readonly string[] =>
  (data['atoms'] as readonly Record<string, unknown>[]).map(atom => String(atom['domain']));

const retrieveWide = (fixture: Fixture, extra: readonly string[]): readonly string[] => [
  'search',
  'retrieval',
  '-k',
  '6',
  '--adapter',
  'linear',
  '--atoms-dir',
  fixture.atomsDir,
  '--json',
  ...extra,
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
      // Pinned to a temp fixture: an unpinned `ingest` resolves its output to the
      // production ATOMS_DIR and prunes the real vault, so the refusal above must
      // not be the only thing standing between this suite and the corpus.
      const fixture = await makeFixture();
      const result = await runCli([...ingestArgv(fixture), 'doc/some-file.md']);

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

  describe('search', () => {
    it('ranks atoms and reports mode plus indexState', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli(retrieveArgv(fixture, 'linear'));

      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);
      expect(data['command']).toBe('search');
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
        'search',
        'retrieval',
        '--adapter',
        'linear',
        '--atoms-dir',
        fixture.atomsDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ts-testing-layered-test-model');
    });

    it('exits 2 naming the correction for a non-numeric -k', async () => {
      const fixture = await makeFixture();

      const result = await runCli([
        'search',
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

    it('filters to the comma-separated --type list', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const kept = await runCli([...retrieveArgv(fixture, 'linear'), '--type', 'adr,knowledge']);
      const dropped = await runCli([...retrieveArgv(fixture, 'linear'), '--type', 'adr']);

      expect(parseJson(kept.stdout)['count']).toBeGreaterThan(0);
      expect(parseJson(dropped.stdout)['count']).toBe(0);
    });

    it('treats a single --type value as a one-element list', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli([...retrieveArgv(fixture, 'linear'), '--type', 'knowledge']);

      expect(result.exitCode).toBe(0);
      expect(parseJson(result.stdout)['count']).toBeGreaterThan(0);
    });

    it('selects only atoms of the domain --domain names', async () => {
      const fixture = await makeFixture();
      await withStandardsDoc(fixture);
      await runCli(ingestArgv(fixture));

      const result = await runCli(retrieveWide(fixture, ['--domain', 'standards']));

      expect(result.exitCode).toBe(0);
      expect(domainsOf(parseJson(result.stdout))).toEqual(['standards']);
    });

    it('selects both domains of a comma-separated --domain list', async () => {
      const fixture = await makeFixture();
      await withStandardsDoc(fixture);
      await runCli(ingestArgv(fixture));

      const result = await runCli(retrieveWide(fixture, ['--domain', 'standards,docs']));

      expect(result.exitCode).toBe(0);
      expect([...new Set(domainsOf(parseJson(result.stdout)))].sort()).toEqual([
        'docs',
        'standards',
      ]);
    });

    /**
     * The budget SKIPS an atom it cannot fit and keeps going, and the skip is
     * reported — id, source path and estimated size — so the LLM reading the
     * output can load the file itself. A silent drop is the failure mode this
     * wiring exists to prevent.
     */
    it('skips an atom over --max-tokens and reports it with its source and size', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));

      const result = await runCli([...retrieveArgv(fixture, 'linear'), '--max-tokens', '1']);
      const data = parseJson(result.stdout);
      const skipped = data['skipped'] as readonly Record<string, unknown>[];

      expect(data['count']).toBe(0);
      expect(data['atoms']).toEqual([]);
      expect(skipped.length).toBeGreaterThan(0);
      expect(String(skipped[0]?.['sourcePath'])).toContain('atoms/');
      expect(skipped[0]?.['estimatedTokens']).toBeGreaterThan(1);
      expect(String(data['note'])).toContain('--max-tokens');
    });

    it('names the skipped atoms in the text and xml renderings too', async () => {
      const fixture = await makeFixture();
      await runCli(ingestArgv(fixture));
      const budgeted = ['--max-tokens', '1', '--repo-root', fixture.repoRoot];

      const text = await runCli([
        'search',
        'retrieval',
        '--adapter',
        'linear',
        '--atoms-dir',
        fixture.atomsDir,
        ...budgeted,
      ]);
      const xml = await runCli([
        'search',
        'retrieval',
        '--adapter',
        'linear',
        '--atoms-dir',
        fixture.atomsDir,
        '--format',
        'xml',
        ...budgeted,
      ]);

      expect(text.stdout).toContain('skipped');
      expect(text.stdout).toContain('ts-testing-layered-test-model');
      expect(xml.stdout).toContain('<skipped ');
      expect(xml.stdout).toContain('estimatedTokens=');
    });

    it('exits 2 naming the correction for a non-numeric --max-tokens', async () => {
      const fixture = await makeFixture();

      const result = await runCli([
        'search',
        'retrieval',
        '--max-tokens',
        'lots',
        '--atoms-dir',
        fixture.atomsDir,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--max-tokens');
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
        'search',
        'retrieval',
        '--adapter',
        'linear',
        '--atoms-dir',
        fixture.atomsDir,
      ]);

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toContain('unavailable');
      expect(result.stdout).toContain('npm run gnosis -- ingest');
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
    it('rejects a --type value outside the closed vocabulary, naming it and the vocabulary', async () => {
      const result = await runCli(['search', 'x', '--type', 'adr,nonsense']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('nonsense');
      expect(result.stderr).toContain('adr');
      expect(result.stdout).toBe('');
    });

    it('rejects an empty --type value rather than searching nothing', async () => {
      const result = await runCli(['search', 'x', '--type', '']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--type');
    });

    it('refuses --type outside retrieve the way an unknown flag is refused', async () => {
      const result = await runCli(['index', '--type', 'adr']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--type');
    });

    it('rejects a --domain value outside the vocabulary, naming it and the vocabulary', async () => {
      const result = await runCli(['search', 'x', '--domain', 'docs,nonsense']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('nonsense');
      expect(result.stderr).toContain('standards');
      expect(result.stdout).toBe('');
    });

    it('refuses --domain outside retrieve the way an unknown flag is refused', async () => {
      const result = await runCli(['index', '--domain', 'docs']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--domain');
    });

    it('refuses --budget-mode outside a retrieval command the way an unknown flag is refused', async () => {
      // Pinned to a temp fixture for the same reason as the source-path refusal
      // above: the guard under test MUST NOT be what keeps the real vault alive.
      const fixture = await makeFixture();
      const result = await runCli([...ingestArgv(fixture), '--budget-mode', 'tokens']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--budget-mode');
    });

    it('rejects an unknown flag with exit 2 and names the valid flags', async () => {
      const result = await runCli(['search', 'x', '--jsn']);

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
      const result = await runCli(['search', 'x', '--adapter', 'elasticsearch']);

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
      expect(result.stderr).toContain('search');
    });

    it('rejects a value flag given no value', async () => {
      const result = await runCli(['search', 'x', '--adapter']);

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
      expect(result.stdout).toContain('search');
    });

    it('names every valid adapter in --help so the set is discoverable', async () => {
      const result = await runCli(['--help']);

      expect(result.stdout).toContain('linear');
      expect(result.stdout).toContain('fts5');
      expect(result.stdout).toContain('minisearch');
      expect(result.stdout).toContain('lancedb');
    });
  });

  /**
   * `--version` prints ONE thing — the version this build really is — and exits
   * 0. The value is read from the package manifest at BOTH ends: hardcoding it
   * here would make the test agree with a stale constant on the first release
   * that bumps the manifest without touching the CLI.
   */
  describe('--version', () => {
    const MANIFEST_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

    const manifestVersion = (): string => {
      const parsed: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      return parsed !== null &&
        typeof parsed === 'object' &&
        'version' in parsed &&
        typeof parsed.version === 'string'
        ? parsed.version
        : '';
    };

    it('reads a real version off the manifest, so no assertion below passes vacuously', () => {
      expect(manifestVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('prints the manifest version alone and exits 0', async () => {
      const result = await runCli(['--version']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${manifestVersion()}\n`);
      expect(result.stderr).toBe('');
    });

    it('treats -v identically', async () => {
      expect(await runCli(['-v'])).toEqual(await runCli(['--version']));
    });

    it('prints the version, not the help text, when both flags are passed', async () => {
      const result = await runCli(['--version', '--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${manifestVersion()}\n`);
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

/**
 * Flag SCOPE, from the other side: a flag no command can honour MUST NOT exit
 * 0 with the token dropped. `doctor` stands in for every non-honouring command
 * because it reads nothing but the instance state, so a flag reaching it is
 * unambiguously ignored rather than quietly meaningful.
 */
describe('flag scope', () => {
  const REFUSED_ON_DOCTOR: readonly (readonly string[])[] = [
    ['--rerank-pool', '5'],
    ['--no-prf'],
    ['--golden-set', '/tmp/x.json'],
    ['-k', '9'],
  ];

  REFUSED_ON_DOCTOR.forEach(flag => {
    it(`refuses ${flag[0]} on doctor the way an unknown flag is refused`, async () => {
      const result = await runCli(['doctor', ...flag, '--json']);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('unknown flag');
      expect(result.stdout).toContain(flag[0]);
    });
  });

  it('keeps --golden-set on bench, which is the one command that reads it', async () => {
    const result = await runCli(['bench', '--golden-set', '/tmp/does-not-exist.json', '--json']);

    // It still refuses — the file is absent — but as a GOLDEN-SET refusal,
    // which is proof the flag reached the reader instead of the scope guard.
    expect(result.stdout).not.toContain('unknown flag');
    expect(result.stdout).toContain('/tmp/does-not-exist.json');
  });

  /**
   * The completeness gate: a flag added to `FLAGS` without a scope decision is
   * a silently-ignored token waiting to happen, so every key MUST be reachable
   * from exactly ONE positive scope list — or be declared global HERE, which
   * makes the omission a deliberate, reviewed line rather than an oversight.
   */
  const GLOBAL_FLAGS: readonly string[] = [
    '--adapter',
    '--atoms-dir',
    '--index-path',
    '--repo-root',
    '--profile',
    '--json',
    '--help',
    '-h',
    '--version',
    '-v',
  ];

  const scopeCount = (flag: string): number =>
    SCOPED_FLAG_LISTS.filter(list => list.includes(flag)).length;

  it('scopes every flag in FLAGS to exactly one command set, or declares it global', () => {
    Object.keys(FLAGS).forEach(flag => {
      expect(scopeCount(flag), `${flag} has no scope decision`).toBe(
        GLOBAL_FLAGS.includes(flag) ? 0 : 1
      );
    });
  });

  it('declares no global that a scope list also claims', () => {
    GLOBAL_FLAGS.forEach(flag => {
      expect(Object.keys(FLAGS), `${flag} is not a real flag`).toContain(flag);
    });
  });
});

describe('internalFailure', () => {
  it('maps an escaped Error to exit 1 with the message, not the stack, on stderr', () => {
    const result = internalFailure(new Error('index digest reader exploded'));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('index digest reader exploded\n');
    expect(result.stderr).not.toContain('at ');
  });

  it('stringifies a thrown value that is not an Error', () => {
    const result = internalFailure('plain string blew up');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('plain string blew up\n');
  });
});
