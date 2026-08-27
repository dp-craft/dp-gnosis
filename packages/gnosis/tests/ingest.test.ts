import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATOM_FENCE_MAX_CHARS, ATOM_MAX_CHARS, CORPUS_ROOTS, CORPUS_ROOTS_ENV_VAR } from '../src/config.js';
import { CORPUS_MANIFEST_FILE } from '../src/corpusManifest.js';
import { ATOMS_OWNER_FILE, ingest } from '../src/ingest.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import { serializeSummarySidecar } from '../src/summarySidecar.js';
import { activeProfile } from '../src/vocabulary.js';

interface Fixture {
  readonly root: string;
  readonly standards: string;
  readonly out: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-ingest-'));
  const standards = join(root, 'claude-artifacts', 'standards');
  await mkdir(standards, { recursive: true });
  const out = join(root, 'out');
  return { root, standards, out };
};

const writeDoc = async (dir: string, name: string, text: string): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return path;
};

/** Everything the run left BUT its owner marker, which is bookkeeping, not corpus. */
const readAll = async (dir: string): Promise<ReadonlyMap<string, string>> => {
  const names = [...(await readdir(dir))].filter(name => name !== ATOMS_OWNER_FILE).sort();
  const entries = await Promise.all(
    names.map(async (name): Promise<readonly [string, string]> => [
      name,
      await readFile(join(dir, name), 'utf8'),
    ])
  );
  return new Map(entries);
};

const bodyOf = (text: string): string => text.split('\n---\n').slice(1).join('\n---\n');

/** A root the corpus scope is pointed at explicitly, so the walk stays inside the fixture. */
const STANDARDS_ROOT = 'claude-artifacts/standards';

/** Both section bodies clear `ATOM_MIN_CHARS`, so the doc stays two atoms. */
const INTRO_BODY =
  'intro text about the layered test model and its tiers, describing what each tier covers and why the introduction of a document carries enough prose of its own to stand as a separate atom of the whole corpus';
const UNIT_BODY =
  'fast unit tier tests run in under a millisecond each, and the unit tier section carries enough prose of its own that it stands alone as an atom of the corpus instead of folding into the introduction above it';
const DOC = `# Layered Test Model\n\n${INTRO_BODY}\n\n## Unit tier\n\n${UNIT_BODY}\n`;

/**
 * Same headings as `DOC`, different prose. A second file carrying DOC verbatim
 * would be refused as an exact-body duplicate, so a test about scope would
 * silently become a test about dedupe.
 */
const MIRRORED_DOC = DOC.split('atom of the').join('separate unit of the');

describe('ingest', () => {
  it('turns a fixture doc into one atom file per chunk', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(2);
    expect(summary.skipped).toEqual([]);
    const files = await readAll(fixture.out);
    expect([...files.keys()]).toEqual([
      'ts-testing-layered-test-model-unit-tier.md',
      'ts-testing-layered-test-model.md',
    ]);
    const first = files.get('ts-testing-layered-test-model.md') ?? '';
    expect(first).toContain('type: standard\n');
    expect(first).toContain('status: stable\n');
    expect(first).toContain('x_domain: standards\n');
    expect(first).toContain('title: Layered Test Model\n');
    expect(first).not.toContain('stale_after');
    expect(first).not.toContain('verified_');
    expect(bodyOf(first)).toBe(`# Layered Test Model\n\n${INTRO_BODY}\n`);
  });

  it('records the repo-relative source path, never an absolute one', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const files = await readAll(fixture.out);
    const first = files.get('ts-testing-layered-test-model.md') ?? '';
    expect(first).toContain('sources:\n  - claude-artifacts/standards/TS-TESTING.md\n');
    expect(first).not.toContain(fixture.root);
  });

  it('derives the type from the source directory and keeps it out of the body', async () => {
    const fixture = await makeFixture();
    const logRoot = 'doc/90-history/10-feature-log';
    await writeDoc(join(fixture.root, ...logRoot.split('/')), 'FEATURE-047.md', DOC);

    await ingest({ corpusRoots: [logRoot], outputDir: fixture.out, repoRoot: fixture.root });

    const files = await readAll(fixture.out);
    const first = files.get('feature-047-layered-test-model.md') ?? '';
    expect(first).toContain('type: feature-log\n');
    expect(bodyOf(first)).toBe(`# Layered Test Model\n\n${INTRO_BODY}\n`);
    const bodies = [...files.values()].map(bodyOf);
    expect(bodies.filter(body => body.includes('feature-log'))).toEqual([]);
  });

  it('produces byte-identical output when re-run over unchanged input', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    const options = { corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root };

    await ingest(options);
    const firstRun = await readAll(fixture.out);
    const second = await ingest(options);
    const secondRun = await readAll(fixture.out);

    expect(second.written).toBe(2);
    expect(second.skipped).toEqual([]);
    expect([...secondRun.entries()]).toEqual([...firstRun.entries()]);
  });

  it('resolves identically-slugifying headings to distinct ids, independent of input order', async () => {
    const fixture = await makeFixture();
    await writeDoc(
      join(fixture.standards, 'alpha'),
      'X.md',
      '# Gate Contract\n\nalpha body\n'
    );
    await writeDoc(
      join(fixture.standards, 'beta'),
      'X.md',
      '# gate  contract!\n\nbeta body\n'
    );

    const forward = await ingest({
      corpusRoots: [`${STANDARDS_ROOT}/alpha`, `${STANDARDS_ROOT}/beta`],
      outputDir: join(fixture.root, 'fwd'),
      repoRoot: fixture.root,
    });
    const reverse = await ingest({
      corpusRoots: [`${STANDARDS_ROOT}/beta`, `${STANDARDS_ROOT}/alpha`],
      outputDir: join(fixture.root, 'rev'),
      repoRoot: fixture.root,
    });

    expect(forward.written).toBe(2);
    expect(reverse.written).toBe(2);
    const fwd = await readAll(join(fixture.root, 'fwd'));
    const rev = await readAll(join(fixture.root, 'rev'));
    expect([...fwd.keys()].length).toBe(2);
    expect([...rev.entries()]).toEqual([...fwd.entries()]);
    expect([...fwd.keys()].every(name => name.startsWith('x-gate-contract-'))).toBe(true);
  });

  it('walks the configured corpus roots only, leaving everything else unread', async () => {
    const fixture = await makeFixture();
    await writeDoc(join(fixture.root, 'doc'), 'IN-SCOPE.md', DOC);
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    vi.stubEnv(CORPUS_ROOTS_ENV_VAR, 'doc');

    const summary = await ingest({ outputDir: fixture.out, repoRoot: fixture.root });
    vi.unstubAllEnvs();

    expect(summary.written).toBe(2);
    expect(summary.skipped).toEqual([]);
    expect([...(await readAll(fixture.out)).keys()]).toEqual([
      'in-scope-layered-test-model-unit-tier.md',
      'in-scope-layered-test-model.md',
    ]);
  });

  it('declares the whole authored knowledge base as the default scope', () => {
    expect(CORPUS_ROOTS).toEqual(['doc', 'docs', 'claude-artifacts', 'RUNNER-*.md']);
  });

  it('contributes the files a glob root matches, and only those', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.root, 'RUNNER-GUIDE.md', DOC);
    await writeDoc(fixture.root, 'RUNNER-MAP.md', MIRRORED_DOC);
    await writeDoc(fixture.root, 'CLAUDE.md', DOC);

    const summary = await ingest({
      corpusRoots: ['RUNNER-*.md'],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.skipped).toEqual([]);
    expect([...(await readAll(fixture.out)).keys()]).toEqual([
      'runner-guide-layered-test-model-unit-tier.md',
      'runner-guide-layered-test-model.md',
      'runner-map-layered-test-model-unit-tier.md',
      'runner-map-layered-test-model.md',
    ]);
  });

  it('still walks a directory root recursively', async () => {
    const fixture = await makeFixture();
    await writeDoc(join(fixture.standards, 'nested', 'deeper'), 'DEEP.md', DOC);

    const summary = await ingest({
      corpusRoots: ['claude-artifacts'],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(2);
    expect([...(await readAll(fixture.out)).keys()]).toEqual([
      'deep-layered-test-model-unit-tier.md',
      'deep-layered-test-model.md',
    ]);
  });

  it('refuses a configured root that matches nothing, naming that root', async () => {
    const fixture = await makeFixture();
    await writeDoc(join(fixture.root, 'doc'), 'IN-SCOPE.md', DOC);

    await expect(
      ingest({
        corpusRoots: ['doc', 'typo-artifacts'],
        outputDir: fixture.out,
        repoRoot: fixture.root,
      })
    ).rejects.toThrow(/typo-artifacts/);
  });

  it('applies the zero-match refusal to an env-var override too', async () => {
    const fixture = await makeFixture();
    await writeDoc(join(fixture.root, 'doc'), 'IN-SCOPE.md', DOC);
    vi.stubEnv(CORPUS_ROOTS_ENV_VAR, 'doc,NOPE-*.md');

    const attempt = ingest({ outputDir: fixture.out, repoRoot: fixture.root });

    await expect(attempt).rejects.toThrow(/NOPE-\*\.md/);
    vi.unstubAllEnvs();
  });

  it('refuses a source outside every declared ingest root and names the correction', async () => {
    const fixture = await makeFixture();
    await writeDoc(join(fixture.root, 'notes'), 'stray.md', DOC);

    const summary = await ingest({
      corpusRoots: ['notes'],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(0);
    expect(summary.skipped).toHaveLength(1);
    const reason = summary.skipped[0]?.reasons.join(' ') ?? '';
    expect(summary.skipped[0]?.source).toBe('notes/stray.md');
    expect(reason).toContain('claude-artifacts/standards/');
    expect(reason).toContain('domainRules');
    expect(reason).toContain('default.profile.json');
  });

  it('keeps every written atom under the body cap by sub-splitting an oversize section', async () => {
    const fixture = await makeFixture();
    const paragraphs = Array.from(
      { length: 200 },
      (_unused, index) => `paragraph ${index} ${'x'.repeat(60)}`
    ).join('\n\n');
    await writeDoc(
      fixture.standards,
      'BIG.md',
      `# Huge Section\n\n${paragraphs}\n`
    );

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBeGreaterThan(1);
    expect(summary.skipped).toEqual([]);
    const files = await readAll(fixture.out);
    expect([...files.values()].every(text => bodyOf(text).length <= ATOM_MAX_CHARS)).toBe(true);
    expect(new Set(files.keys()).size).toBe(summary.written);
  });

  it('starts the atom body with its heading chain, not only the frontmatter title', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const files = await readAll(fixture.out);
    const nested = files.get('ts-testing-layered-test-model-unit-tier.md') ?? '';
    expect(bodyOf(nested)).toBe(`# Layered Test Model > Unit tier\n\n${UNIT_BODY}\n`);
    expect(bodyOf(files.get('ts-testing-layered-test-model.md') ?? '')).toBe(
      `# Layered Test Model\n\n${INTRO_BODY}\n`
    );
  });

  it('names the document in the frontmatter only when the chunk has no heading chain', async () => {
    const fixture = await makeFixture();
    const preamble =
      'text that precedes every heading of this document entirely, carrying enough prose of its own to stand as a separate atom of the corpus rather than folding forward into the first titled section of the document';
    await writeDoc(fixture.standards, 'PRE.md', `${preamble}\n`);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const files = await readAll(fixture.out);
    expect([...files.values()].map(bodyOf)).toEqual([`${preamble}\n`]);
    const titles = ([...files.values()][0] ?? '')
      .split('\n')
      .filter(line => line.startsWith('title: '));
    expect(titles).toHaveLength(1);
    expect(titles[0]).not.toBe('title: ');
  });

  it('falls back to the document title rather than shipping an empty one', async () => {
    const fixture = await makeFixture();
    const lead =
      'lead text about the untitled section that clears the atom floor, carrying enough prose of its own to stand as a separate atom of the corpus rather than folding forward into the untitled section that follows it';
    const tail =
      'body of the section whose own heading carries no text at all, carrying enough prose of its own to stand as a separate atom of the corpus rather than folding back into the lead section that precedes it here';
    await writeDoc(fixture.standards, 'BLANK.md', `# Named Doc\n\n${lead}\n\n## \n\n${tail}\n`);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const texts = [...(await readAll(fixture.out)).values()];
    const titles = texts.flatMap(text => text.split('\n').filter(l => l.startsWith('title: ')));
    expect(titles).toContain('title: Named Doc');
    expect(titles.some(title => title.trim() === 'title:')).toBe(false);
  });

  it('keeps the body cap when the heading would not fit, leaving that body unprefixed', async () => {
    const fixture = await makeFixture();
    const heading = 'Very Long Heading Name For The Body Cap Test';
    const filler = 'x'.repeat(ATOM_MAX_CHARS - 10);
    await writeDoc(fixture.standards, 'CAP.md', `# ${heading}\n\n${filler}\n`);

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.skipped).toEqual([]);
    const body = bodyOf([...(await readAll(fixture.out)).values()][0] ?? '');
    expect(body).toBe(`${filler}\n`);
    expect(body.length).toBeLessThanOrEqual(ATOM_MAX_CHARS);
  });

  it('should keep the heading line on a fenced chunk above the prose cap', async () => {
    const fixture = await makeFixture();
    const diagram = Array.from({ length: 62 }, () => 'x'.repeat(80)).join('\n');
    const doc = `# Diagram Section\n\n\`\`\`text\n${diagram}\n\`\`\`\n`;
    await writeDoc(fixture.standards, 'DIAGRAM.md', doc);

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.skipped).toEqual([]);
    expect(summary.written).toBe(1);
    const body = bodyOf([...(await readAll(fixture.out)).values()][0] ?? '');
    expect(body.split('\n')[0]).toBe('# Diagram Section');
    expect(body.length).toBeGreaterThan(ATOM_MAX_CHARS);
    expect(body.length).toBeLessThanOrEqual(ATOM_FENCE_MAX_CHARS);
  });

  it('skips and reports a refused source while still writing the valid ones', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    await writeDoc(join(fixture.root, 'notes'), 'stray.md', DOC);

    const summary = await ingest({
      corpusRoots: ['notes', STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(2);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.source).toBe('notes/stray.md');
    expect([...(await readAll(fixture.out)).keys()]).toEqual([
      'ts-testing-layered-test-model-unit-tier.md',
      'ts-testing-layered-test-model.md',
    ]);
  });
});

/** The blank `## ` heading leaves that chunk titleless, so the document title resolves it. */
const BLANK_SECTION_DOC = `# H One\n\n${INTRO_BODY}\n\n## \n\n${UNIT_BODY}\n`;

describe('ingest — document title in the frontmatter, never the body', () => {
  const NESTED = `# H One\n\n${INTRO_BODY}\n\n## Unit tier\n\n${UNIT_BODY}\n`;

  const bodiesOf = async (dir: string): Promise<readonly string[]> =>
    [...(await readAll(dir)).values()].map(bodyOf);

  const titlesOf = async (dir: string): Promise<readonly string[]> =>
    [...(await readAll(dir)).values()].flatMap(text =>
      text.split('\n').filter(line => line.startsWith('title: '))
    );

  it('prefers the front-matter title over the first H1', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'DOC.md', `---\ntitle: Front Title\n---\n${BLANK_SECTION_DOC}`);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    expect(await titlesOf(fixture.out)).toContain('title: Front Title');
    expect((await bodiesOf(fixture.out)).some(body => body.includes('Front Title'))).toBe(false);
  });

  it('falls back to the first H1 when no front-matter title exists', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'DOC.md', BLANK_SECTION_DOC);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    expect(await titlesOf(fixture.out)).toContain('title: H One');
  });

  it('falls back to the filename stem, hyphens as spaces, when neither exists', async () => {
    const fixture = await makeFixture();
    const preamble =
      'text that precedes every heading of this document entirely, carrying enough prose of its own to stand as a separate atom of the corpus rather than folding forward into the first titled section of the document';
    await writeDoc(fixture.standards, 'my-plain-doc.md', `# \n\n${preamble}\n\n## \n\n${UNIT_BODY}\n`);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    expect(await titlesOf(fixture.out)).toContain('title: my plain doc');
    expect(await bodiesOf(fixture.out)).toContain(`${UNIT_BODY}\n`);
  });

  it('prefixes the body with the chunk chain alone', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'DOC.md', `---\ntitle: Front Title\n---\n${NESTED}`);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const bodies = await bodiesOf(fixture.out);
    expect(bodies).toContain(`# H One > Unit tier\n\n${UNIT_BODY}\n`);
    expect(bodies).toContain(`# H One\n\n${INTRO_BODY}\n`);
  });
});

/** Both docs carry the same leaf title, so the chain is what resolves it. */
const EMPTY_SEGMENT_DOC = (body: string): string =>
  `# Prompting best practices\n\n${body.split(' ')[0] ?? ''} lead text about prompting that clears the atom floor, carrying enough prose of its own to stand as a separate atom of the corpus rather than folding forward into the leaf tactics section that follows it\n\n## \n\n### Leaf tactics\n\n${body}\n`;

describe('ingest — heading chain with an empty segment', () => {
  it('joins only the named chain parts, never emitting a blank separator run', async () => {
    const fixture = await makeFixture();
    await writeDoc(
      fixture.standards,
      'ONE.md',
      EMPTY_SEGMENT_DOC(
        'first leaf body long enough to survive the merge pass, carrying enough prose of its own to stand as a separate atom of the corpus rather than folding into any neighbouring section of the same source document'
      )
    );
    await writeDoc(
      fixture.standards,
      'TWO.md',
      EMPTY_SEGMENT_DOC(
        'second leaf body long enough to survive the merge pass, carrying enough prose of its own to stand as a separate atom of the corpus rather than folding into any neighbouring section of the same source document'
      )
    );

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.skipped).toEqual([]);
    const texts = [...(await readAll(fixture.out)).values()];
    const titles = texts.flatMap(text => text.split('\n').filter(line => line.startsWith('title: ')));
    expect(titles.some(title => title.includes('>  >'))).toBe(false);
    expect(titles).toContain('title: Prompting best practices > Leaf tactics');
  });
});

const SUMMARY_TEXT = 'what this document is for, in one line a reader can act on';
const SUMMARY_COMMENT = `<!-- LLM-PRIMARY: ${SUMMARY_TEXT} -->`;

describe('ingest — document summary and HTML comments', () => {
  const readTexts = async (dir: string): Promise<readonly string[]> =>
    [...(await readAll(dir)).values()];

  it('puts the LLM-PRIMARY summary in the frontmatter of every atom and in no body', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', `${SUMMARY_COMMENT}\n\n${DOC}`);

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.skipped).toEqual([]);
    const texts = await readTexts(fixture.out);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every(text => text.includes(`summary: ${SUMMARY_TEXT}\n`))).toBe(true);
    expect(texts.every(text => !bodyOf(text).includes(SUMMARY_TEXT))).toBe(true);
    expect(bodyOf(texts.find(text => text.includes('title: Unit tier')) ?? '')).toBe(
      `# Layered Test Model > Unit tier\n\n${UNIT_BODY}\n`
    );
  });

  it('omits the summary field entirely when the document carries no LLM-PRIMARY comment', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const texts = await readTexts(fixture.out);
    expect(texts.some(text => text.includes('summary:'))).toBe(false);
  });

  it('strips every HTML comment from the body', async () => {
    const fixture = await makeFixture();
    const doc = `# Layered Test Model\n\n${INTRO_BODY}\n\n<!-- an aside nobody reads -->\n\n## Unit tier\n\n<!-- another\nmultiline aside -->\n${UNIT_BODY}\n`;
    await writeDoc(fixture.standards, 'TS-TESTING.md', doc);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const bodies = (await readTexts(fixture.out)).map(bodyOf);
    expect(bodies.some(body => body.includes('<!--'))).toBe(false);
    expect(bodies.some(body => body.includes('aside'))).toBe(false);
  });

  it('should skip and report an atom whose whole body was a comment', async () => {
    const fixture = await makeFixture();
    const onlyComment =
      '<!-- a comment long enough on its own to clear the atom floor, carrying enough characters of raw body that the chunker keeps this section as its own atom before ingest strips the comment away entirely -->';
    await writeDoc(fixture.standards, 'DOC.md', `# Doc Head\n\n${INTRO_BODY}\n\n## Note\n\n${onlyComment}\n`);

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect((await readTexts(fixture.out)).some(text => text.includes('title: Note'))).toBe(false);
    expect(summary.skipped.map(skip => skip.title)).toEqual(['Note']);
    expect(summary.skipped[0]?.reasons.join(' ')).toContain('empty');
  });

  it('keeps the document title and the summary in the frontmatter and out of the body', async () => {
    const fixture = await makeFixture();
    const doc = `---\ntitle: Front Title\n---\n${SUMMARY_COMMENT}\n\n${BLANK_SECTION_DOC}`;
    await writeDoc(fixture.standards, 'DOC.md', doc);

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.skipped).toEqual([]);
    const text = (await readTexts(fixture.out)).find(entry => entry.includes(UNIT_BODY)) ?? '';
    expect(text).toContain('title: Front Title\n');
    expect(text).toContain(`summary: ${SUMMARY_TEXT}\n`);
    expect(bodyOf(text)).toBe(`# H One\n\n${UNIT_BODY}\n`);
  });
});

/** Three paragraphs, each just under the pack target, so one section emits three chunks. */
const PART_DOC = `# Split Section\n\n${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}\n\n${'c'.repeat(3000)}\n`;

describe('ingest — part index for a split section', () => {
  it('numbers every atom of a three-way split in its title, never in its body heading', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'SPLIT.md', PART_DOC);

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(3);
    const texts = [...(await readAll(fixture.out)).values()];
    const titles = texts.flatMap(text => text.split('\n').filter(line => line.startsWith('title: ')));
    expect([...titles].sort()).toEqual([
      'title: Split Section (1/3)',
      'title: Split Section (2/3)',
      'title: Split Section (3/3)',
    ]);
    const headings = texts.map(text => bodyOf(text).split('\n')[0] ?? '');
    expect(headings).toEqual(['# Split Section', '# Split Section', '# Split Section']);
  });

  it('leaves a single-chunk section unsuffixed and its id unchanged', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'SPLIT.md', PART_DOC);
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    const files = await readAll(fixture.out);
    expect([...files.keys()]).toContain('ts-testing-layered-test-model-unit-tier.md');
    expect(files.get('ts-testing-layered-test-model-unit-tier.md') ?? '').toContain(
      'title: Unit tier\n'
    );
    const splitNames = [...files.keys()].filter(name => name.startsWith('split-'));
    expect(splitNames).toHaveLength(3);
    expect(splitNames.every(name => /^split-split-section-[0-9a-f]{8}\.md$/.test(name))).toBe(true);
  });
});

describe('ingest — orphan atoms from a previous run', () => {
  it('deletes every atom file the run did not write and reports the count', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    await mkdir(fixture.out, { recursive: true });
    await writeFile(join(fixture.out, 'ts-testing-old-chunker-section.md'), 'stale atom\n', 'utf8');
    await writeFile(join(fixture.out, 'index.json'), '{}\n', 'utf8');

    const summary = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(2);
    expect(summary.pruned).toBe(1);
    expect([...(await readAll(fixture.out)).keys()]).toEqual([
      'index.json',
      'ts-testing-layered-test-model-unit-tier.md',
      'ts-testing-layered-test-model.md',
    ]);
  });
});

/**
 * The vault is gitignored, so the corpus itself can never anchor a measurement.
 * The manifest is the committable stand-in: an aggregate identity plus the
 * buckets a drift is localised to. Its whole value rests on being a pure
 * function of the corpus, so every assertion here is about determinism.
 */
describe('ingest — corpus manifest', () => {
  const manifestOf = async (fixture: Fixture): Promise<string> =>
    readFile(join(fixture.root, CORPUS_MANIFEST_FILE), 'utf8');

  const A_DOC = `# Alpha Doc\n\n${INTRO_BODY}\n`;
  const B_DOC = `# Beta Doc\n\n${UNIT_BODY}\n`;

  it('writes a manifest naming the profile, the atom count and the bucket counts', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'ALPHA.md', A_DOC);
    await writeDoc(join(fixture.root, 'doc', '90-history', '10-feature-log'), 'F.md', B_DOC);

    await ingest({
      corpusRoots: [STANDARDS_ROOT, 'doc/90-history/10-feature-log'],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    const manifest: unknown = JSON.parse(await manifestOf(fixture));
    expect(manifest).toEqual({
      profile: 'default',
      atomCount: 2,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sourceCount: 2,
      sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      byType: { 'feature-log': 1, standard: 1 },
      byDomain: { docs: 1, standards: 1 },
      skipped: 0,
      duplicates: 0,
    });
  });

  it('produces a byte-identical manifest when re-run over unchanged input', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'ALPHA.md', A_DOC);
    const options = { corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root };

    await ingest(options);
    const first = await manifestOf(fixture);
    await ingest(options);

    expect(await manifestOf(fixture)).toBe(first);
  });

  it('changes the digest but no bucket count when one atom body changes', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'ALPHA.md', A_DOC);
    const options = { corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root };

    await ingest(options);
    const before = JSON.parse(await manifestOf(fixture)) as Record<string, unknown>;
    await writeDoc(fixture.standards, 'ALPHA.md', `# Alpha Doc\n\n${UNIT_BODY}\n`);
    await ingest(options);
    const after = JSON.parse(await manifestOf(fixture)) as Record<string, unknown>;

    expect(after['digest']).not.toBe(before['digest']);
    expect(after['atomCount']).toEqual(before['atomCount']);
    expect(after['byType']).toEqual(before['byType']);
    expect(after['byDomain']).toEqual(before['byDomain']);
  });

  it('counts a refused source in the manifest instead of dropping it silently', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'ALPHA.md', A_DOC);
    await writeDoc(join(fixture.root, 'unmapped'), 'OUT.md', B_DOC);

    await ingest({
      corpusRoots: [STANDARDS_ROOT, 'unmapped'],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    const manifest = JSON.parse(await manifestOf(fixture)) as Record<string, unknown>;
    expect(manifest['skipped']).toBe(1);
    expect(manifest['atomCount']).toBe(1);
  });
});

describe('ingest — summary sidecar resolution', () => {
  const SIDECAR_FILE = 'summaries.json';

  const writeSidecar = async (
    root: string,
    summaries: Readonly<Record<string, string>>
  ): Promise<void> => {
    await writeFile(
      join(root, SIDECAR_FILE),
      serializeSummarySidecar(new Map(Object.entries(summaries))),
      'utf8'
    );
  };

  const profileWithSidecar = (): IngestProfile => ({
    ...activeProfile(),
    summarySidecar: SIDECAR_FILE,
  });

  const run = async (fixture: Fixture): Promise<readonly string[]> => {
    const result = await ingest({
      corpusRoots: [STANDARDS_ROOT],
      outputDir: fixture.out,
      repoRoot: fixture.root,
      profile: profileWithSidecar(),
    });
    expect(result.skipped).toEqual([]);
    return [...(await readAll(fixture.out)).values()];
  };

  it('lets an in-source LLM-PRIMARY comment override the sidecar entry', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', `${SUMMARY_COMMENT}\n\n${DOC}`);
    await writeSidecar(fixture.root, {
      'claude-artifacts/standards/TS-TESTING.md': 'the sidecar line that must lose',
    });

    const texts = await run(fixture);

    expect(texts.every(text => text.includes(`summary: ${SUMMARY_TEXT}\n`))).toBe(true);
    expect(texts.some(text => text.includes('must lose'))).toBe(false);
  });

  it('DoD #6 — a document carrying NO comment still gets its summary, from the sidecar', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    await writeSidecar(fixture.root, {
      'claude-artifacts/standards/TS-TESTING.md': 'what this document is, carried by the sidecar',
    });

    const texts = await run(fixture);

    expect(texts.length).toBeGreaterThan(1);
    expect(
      texts.every(text =>
        text.includes('summary: what this document is, carried by the sidecar\n')
      )
    ).toBe(true);
    expect(texts.every(text => !bodyOf(text).includes('carried by the sidecar'))).toBe(true);
  });

  it('leaves the summary absent when neither the document nor the sidecar states one', async () => {
    const fixture = await makeFixture();
    await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    await writeSidecar(fixture.root, { 'claude-artifacts/standards/OTHER.md': 'unrelated' });

    const texts = await run(fixture);

    expect(texts.some(text => text.includes('summary:'))).toBe(false);
  });
});
