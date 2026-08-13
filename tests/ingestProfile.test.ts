import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_INGEST_PROFILE } from '../src/config.js';
import { ingest } from '../src/ingest.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import { domainForPath, loadIngestProfile, parseIngestProfile, typeForPath } from '../src/ingestProfile.js';
import { INGEST_PROFILE_PATH } from '../src/paths.js';
import { validateAtom } from '../src/validate.js';

const NO_IDS: ReadonlySet<string> = new Set();

/** Long enough to clear the minimum body length, so the section becomes an atom. */
const SECTION_BODY =
  'a section of invented prose long enough to stand on its own as an atom of the corpus, carrying real sentences about a subject rather than a bare heading with nothing under it at all';
const DOC = `# Invented Doc\n\n${SECTION_BODY}\n`;

const MINI_PROFILE: IngestProfile = {
  name: 'mini',
  domains: ['handbook', 'notes'],
  types: ['page', 'recipe', 'scratch'],
  defaultType: 'scratch',
  domainRules: [
    { prefix: 'handbook/', domain: 'handbook' },
    { prefix: 'notes/', domain: 'notes' },
  ],
  typeRules: [
    { prefix: 'handbook/', type: 'page' },
    { prefix: 'handbook/kitchen/', type: 'recipe' },
  ],
  segmentRules: [{ segment: '99-drafts', type: 'scratch' }],
};

const rawMini = (): Record<string, unknown> => ({
  name: 'mini',
  domains: ['handbook'],
  types: ['page'],
  defaultType: 'page',
  domainRules: [{ prefix: 'handbook/', domain: 'handbook' }],
  typeRules: [{ prefix: 'handbook/', type: 'page' }],
  segmentRules: [],
});

const makeTree = async (): Promise<{ readonly root: string; readonly out: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-profile-'));
  return { root, out: join(root, 'out') };
};

const writeDoc = async (root: string, relative: string, text: string): Promise<void> => {
  const path = join(root, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
};

const readAll = async (dir: string): Promise<readonly string[]> => {
  const names = [...(await readdir(dir))].sort();
  return await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')));
};

describe('ingest profile resolution', () => {
  it('gives an invented corpus tree the domains and types its own profile declares', async () => {
    const tree = await makeTree();
    await writeDoc(tree.root, join('handbook', 'intro.md'), DOC);
    await writeDoc(tree.root, join('handbook', 'kitchen', 'soup.md'), DOC);
    await writeDoc(tree.root, join('notes', '99-drafts', 'idea.md'), DOC);

    const summary = await ingest({
      corpusRoots: ['handbook', 'notes'],
      outputDir: tree.out,
      repoRoot: tree.root,
      profile: MINI_PROFILE,
    });

    expect(summary.skipped).toEqual([]);
    expect(summary.written).toBe(3);
    const atoms = await readAll(tree.out);
    const fields = atoms.map(text => ({
      domain: /x_domain: (.+)\n/.exec(text)?.[1],
      type: /type: (.+)\n/.exec(text)?.[1],
    }));
    expect(fields).toEqual([
      { domain: 'notes', type: 'scratch' },
      { domain: 'handbook', type: 'page' },
      { domain: 'handbook', type: 'recipe' },
    ]);
  });

  it('resolves the longest matching prefix and lets a segment rule override it', () => {
    expect(domainForPath(MINI_PROFILE, 'handbook/kitchen/soup.md')).toBe('handbook');
    expect(domainForPath(MINI_PROFILE, 'elsewhere/soup.md')).toBeUndefined();
    expect(typeForPath(MINI_PROFILE, 'handbook/kitchen/soup.md')).toBe('recipe');
    expect(typeForPath(MINI_PROFILE, 'handbook/99-drafts/soup.md')).toBe('scratch');
    expect(typeForPath(MINI_PROFILE, 'elsewhere/soup.md')).toBe('scratch');
  });
});

describe('ingest profile parsing', () => {
  it('rejects a rule naming a type outside the profile vocabulary, naming value and vocabulary', () => {
    const raw = { ...rawMini(), typeRules: [{ prefix: 'handbook/', type: 'reserch' }] };

    expect(() => parseIngestProfile(raw, 'mini.json')).toThrowError(/reserch/);
    expect(() => parseIngestProfile(raw, 'mini.json')).toThrowError(/page/);
    expect(() => parseIngestProfile(raw, 'mini.json')).toThrowError(/mini\.json/);
  });

  it('rejects a rule naming a domain outside the profile vocabulary', () => {
    const raw = { ...rawMini(), domainRules: [{ prefix: 'x/', domain: 'runnr' }] };

    expect(() => parseIngestProfile(raw, 'mini.json')).toThrowError(/runnr/);
  });

  it('rejects a missing field instead of defaulting it', () => {
    const { types: _types, ...withoutTypes } = rawMini();

    expect(() => parseIngestProfile(withoutTypes, 'mini.json')).toThrowError(/"types"/);
  });

  it('fails on a missing profile file naming the path, never a silent fallback', () => {
    const missing = join(tmpdir(), 'gnosis-absent-profile.json');

    expect(() => loadIngestProfile(missing)).toThrowError(new RegExp('gnosis-absent-profile'));
  });

  it('fails on a malformed profile file naming the path and the parse problem', async () => {
    const tree = await makeTree();
    const path = join(tree.root, 'broken.json');
    await writeFile(path, '{ "name": ', 'utf8');

    expect(() => loadIngestProfile(path)).toThrowError(/broken\.json/);
    expect(() => loadIngestProfile(path)).toThrowError(/JSON/);
  });
});

describe('shipped default profile', () => {
  it('is the source of the shipped vocabularies and rules', () => {
    const shipped = loadIngestProfile(INGEST_PROFILE_PATH);

    expect(shipped).toEqual(DEFAULT_INGEST_PROFILE);
    expect(shipped.domains).toEqual(['runner', 'standards', 'adr', 'docs', 'claude']);
    expect(shipped.types).toHaveLength(15);
    expect(shipped.defaultType).toBe('knowledge');
    expect(shipped.segmentRules).toEqual([{ segment: '95-brainstorms', type: 'brainstorm' }]);
  });

  it('accepts research, plan and lessons-learned on write', () => {
    const written = ['research', 'plan', 'lessons-learned'].map(type =>
      validateAtom(
        {
          frontmatter: {
            type,
            id: 'sample-atom',
            title: 'Sample',
            x_domain: 'docs',
            status: 'stable',
            sources: ['doc/x.md'],
          },
          body: 'body prose\n',
        },
        NO_IDS
      )
    );

    expect(written).toEqual([[], [], []]);
  });

  it('lets no path rule claim research, plan or lessons-learned', () => {
    const claimed = [
      ...DEFAULT_INGEST_PROFILE.typeRules.map(rule => rule.type),
      ...DEFAULT_INGEST_PROFILE.segmentRules.map(rule => rule.type),
      DEFAULT_INGEST_PROFILE.defaultType,
    ];

    expect(claimed).not.toContain('research');
    expect(claimed).not.toContain('plan');
    expect(claimed).not.toContain('lessons-learned');
  });
});
