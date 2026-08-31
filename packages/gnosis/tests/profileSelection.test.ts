import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultIndexPath } from '../src/cli/adapter.js';
import type { FlagValues } from '../src/cli/args.js';
import { parseArgs } from '../src/cli/args.js';
import { runCli } from '../src/cli/cli.js';
import { resolveLocations } from '../src/cli/locations.js';
import { CORPUS_ROOTS, CORPUS_ROOTS_ENV_VAR } from '../src/config.js';
import { ATOMS_OWNER_FILE, ingest } from '../src/ingest.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import { loadIngestProfile } from '../src/ingestProfile.js';
import { atomsDir, repoRoot } from '../src/paths.js';
import { activeProfile } from '../src/vocabulary.js';

/** Long enough to clear the minimum body length, so the section becomes an atom. */
const alphaDoc = (term: string): string =>
  `# ${term} handbook\n\nprose about ${term} written at enough length that this section stands on its own as an atom of the corpus rather than folding into a neighbour, carrying real sentences about the ${term} subject matter\n`;

interface Corpus {
  readonly repoRoot: string;
  readonly profilesDir: string;
}

const makeCorpus = async (): Promise<Corpus> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-profile-'));
  await mkdir(join(repoRoot, 'doc', 'alpha'), { recursive: true });
  await mkdir(join(repoRoot, 'doc', 'beta'), { recursive: true });
  await writeFile(join(repoRoot, 'doc', 'alpha', 'ALPHA.md'), alphaDoc('alphaknowledge'), 'utf8');
  await writeFile(join(repoRoot, 'doc', 'beta', 'BETA.md'), alphaDoc('betaknowledge'), 'utf8');
  const profilesDir = join(repoRoot, 'profiles');
  await mkdir(profilesDir, { recursive: true });
  return { repoRoot, profilesDir };
};

/** A full profile: the shipped vocabulary plus this instance's own locations. */
const writeProfile = async (
  corpus: Corpus,
  name: string,
  locations: Readonly<Record<string, unknown>>
): Promise<string> => {
  const path = join(corpus.profilesDir, `${name}.profile.json`);
  await writeFile(path, JSON.stringify({ ...activeProfile(), name, ...locations }), 'utf8');
  return path;
};

const instanceProfile = async (corpus: Corpus, name: string): Promise<string> =>
  await writeProfile(corpus, name, {
    repoRoot: corpus.repoRoot,
    corpusRoots: [`doc/${name}`],
    atomsDir: join(corpus.repoRoot, name, 'atoms'),
    indexPath: join(corpus.repoRoot, name, 'index.db'),
  });

const flagsOf = (argv: readonly string[]): FlagValues => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.args.flags;
};

const jsonOf = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

const sourcePaths = (payload: Record<string, unknown>): readonly string[] =>
  (payload['atoms'] as readonly { readonly sourcePath: string }[]).map(atom => atom.sourcePath);

const namedProfile = (name: string): IngestProfile => ({ ...activeProfile(), name });

/** `vi.stubEnv` persists across tests otherwise, and the scope override is process-wide. */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('location precedence — flag > profile > default', () => {
  it('falls back to the built-in locations when neither a flag nor a profile states one', () => {
    const locations = resolveLocations({}, 'fts5', activeProfile());

    expect(locations).toEqual({
      atomsDir: atomsDir(),
      indexPath: defaultIndexPath('fts5'),
      repoRoot: repoRoot(),
      corpusRoots: CORPUS_ROOTS,
    });
  });

  it('takes every location from the profile when no flag states one', async () => {
    const corpus = await makeCorpus();
    const profile = loadIngestProfile(await instanceProfile(corpus, 'alpha'));

    const locations = resolveLocations({}, 'fts5', profile);

    expect(locations).toEqual({
      atomsDir: join(corpus.repoRoot, 'alpha', 'atoms'),
      indexPath: join(corpus.repoRoot, 'alpha', 'index.db'),
      repoRoot: corpus.repoRoot,
      corpusRoots: ['doc/alpha'],
    });
  });

  it('lets a flag override the profile for every location field', async () => {
    const corpus = await makeCorpus();
    const profile = loadIngestProfile(await instanceProfile(corpus, 'alpha'));
    const flags = flagsOf([
      '--atoms-dir',
      '/flag/atoms',
      '--index-path',
      '/flag/index.db',
      '--repo-root',
      '/flag/repo',
    ]);
    vi.stubEnv(CORPUS_ROOTS_ENV_VAR, 'doc/flagged');

    const locations = resolveLocations(flags, 'fts5', profile);

    expect(locations).toEqual({
      atomsDir: '/flag/atoms',
      indexPath: '/flag/index.db',
      repoRoot: '/flag/repo',
      corpusRoots: ['doc/flagged'],
    });
  });
});

describe('two instances, two corpora', () => {
  it('keeps each profile index and atoms separate, and neither retrieves the other corpus', async () => {
    const corpus = await makeCorpus();
    const alpha = await instanceProfile(corpus, 'alpha');
    const beta = await instanceProfile(corpus, 'beta');

    await runCli(['ingest', '--profile', alpha, '--json']);
    await runCli(['ingest', '--profile', beta, '--json']);
    const alphaIndex = jsonOf((await runCli(['index', '--adapter', 'fts5', '--profile', alpha, '--json'])).stdout);
    const betaIndex = jsonOf((await runCli(['index', '--adapter', 'fts5', '--profile', beta, '--json'])).stdout);

    expect(alphaIndex['indexPath']).toBe(join(corpus.repoRoot, 'alpha', 'index.db'));
    expect(betaIndex['indexPath']).toBe(join(corpus.repoRoot, 'beta', 'index.db'));

    const fromAlpha = jsonOf(
      (await runCli(['search', 'betaknowledge', '--adapter', 'fts5', '--profile', alpha, '--json'])).stdout
    );
    const fromBeta = jsonOf(
      (await runCli(['search', 'alphaknowledge', '--adapter', 'fts5', '--profile', beta, '--json'])).stdout
    );

    expect(sourcePaths(fromAlpha).some(path => path.includes('beta'))).toBe(false);
    expect(sourcePaths(fromBeta).some(path => path.includes('alpha'))).toBe(false);

    // The absence above is only evidence if each index answers its OWN corpus.
    const ownAlpha = jsonOf(
      (await runCli(['search', 'alphaknowledge', '--adapter', 'fts5', '--profile', alpha, '--json'])).stdout
    );
    expect(sourcePaths(ownAlpha).every(path => path.includes('alpha'))).toBe(true);
    expect(ownAlpha['count']).toBeGreaterThan(0);
  });
});

describe('atoms-directory owner marker', () => {
  it('adopts a directory that carries no marker yet, and records the profile id in it', async () => {
    const corpus = await makeCorpus();
    const outputDir = join(corpus.repoRoot, 'adopted');
    await mkdir(outputDir, { recursive: true });

    const summary = await ingest({
      corpusRoots: ['doc/alpha'],
      outputDir,
      repoRoot: corpus.repoRoot,
      profile: namedProfile('alpha'),
    });

    expect(summary.written).toBeGreaterThan(0);
    expect((await readFile(join(outputDir, ATOMS_OWNER_FILE), 'utf8')).trim()).toBe('alpha');
  });

  it('refuses to ingest one profile into a directory another profile already owns', async () => {
    const corpus = await makeCorpus();
    const outputDir = join(corpus.repoRoot, 'contested');
    await ingest({
      corpusRoots: ['doc/alpha'],
      outputDir,
      repoRoot: corpus.repoRoot,
      profile: namedProfile('alpha'),
    });

    const refusal = ingest({
      corpusRoots: ['doc/beta'],
      outputDir,
      repoRoot: corpus.repoRoot,
      profile: namedProfile('beta'),
    });

    await expect(refusal).rejects.toThrow(
      new RegExp(`alpha[\\s\\S]*beta|beta[\\s\\S]*alpha`)
    );
    await expect(refusal).rejects.toThrow(outputDir);
  });
});
