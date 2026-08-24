/**
 * The `--prf` flag surface: what it refuses, and what `--no-prf` restores. The
 * MODEL is pinned in `prf.test.ts`, the RESCORE in `fts5Adapter.test.ts` and
 * the PROFILE default's provenance in `prfProfileDefault.test.ts`; this file
 * owns argv alone.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

const LABELS = ['Alpha', 'Bravo', 'Delta'] as const;

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-prf-cli-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await Promise.all(
    LABELS.map(label =>
      writeFile(
        join(corpus, `${label}.md`),
        `# Zestful Retrieval ${label}\n\nzestful retrieval selector stability memo render ${label}\n`,
        'utf8'
      )
    )
  );
  const atomsDir = join(repoRoot, 'atoms');
  const indexPath = join(repoRoot, 'index', 'atoms.db');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  await runCli(['index', '--atoms-dir', atomsDir, '--index-path', indexPath, '--adapter', 'fts5']);
  return { repoRoot, atomsDir, indexPath };
};

let fixture: Fixture = { repoRoot: '', atomsDir: '', indexPath: '' };

const retrieve = async (extra: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  await runCli([
    'retrieve',
    'zestful retrieval',
    '--atoms-dir',
    fixture.atomsDir,
    '--index-path',
    fixture.indexPath,
    '--repo-root',
    fixture.repoRoot,
    '--json',
    ...extra,
  ]);

/** `--json` renders a refusal to stdout; text mode renders it to stderr. */
const message = (result: { readonly stdout: string; readonly stderr: string }): string =>
  `${result.stdout}${result.stderr}`;

beforeAll(async () => {
  vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  fixture = await makeFixture();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('--prf', () => {
  it('runs the SHIPPED profile default when argv states nothing', async () => {
    const served = await retrieve([]);

    expect(served.exitCode).toBe(0);
    expect(JSON.parse(served.stdout).count).toBeGreaterThan(0);
  });

  it('--no-prf turns that profile default OFF and still delivers a ranking', async () => {
    const plain = await retrieve(['--no-prf']);

    expect(plain.exitCode).toBe(0);
    expect(JSON.parse(plain.stdout).count).toBeGreaterThan(0);
  });

  it('refuses --prf and --no-prf together rather than picking a winner', async () => {
    const refused = await retrieve(['--prf', '--no-prf']);

    expect(refused.exitCode).toBe(2);
    expect(message(refused)).toContain('--no-prf');
  });

  it('runs on fts5 and still delivers a ranking', async () => {
    const expanded = await retrieve(['--prf']);

    expect(expanded.exitCode).toBe(0);
    expect(JSON.parse(expanded.stdout).count).toBeGreaterThan(0);
  });

  it('REFUSES loudly on an adapter that cannot carry the rescore', async () => {
    const refused = await retrieve(['--adapter', 'linear', '--prf']);

    expect(refused.exitCode).toBe(2);
    expect(message(refused)).toContain('--prf');
    expect(message(refused)).toContain('linear');
  });

  it.each(['--prf-docs', '--prf-terms', '--prf-alpha'])(
    'refuses %s when no feedback pass runs rather than ignoring it',
    async flag => {
      const refused = await retrieve(['--no-prf', flag, '1']);

      expect(refused.exitCode).toBe(2);
      expect(message(refused)).toContain(flag);
    }
  );

  it.each([
    ['--prf-docs', '0'],
    ['--prf-terms', '-3'],
    ['--prf-docs', 'two'],
  ])('refuses %s %s — a count must be a positive integer', async (flag, raw) => {
    const refused = await retrieve(['--prf', flag, raw]);

    expect(refused.exitCode).toBe(2);
    expect(message(refused)).toContain(flag);
  });

  it.each(['2', '-0.1', 'half'])('refuses --prf-alpha %s rather than clamping it', async raw => {
    const refused = await retrieve(['--prf', '--prf-alpha', raw]);

    expect(refused.exitCode).toBe(2);
    expect(message(refused)).toContain('never clamped');
  });

  it('accepts the tuning flags beside --prf', async () => {
    const tuned = await retrieve(['--prf', '--prf-docs', '3', '--prf-terms', '5', '--prf-alpha', '0.3']);

    expect(tuned.exitCode).toBe(0);
  });

  it('accepts a tuning flag on the PROFILE default, with no --prf beside it', async () => {
    const tuned = await retrieve(['--prf-terms', '5']);

    expect(tuned.exitCode).toBe(0);
  });

  it('REPORTS the resolved cell it expanded under, and where it came from', async () => {
    const served = await retrieve([]);
    const tuned = await retrieve(['--prf', '--prf-terms', '5']);

    expect(JSON.parse(served.stdout).prf).toEqual({
      fbDocs: 10,
      fbTerms: 40,
      alpha: 0.5,
      source: 'profile',
    });
    expect(JSON.parse(tuned.stdout).prf).toEqual({
      fbDocs: 10,
      fbTerms: 5,
      alpha: 0.5,
      source: 'flag',
    });
  });

  it('OMITS the field entirely when nothing expanded — presence is the signal', async () => {
    const plain = await retrieve(['--no-prf']);
    const unexpanded = await retrieve(['--adapter', 'linear']);

    expect(Object.keys(JSON.parse(plain.stdout))).not.toContain('prf');
    expect(Object.keys(JSON.parse(unexpanded.stdout))).not.toContain('prf');
  });

  it('states the same cell on the human-readable rendering', async () => {
    const served = await runCli([
      'retrieve',
      'zestful retrieval',
      '--atoms-dir',
      fixture.atomsDir,
      '--index-path',
      fixture.indexPath,
      '--repo-root',
      fixture.repoRoot,
    ]);
    const plain = await runCli([
      'retrieve',
      'zestful retrieval',
      '--no-prf',
      '--atoms-dir',
      fixture.atomsDir,
      '--index-path',
      fixture.indexPath,
      '--repo-root',
      fixture.repoRoot,
    ]);

    expect(served.stdout).toContain('retrieve: prf');
    expect(served.stdout).toContain('fbTerms 40');
    expect(plain.stdout).not.toContain('retrieve: prf');
  });

  it('reports the same cell on `answer`, and omits it under --no-prf', async () => {
    const argv = (extra: readonly string[]): readonly string[] => [
      'answer',
      'zestful retrieval',
      '--atoms-dir',
      fixture.atomsDir,
      '--index-path',
      fixture.indexPath,
      '--repo-root',
      fixture.repoRoot,
      '--json',
      ...extra,
    ];

    const served = JSON.parse((await runCli(argv([]))).stdout);
    const plain = JSON.parse((await runCli(argv(['--no-prf']))).stdout);

    expect(served.prf).toEqual({ fbDocs: 10, fbTerms: 40, alpha: 0.5, source: 'profile' });
    expect(Object.keys(plain)).not.toContain('prf');
  });

  it('retrieves UNEXPANDED on another adapter under the profile default, and says so', async () => {
    const unexpanded = await retrieve(['--adapter', 'linear']);

    expect(unexpanded.exitCode).toBe(0);
    expect(JSON.parse(unexpanded.stdout).note).toContain('UNEXPANDED');
  });
});
