/**
 * `retrieve` must state WHERE an atom came from, not only where the atom file
 * itself sits. `sourcePath` is the atom's own file under the atoms dir;
 * `originPaths` is the source document ingest cut it out of. Without the second
 * one a caller can quote an atom but cannot open the document that proves it.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';

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

/** The repo-relative document path ingest records in every atom's `sources`. */
const ORIGIN = 'doc/TS-TESTING.md';

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-origin-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), DOC, 'utf8');
  return { repoRoot, atomsDir: join(repoRoot, 'atoms') };
};

const indexPathFor = (fixture: Fixture, adapter: string): string =>
  join(fixture.repoRoot, 'index', `atoms-${adapter}`);

const retrieveArgv = (
  fixture: Fixture,
  adapter: string,
  format: readonly string[]
): readonly string[] => [
  'retrieve',
  'retrieval',
  '-k',
  '2',
  '--adapter',
  adapter,
  '--atoms-dir',
  fixture.atomsDir,
  '--index-path',
  indexPathFor(fixture, adapter),
  '--repo-root',
  fixture.repoRoot,
  ...format,
];

const ingested = async (adapter: string): Promise<Fixture> => {
  const fixture = await makeFixture();
  await runCli(['ingest', '--atoms-dir', fixture.atomsDir, '--repo-root', fixture.repoRoot]);
  await runCli([
    'index',
    '--adapter',
    adapter,
    '--atoms-dir',
    fixture.atomsDir,
    '--index-path',
    indexPathFor(fixture, adapter),
  ]);
  return fixture;
};

const firstAtom = (stdout: string): Record<string, unknown> => {
  const data = JSON.parse(stdout) as Record<string, unknown>;
  const atoms = data['atoms'] as readonly Record<string, unknown>[];
  expect(atoms.length).toBeGreaterThan(0);
  return atoms[0] as Record<string, unknown>;
};

describe('retrieve origin paths', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each(['linear', 'fts5'])('%s adapter', adapter => {
    it('reports the origin document as a list beside the atom path', async () => {
      const fixture = await ingested(adapter);

      const result = await runCli(retrieveArgv(fixture, adapter, ['--json']));

      const atom = firstAtom(result.stdout);
      expect(atom['originPaths']).toEqual([ORIGIN]);
      expect(String(atom['sourcePath'])).toContain('atoms');
    });
  });

  it('names the origin document in the text rendering', async () => {
    const fixture = await ingested('linear');

    const result = await runCli(retrieveArgv(fixture, 'linear', []));

    expect(result.stdout).toContain(`origin  ${ORIGIN}`);
  });

  it('adds an origin element per origin without disturbing <source>', async () => {
    const fixture = await ingested('linear');

    const result = await runCli(retrieveArgv(fixture, 'linear', ['--format', 'xml']));

    expect(result.stdout).toContain(`<origin>${ORIGIN}</origin>`);
    expect(result.stdout).toContain('<source>atoms/');
  });
});
