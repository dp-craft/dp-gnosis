import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { INDEX_EMPTY_REASON } from '../src/cli/indexCommand.js';

/**
 * The failure this gate exists for: atoms are on disk, the index is built, and
 * it holds NOTHING. Nothing throws on that path — every query simply answers
 * nothing — so the only place it can be caught is where both numbers are known.
 */

/** No frontmatter at all, so `parseAtom` refuses it and it reaches no index. */
const UNPARSEABLE = '# not an atom\n\nprose with no frontmatter block above it at all\n';

/** Both sections clear the minimum body length, so the doc ingests as atoms. */
const DOC = [
  '# Layered Test Model',
  '',
  'intro text about retrieval and the layered test model, describing how each tier is retrieved and scored, and why an intro section carries enough prose of its own to stand as a separate atom of the whole corpus',
  '',
].join('\n');

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-index-empty-'));
  const atomsDir = join(repoRoot, 'atoms');
  await mkdir(atomsDir, { recursive: true });
  return { repoRoot, atomsDir, indexPath: join(repoRoot, 'index', 'atoms.db') };
};

const indexArgv = (fixture: Fixture): readonly string[] => [
  'index',
  '--adapter',
  'fts5',
  '--atoms-dir',
  fixture.atomsDir,
  '--index-path',
  fixture.indexPath,
  '--json',
];

const parseJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

const ingestInto = async (fixture: Fixture): Promise<void> => {
  const corpus = join(fixture.repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), DOC, 'utf8');
  await runCli([
    'ingest',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
  ]);
};

describe('index over an atoms directory the build indexes nothing from', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exits 3 with reason index-empty and a note naming the file count', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.atomsDir, 'a.md'), UNPARSEABLE, 'utf8');
    await writeFile(join(fixture.atomsDir, 'b.md'), UNPARSEABLE, 'utf8');

    const result = await runCli([...indexArgv(fixture)]);

    expect(result.exitCode).toBe(3);
    const data = parseJson(result.stdout);
    expect(data['reason']).toBe(INDEX_EMPTY_REASON);
    expect(data['built']).toBe(true);
    expect(data['indexPath']).toBe(fixture.indexPath);
    expect(String(data['note'])).toContain('2 .md file(s)');
    expect(String(data['note'])).toContain('0 atoms indexed');
  });

  it('exits 0 with no reason when the same shape holds a real atom', async () => {
    const fixture = await makeFixture();
    await ingestInto(fixture);

    const result = await runCli([...indexArgv(fixture)]);

    expect(result.exitCode).toBe(0);
    const data = parseJson(result.stdout);
    expect(data['reason']).toBeUndefined();
    expect(data['built']).toBe(true);
  });

  it('exits 0 for an EMPTY atoms directory — an empty corpus is not this defect', async () => {
    const fixture = await makeFixture();

    const result = await runCli([...indexArgv(fixture)]);

    expect(result.exitCode).toBe(0);
    expect(parseJson(result.stdout)['reason']).toBeUndefined();
  });
});
