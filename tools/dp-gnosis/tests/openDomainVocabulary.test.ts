import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { activeProfile } from '../src/vocabulary.js';

/**
 * A domain NO shipped profile declares, and deliberately so: onboarding a new
 * knowledge domain must cost a profile file and nothing else. While the index
 * side re-checked `x_domain` against a TypeScript tuple, an atom carrying this
 * label was written by ingest and then dropped at index time — empty index,
 * zero results, no diagnostic anywhere.
 */
const FOREIGN_DOMAIN = 'hu-tax';

/** Long enough to clear the minimum body length, so the section becomes an atom. */
const taxDoc = (term: string): string =>
  `# ${term} handbook\n\nprose about ${term} written at enough length that this section stands on its own as an atom of the corpus rather than folding into a neighbour, carrying real sentences about the ${term} subject matter\n`;

interface Instance {
  readonly profilePath: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

/**
 * One instance owns BOTH its atoms dir and its index path: an atoms directory
 * is stamped with its owning profile, so sharing one across profiles destroys
 * the corpus rather than merging it.
 */
const makeInstance = async (): Promise<Instance> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-open-domain-'));
  const corpusRoot = `doc/${FOREIGN_DOMAIN}`;
  await mkdir(join(repoRoot, corpusRoot), { recursive: true });
  await writeFile(join(repoRoot, corpusRoot, 'AFA.md'), taxDoc('vatszabaly'), 'utf8');
  const atomsDir = join(repoRoot, FOREIGN_DOMAIN, 'atoms');
  const indexPath = join(repoRoot, FOREIGN_DOMAIN, 'index.db');
  const profilePath = join(repoRoot, `${FOREIGN_DOMAIN}.profile.json`);
  const profile = {
    ...activeProfile(),
    name: FOREIGN_DOMAIN,
    domains: [FOREIGN_DOMAIN],
    domainRules: [{ prefix: `${corpusRoot}/`, domain: FOREIGN_DOMAIN }],
    repoRoot,
    corpusRoots: [corpusRoot],
    atomsDir,
    indexPath,
  };
  await writeFile(profilePath, JSON.stringify(profile), 'utf8');
  return { profilePath, atomsDir, indexPath };
};

const jsonOf = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

interface AtomRow {
  readonly domain: string;
  readonly sourcePath: string;
}

const atomsOf = (payload: Record<string, unknown>): readonly AtomRow[] =>
  payload['atoms'] as readonly AtomRow[];

/** One retrieval against a named instance, with whatever extra flags a case adds. */
const retrieveFrom = (
  instance: Instance,
  extra: readonly string[]
): readonly string[] => [
  'retrieve',
  'vatszabaly',
  '--adapter',
  'fts5',
  '--profile',
  instance.profilePath,
  '--json',
  ...extra,
];

describe('a domain the shipped profile never declares', () => {
  it('ingests, indexes and retrieves from a profile file alone, with no TypeScript edit', async () => {
    const instance = await makeInstance();

    const ingested = jsonOf(
      (await runCli(['ingest', '--profile', instance.profilePath, '--json'])).stdout
    );
    expect(ingested['written']).toBeGreaterThan(0);

    await runCli(['index', '--adapter', 'fts5', '--profile', instance.profilePath, '--json']);
    const found = jsonOf(
      (
        await runCli([
          'retrieve',
          'vatszabaly',
          '--adapter',
          'fts5',
          '--profile',
          instance.profilePath,
          '--json',
        ])
      ).stdout
    );

    // The negative that used to hold: every atom was dropped at index time.
    expect(found['indexState']).not.toBe('empty');
    expect(found['indexState']).toBe('ready');
    expect(found['count']).toBeGreaterThan(0);
    expect(atomsOf(found).map(atom => atom.domain)).toContain(FOREIGN_DOMAIN);
  });
  /**
   * The vocabulary `--domain` is validated against MUST be the loaded profile's,
   * not the shipped tuple: an instance can only filter on the domains it
   * declares, and the shipped names are exactly the ones it must refuse.
   */
  it('accepts its own domain in --domain and exits 2 on a shipped one it never declared', async () => {
    const instance = await makeInstance();
    await runCli(['ingest', '--profile', instance.profilePath, '--json']);
    await runCli(['index', '--adapter', 'fts5', '--profile', instance.profilePath, '--json']);

    const own = await runCli(retrieveFrom(instance, ['--domain', FOREIGN_DOMAIN]));
    const foreign = await runCli(retrieveFrom(instance, ['--domain', 'docs']));

    expect(own.exitCode).toBe(0);
    expect(atomsOf(jsonOf(own.stdout)).map(atom => atom.domain)).toContain(FOREIGN_DOMAIN);
    expect(foreign.exitCode).toBe(2);
    // Under `--json` the refusal is the payload's `error`, not stderr.
    expect(String(jsonOf(foreign.stdout)['error'])).toContain('docs');
    expect(String(jsonOf(foreign.stdout)['error'])).toContain(FOREIGN_DOMAIN);
  });
});
