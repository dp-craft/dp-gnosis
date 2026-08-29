import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';

/** The one section ingest keeps. Its body clears the atom floor on its own. */
const KEPT = [
  '# Layered Test Model',
  '',
  'intro text about retrieval and the layered test model, describing how each tier is retrieved and scored, and why an intro section carries enough prose of its own to stand as a separate atom of the whole corpus',
  '',
].join('\n');

/**
 * A section whose whole body is a comment: it clears the atom floor as raw text
 * and is EMPTY once the comment is stripped, so ingest writes the section above
 * and REFUSES this one — the exit-3 partial state the rule under test is about.
 */
const SKIPPED = [
  '## Comment tier',
  '',
  '<!-- a comment long enough on its own to clear the atom floor, carrying enough characters of raw body that the chunker keeps this section as its own atom before ingest strips the comment away entirely -->',
  '',
].join('\n');

const DOC = `${KEPT}${SKIPPED}`;

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-update-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), DOC, 'utf8');
  return {
    repoRoot,
    atomsDir: join(repoRoot, 'atoms'),
    indexPath: join(repoRoot, 'index', 'atoms-fts5.db'),
  };
};

const updateArgv = (fixture: Fixture, extra: readonly string[] = []): readonly string[] => [
  'update',
  '--repo-root',
  fixture.repoRoot,
  '--atoms-dir',
  fixture.atomsDir,
  '--index-path',
  fixture.indexPath,
  '--json',
  ...extra,
];

/**
 * The `--json` payload, read through PROPERTY ACCESS rather than string keys —
 * `ingestBlastRadius.test.ts` scans this suite for the bare command literal, and
 * a JSON key that merely spells it would read as an unpinned ingest call site.
 */
interface UpdatePayload {
  readonly command: string;
  readonly ingest: Record<string, unknown>;
  readonly index: Record<string, unknown> | null;
}

const parse = (stdout: string): UpdatePayload => {
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== 'object' || value === null) throw new Error(`not an object: ${stdout}`);
  return value as UpdatePayload;
};

describe('update — ingest then index, as one command', () => {
  /** The fixture carries ONE corpus root; the shipped default names several this tree has not. */
  beforeEach(() => vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc'));

  it('exits 3 when ingest skipped a file and index then succeeded, and reports BOTH hops', async () => {
    const fixture = await makeFixture();
    const result = await runCli(updateArgv(fixture));

    expect(result.exitCode).toBe(3);
    const payload = parse(result.stdout);
    expect(payload.command).toBe('update');
    expect(payload.ingest.skipped).toHaveLength(1);
    expect(payload.ingest.written).toBe(1);
    expect(payload.index?.built).toBe(true);
    expect(payload.index?.indexPath).toBe(fixture.indexPath);
  });

  it('renders both hops in order in the human text', async () => {
    const fixture = await makeFixture();
    const result = await runCli(updateArgv(fixture).filter(arg => arg !== '--json'));

    expect(result.exitCode).toBe(3);
    expect(result.stdout.indexOf('ingest:')).toBeGreaterThanOrEqual(0);
    expect(result.stdout.indexOf('ingest:')).toBeLessThan(result.stdout.indexOf(fixture.indexPath));
  });

  it('exits 0 when ingest refused nothing', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.repoRoot, 'doc', 'TS-TESTING.md'), KEPT, 'utf8');
    const result = await runCli(updateArgv(fixture));

    expect(result.exitCode).toBe(0);
    expect(parse(result.stdout).ingest.skipped).toHaveLength(0);
  });

  it('does NOT run index when ingest refused the invocation with a usage error', async () => {
    const fixture = await makeFixture();
    const result = await runCli(updateArgv(fixture, ['some/path.md']));

    expect(result.exitCode).toBe(2);
    const payload = parse(result.stdout);
    expect(payload.command).toBe('update');
    expect(payload.index).toBeNull();
    expect(String(payload.ingest.error)).toContain('ingest takes no source path');
  });

  it('honours the flags of BOTH hops rather than refusing one side as misplaced', async () => {
    const fixture = await makeFixture();
    const result = await runCli(
      updateArgv(fixture, ['--gold-ids', join(fixture.repoRoot, 'absent-gold'), '--body-source', 'atom'])
    );

    expect(result.exitCode).not.toBe(2);
  });
});
