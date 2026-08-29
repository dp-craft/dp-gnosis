import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ingest } from '../src/ingest.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import { loadIngestProfile, parseIngestProfile } from '../src/ingestProfile.js';
import { profilesDir } from '../src/paths.js';

/**
 * CHANGE 1 — `corpusRoots` accepts an absolute path and a `~`-rooted one, so a
 * single index can span project doc trees that share no parent.
 *
 * The rule under test, in one sentence: a source that lies UNDER `repoRoot` is
 * identified by its repo-relative path exactly as before; every other source is
 * identified by its own absolute path, and `domainRules` / `typeRules` /
 * `excludePaths` prefix-match that identifier unchanged.
 */

const toPosix = (path: string): string => path.split('\\').join('/');

const BODY_A =
  'the aichatney doc tree describes its transport layer in enough prose to stand on its own as one atom of the corpus, well past the minimum body length an atom must carry to be written at all';
const BODY_B =
  'the standards knowledge tree describes its review policy in enough prose to stand on its own as one atom of the corpus, well past the minimum body length an atom must carry to be written at all';

const docText = (title: string, body: string): string => `# ${title}\n\n${body}\n`;

const writeDoc = async (dir: string, name: string, text: string): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return path;
};

/** A minimal profile whose rules the test states outright, so nothing is inherited. */
const profileWith = (rules: {
  readonly domainRules: readonly { readonly prefix: string; readonly domain: string }[];
  readonly excludePaths?: readonly string[];
}): IngestProfile =>
  parseIngestProfile(
    {
      name: 'multi-root-test',
      domains: ['engineering'],
      types: ['knowledge'],
      defaultType: 'knowledge',
      domainRules: rules.domainRules,
      typeRules: [],
      segmentRules: [],
      ...(rules.excludePaths === undefined ? {} : { excludePaths: rules.excludePaths }),
    },
    'multi-root-test'
  );

interface Fixture {
  readonly repoRoot: string;
  readonly external: string;
  readonly out: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-roots-repo-'));
  const external = await mkdtemp(join(tmpdir(), 'gnosis-roots-ext-'));
  const out = join(repoRoot, 'out');
  await writeDoc(join(repoRoot, 'doc'), 'LOCAL.md', docText('Local Doc', BODY_A));
  await writeDoc(join(external, 'projA', 'doc'), 'REMOTE.md', docText('Remote Doc', BODY_B));
  return { repoRoot, external, out };
};

const externalDocRoot = (fixture: Fixture): string => join(fixture.external, 'projA', 'doc');

describe('corpusRoots — an absolute entry is used as-is', () => {
  it('ingests a tree that shares no parent with repoRoot', async () => {
    const fixture = await makeFixture();
    const remote = externalDocRoot(fixture);
    const summary = await ingest({
      corpusRoots: ['doc', remote],
      outputDir: fixture.out,
      repoRoot: fixture.repoRoot,
      profile: profileWith({
        domainRules: [
          { prefix: 'doc', domain: 'engineering' },
          { prefix: toPosix(remote), domain: 'engineering' },
        ],
      }),
    });

    expect(summary.skipped).toEqual([]);
    expect(summary.written).toBe(2);
  });

  it('records the OUT-OF-REPO source by its absolute path and the in-repo one repo-relatively', async () => {
    const fixture = await makeFixture();
    const remote = externalDocRoot(fixture);
    await ingest({
      corpusRoots: ['doc', remote],
      outputDir: fixture.out,
      repoRoot: fixture.repoRoot,
      profile: profileWith({
        domainRules: [
          { prefix: 'doc', domain: 'engineering' },
          { prefix: toPosix(remote), domain: 'engineering' },
        ],
      }),
    });
    const atoms = readdirSync(fixture.out)
      .filter(name => name.endsWith('.md'))
      .map(name => readFileSync(join(fixture.out, name), 'utf8'));
    const sources = atoms.flatMap(text =>
      text.split('\n').filter(line => line.startsWith('  - ')).map(line => line.slice(4))
    );

    expect(sources.sort()).toEqual([`${toPosix(remote)}/REMOTE.md`, 'doc/LOCAL.md']);
  });

  it('REFUSES an out-of-repo source that no declared prefix claims', async () => {
    const fixture = await makeFixture();
    const remote = externalDocRoot(fixture);
    const summary = await ingest({
      corpusRoots: [remote],
      outputDir: fixture.out,
      repoRoot: fixture.repoRoot,
      profile: profileWith({ domainRules: [{ prefix: 'doc', domain: 'engineering' }] }),
    });

    expect(summary.written).toBe(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.reasons.join(' ')).toMatch(/outside every declared ingest root/);
    expect(summary.skipped[0]?.source).toBe(`${toPosix(remote)}/REMOTE.md`);
  });
});

describe('corpusRoots — a ~ entry expands to the home directory', () => {
  it('names the EXPANDED location when the root matches nothing', async () => {
    const fixture = await makeFixture();
    const missing = 'gnosis-absent-root-fixture-xyz';
    await expect(
      ingest({
        corpusRoots: [`~/${missing}`],
        outputDir: fixture.out,
        repoRoot: fixture.repoRoot,
        profile: profileWith({ domainRules: [{ prefix: 'doc', domain: 'engineering' }] }),
      })
    ).rejects.toThrow(join(homedir(), missing));
  });
});

describe('corpusRoots — a RELATIVE entry still resolves against repoRoot', () => {
  it('walks the repo-relative tree and keeps the repo-relative source path', async () => {
    const fixture = await makeFixture();
    const summary = await ingest({
      corpusRoots: ['doc'],
      outputDir: fixture.out,
      repoRoot: fixture.repoRoot,
      profile: profileWith({ domainRules: [{ prefix: 'doc', domain: 'engineering' }] }),
    });

    expect(summary.written).toBe(1);
    expect(summary.skipped).toEqual([]);
  });

  it('names repoRoot when a relative root matches nothing', async () => {
    const fixture = await makeFixture();
    await expect(
      ingest({
        corpusRoots: ['not-a-tree'],
        outputDir: fixture.out,
        repoRoot: fixture.repoRoot,
        profile: profileWith({ domainRules: [{ prefix: 'doc', domain: 'engineering' }] }),
      })
    ).rejects.toThrow(join(fixture.repoRoot, 'not-a-tree'));
  });

  it('leaves every SHIPPED profile purely repo-relative, so none of them moves', () => {
    const dir = profilesDir();
    const roots = readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .flatMap(name => [...(loadIngestProfile(join(dir, name)).corpusRoots ?? [])]);

    expect(roots.length).toBeGreaterThan(0);
    expect(roots.filter(root => root.startsWith('/') || root.startsWith('~'))).toEqual([]);
  });
});

describe('prefix rules — ~ expands in a rule exactly as it does in a root', () => {
  it('matches a home-rooted domain prefix against the expanded source path', () => {
    const profile = profileWith({
      domainRules: [{ prefix: '~/knowledge', domain: 'engineering' }],
    });

    expect(profile.domainRules[0]?.prefix).toBe(`${toPosix(homedir())}/knowledge`);
  });

  it('leaves a repo-relative prefix untouched', () => {
    const profile = profileWith({ domainRules: [{ prefix: 'doc', domain: 'engineering' }] });
    expect(profile.domainRules[0]?.prefix).toBe('doc');
  });
});

describe('excludePaths matches the source identity, repo-relative or absolute', () => {
  it('still drops a repo-relative source under a declared prefix', async () => {
    const fixture = await makeFixture();
    await writeDoc(join(fixture.repoRoot, 'doc', 'tmp'), 'GENERATED.md', docText('Gen', BODY_B));
    const summary = await ingest({
      corpusRoots: ['doc'],
      outputDir: fixture.out,
      repoRoot: fixture.repoRoot,
      profile: profileWith({
        domainRules: [{ prefix: 'doc', domain: 'engineering' }],
        excludePaths: ['doc/tmp'],
      }),
    });

    expect(summary.written).toBe(1);
    expect(summary.skipped).toEqual([]);
  });

  // OWNER-AUTHORISED assertion change: the absolute case asserted a refusal
  // ("/etc" throws /repo-relative/) that this change deliberately removes — an
  // absolute prefix is now the ONLY way to exclude a subtree of an absolute
  // corpus root. The ".." case is unchanged and still MUST throw.
  it('REFUSES a ".." prefix and ACCEPTS an absolute one', () => {
    expect(() => profileWith({
      domainRules: [{ prefix: 'doc', domain: 'engineering' }],
      excludePaths: ['../outside'],
    })).toThrow(/excludePaths/);
    expect(
      profileWith({
        domainRules: [{ prefix: 'doc', domain: 'engineering' }],
        excludePaths: ['/etc'],
      }).excludePaths
    ).toEqual(['/etc']);
  });

  it('expands a ~-rooted prefix exactly as a domain rule prefix is expanded', () => {
    expect(
      profileWith({
        domainRules: [{ prefix: 'doc', domain: 'engineering' }],
        excludePaths: ['~/knowledge/tmp'],
      }).excludePaths
    ).toEqual([`${toPosix(homedir())}/knowledge/tmp`]);
  });
});

/**
 * The load-bearing case: an ABSOLUTE corpus root — what `init` writes for an
 * installed instance — with an absolute `excludePaths` prefix naming a subtree
 * of it. Before this change the profile threw at parse, so no subtree of an
 * absolute root could be excluded at all.
 */
describe('excludePaths over an ABSOLUTE corpus root', () => {
  it('drops the excluded subtree BEFORE the source is read, so it is neither written nor skipped', async () => {
    const fixture = await makeFixture();
    const remote = externalDocRoot(fixture);
    await writeDoc(join(remote, 'tmp'), 'GENERATED.md', docText('Generated Doc', BODY_A));
    const summary = await ingest({
      corpusRoots: [remote],
      outputDir: fixture.out,
      repoRoot: fixture.repoRoot,
      profile: profileWith({
        domainRules: [{ prefix: toPosix(remote), domain: 'engineering' }],
        excludePaths: [`${toPosix(remote)}/tmp`],
      }),
    });
    const sources = readdirSync(fixture.out)
      .filter(name => name.endsWith('.md'))
      .flatMap(name =>
        readFileSync(join(fixture.out, name), 'utf8')
          .split('\n')
          .filter(line => line.startsWith('  - '))
          .map(line => line.slice(4))
      );

    expect(summary.written).toBe(1);
    expect(summary.skipped).toEqual([]);
    expect(sources).toEqual([`${toPosix(remote)}/REMOTE.md`]);
  });
});
