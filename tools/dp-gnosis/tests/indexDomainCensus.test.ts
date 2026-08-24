import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { INDEX_EMPTY_REASON } from '../src/cli/indexCommand.js';

/**
 * A PARTIAL drop — one domain contributing zero rows — used to be invisible: the
 * gate compared two WHOLE-INDEX numbers, so a domain whose atoms all failed the
 * parser looked exactly like a domain nobody authored. The census reports both
 * sides per domain, and warns without moving the exit code.
 */

/** Frontmatter the parser REFUSES (no `id`), but which still declares its domain. */
const REJECTED_ADR = [
  '---',
  'type: knowledge',
  'x_domain: adr',
  'title: a decision record',
  '---',
  '# a decision record',
  '',
  'body prose',
  '',
].join('\n');

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
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-domain-census-'));
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

interface DomainRow {
  readonly domain: string;
  readonly files: number;
  readonly indexed: number;
}

const rowsOf = (data: Record<string, unknown>): readonly DomainRow[] =>
  data['domains'] as readonly DomainRow[];

const rowFor = (data: Record<string, unknown>, domain: string): DomainRow | undefined =>
  rowsOf(data).find(row => row.domain === domain);

const ingestInto = async (fixture: Fixture): Promise<void> => {
  const corpus = join(fixture.repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), DOC, 'utf8');
  await runCli(['ingest', '--atoms-dir', fixture.atomsDir, '--repo-root', fixture.repoRoot]);
};

describe('index reports what each domain contributed', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names a domain that went in and came out with nothing, WITHOUT moving the exit code', async () => {
    const fixture = await makeFixture();
    await ingestInto(fixture);
    await writeFile(join(fixture.atomsDir, 'rejected.md'), REJECTED_ADR, 'utf8');

    const result = await runCli([...indexArgv(fixture)]);

    expect(result.exitCode).toBe(0);
    const data = parseJson(result.stdout);
    expect(rowFor(data, 'adr')).toEqual({ domain: 'adr', files: 1, indexed: 0 });
    expect(rowFor(data, 'docs')?.indexed).toBeGreaterThan(0);
    expect(String(data['warning'])).toContain('adr');
  });

  it('lists a declared domain that contributed nothing at all, and warns about neither', async () => {
    const fixture = await makeFixture();
    await ingestInto(fixture);

    const result = await runCli([...indexArgv(fixture)]);

    expect(result.exitCode).toBe(0);
    const data = parseJson(result.stdout);
    expect(rowFor(data, 'runner')).toEqual({ domain: 'runner', files: 0, indexed: 0 });
    expect(data['warning']).toBeUndefined();
  });

  it('keeps the whole-index refusal exactly as it was, and carries the census with it', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.atomsDir, 'rejected.md'), REJECTED_ADR, 'utf8');

    const result = await runCli([...indexArgv(fixture)]);

    expect(result.exitCode).toBe(3);
    const data = parseJson(result.stdout);
    expect(data['reason']).toBe(INDEX_EMPTY_REASON);
    expect(String(data['note'])).toContain('1 .md file(s)');
    expect(rowFor(data, 'adr')).toEqual({ domain: 'adr', files: 1, indexed: 0 });
  });
});
