/**
 * INGEST-SIDE CORPUS HYGIENE — the three rules that decide what reaches the
 * vault at all: `docs/` is in scope, its generated subtrees are not, and a body
 * that already exists verbatim is written once.
 *
 * Every assertion runs against a FIXTURE tree under a temp dir. The real vault
 * is a symlink shared with other measurements, so nothing here may point ingest
 * at the default atoms directory.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CORPUS_ROOTS } from '../src/config.js';
import type { CorpusManifest } from '../src/corpusManifest.js';
import { CORPUS_MANIFEST_FILE } from '../src/corpusManifest.js';
import { ATOMS_OWNER_FILE, ingest } from '../src/ingest.js';
import { typeForPath } from '../src/ingestProfile.js';
import { activeProfile, domainForSource } from '../src/vocabulary.js';

interface Fixture {
  readonly root: string;
  readonly out: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-hygiene-'));
  return { root, out: join(root, 'out') };
};

const writeDoc = async (root: string, relativePath: string, text: string): Promise<void> => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
};

const atomNames = async (dir: string): Promise<readonly string[]> =>
  [...(await readdir(dir))].filter(name => name !== ATOMS_OWNER_FILE).sort();

const manifestOf = async (fixture: Fixture): Promise<CorpusManifest> =>
  JSON.parse(await readFile(join(fixture.root, CORPUS_MANIFEST_FILE), 'utf8')) as CorpusManifest;

/** 246 characters — comfortably above the 200-character dedupe floor. */
const LONG_BODY =
  'the retrieval corpus keeps one copy of a body that two documents happen to share, because a second copy occupies a rank it can never earn and pushes the answer the question was actually asking for off the end of the result window entirely';

const docWith = (heading: string, body: string): string => `# ${heading}\n\n${body}\n`;

const LONG_DOC = docWith('Mirror Section', LONG_BODY);

const ingestFixture = async (fixture: Fixture, roots: readonly string[]): Promise<Awaited<ReturnType<typeof ingest>>> =>
  await ingest({ corpusRoots: roots, outputDir: fixture.out, repoRoot: fixture.root });

describe('docs/ as a corpus root', () => {
  it('declares docs/ in the shipped scope alongside doc/ and claude-artifacts/', () => {
    expect(CORPUS_ROOTS).toContain('docs');
  });

  it('labels every authored docs/ subtree from the existing 15-type vocabulary', () => {
    expect(domainForSource('docs/research/2026-01-01-x.md')).toBe('docs');
    const typeOf = (path: string): string => typeForPath(activeProfile(), path);
    expect(typeOf('docs/research/x.md')).toBe('research');
    expect(typeOf('docs/plans/x.md')).toBe('plan');
    expect(typeOf('docs/implementation-lessons-learned/x.md')).toBe('lessons-learned');
    expect(typeOf('docs/adrs/x.md')).toBe('adr');
    expect(typeOf('docs/reviews/x.md')).toBe('review');
    expect(typeOf('docs/analysis/x.md')).toBe('review');
    expect(typeOf('docs/README.md')).toBe('knowledge');
  });
});

describe('excludePaths', () => {
  it('drops docs/tmp and docs/benchmarks before chunking, counting them nowhere', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'docs/research/authored.md', docWith('Authored', LONG_BODY));
    await writeDoc(fixture.root, 'docs/tmp/generated.md', docWith('Generated', LONG_BODY));
    await writeDoc(fixture.root, 'docs/benchmarks/run.md', docWith('Run', LONG_BODY));

    const summary = await ingestFixture(fixture, ['docs']);

    expect(summary.written).toBe(1);
    expect(summary.skipped).toEqual([]);
    expect(await atomNames(fixture.out)).toEqual(['authored-authored.md']);
  });

  it('excludes the navigation-only corpus digest while keeping authored doc/_meta files', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'doc/_meta/corpus-digest.md', docWith('Digest', LONG_BODY));
    await writeDoc(fixture.root, 'doc/_meta/taxonomy.md', docWith('Taxonomy', LONG_BODY));

    const summary = await ingestFixture(fixture, ['doc']);

    expect(summary.written).toBe(1);
    expect(summary.skipped).toEqual([]);
    expect(await atomNames(fixture.out)).toEqual(['taxonomy-taxonomy.md']);
  });

  it('does not let a trailing-slash directory prefix claim a sibling directory', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'docs/tmpl/kept.md', docWith('Kept', LONG_BODY));
    await writeDoc(fixture.root, 'docs/tmp/dropped.md', docWith('Dropped', LONG_BODY));

    const summary = await ingestFixture(fixture, ['docs']);

    expect(summary.written).toBe(1);
    expect(await atomNames(fixture.out)).toEqual(['kept-kept.md']);
  });

  it('keeps a source whose path merely lives beside an excluded prefix', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'docs/research/kept.md', docWith('Kept', LONG_BODY));
    await writeDoc(fixture.root, 'docs/tmp/dropped.md', docWith('Dropped', LONG_BODY));

    const summary = await ingestFixture(fixture, ['docs']);

    expect(summary.written).toBe(1);
    expect((await atomNames(fixture.out))[0]).toBe('kept-kept.md');
  });
});

describe('exact-body dedupe', () => {
  it('keeps the first by sorted source path and skips the mirror by the kept id', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'docs/research/a-original.md', LONG_DOC);
    await writeDoc(fixture.root, 'docs/research/z-mirror.md', LONG_DOC);

    const summary = await ingestFixture(fixture, ['docs']);

    expect(summary.written).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(await atomNames(fixture.out)).toEqual(['a-original-mirror-section.md']);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.source).toBe('docs/research/z-mirror.md');
    expect(summary.skipped[0]?.reasons).toEqual(['duplicate-body-of:a-original-mirror-section']);
  });

  it('ignores a heading difference, hashing the body with the heading line stripped', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'docs/research/a-original.md', docWith('One Heading', LONG_BODY));
    await writeDoc(fixture.root, 'docs/research/z-mirror.md', docWith('Another Heading', LONG_BODY));

    const summary = await ingestFixture(fixture, ['docs']);

    expect(summary.written).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.skipped[0]?.reasons).toEqual(['duplicate-body-of:a-original-one-heading']);
  });

  it('leaves bodies under 200 characters alone, where a collision is noise', async () => {
    const fixture = await makeFixture();
    const short = `${'short shared note about the vault, repeated verbatim in two places '.repeat(2)}end`;
    expect(short.length).toBeLessThan(200);
    await writeDoc(fixture.root, 'docs/research/a-original.md', docWith('Short Section', short));
    await writeDoc(fixture.root, 'docs/research/z-mirror.md', docWith('Short Section', short));

    const summary = await ingestFixture(fixture, ['docs']);

    expect(summary.duplicates).toBe(0);
    expect(summary.written).toBe(2);
  });

  it('records the duplicate count in the manifest as its own field, not as skipped', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'docs/research/a-original.md', LONG_DOC);
    await writeDoc(fixture.root, 'docs/research/z-mirror.md', LONG_DOC);

    await ingestFixture(fixture, ['docs']);
    const manifest = await manifestOf(fixture);

    expect(manifest.duplicates).toBe(1);
    expect(manifest.skipped).toBe(1);
    expect(manifest.atomCount).toBe(1);
  });
});
