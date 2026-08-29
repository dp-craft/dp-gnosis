/**
 * An atom states WHERE IN its source document it came from: `origin_index` /
 * `origin_count` give it a position among that document's atoms, and
 * `heading_chain` the section path it was cut from. Without them a consumer
 * holding a handful of retrieved atoms can neither order them as the author
 * wrote them nor group the ones that belong to the same document — the two
 * things a reader does before quoting.
 *
 * All three are OPTIONAL: every atom already on disk lacks them and MUST still
 * parse, and an atom that carries none MUST still serialize to the bytes it
 * serializes to today.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AtomFrontmatter } from '../src/atom.js';
import { parseAtom, serializeAtom } from '../src/atom.js';
import { runCli } from '../src/cli/cli.js';
import { ingest } from '../src/ingest.js';

const BASE: AtomFrontmatter = {
  type: 'standard',
  id: 'ts-testing-layered-test-model',
  title: 'Layered Test Model',
  x_domain: 'standards',
  status: 'stable',
  sources: ['claude-artifacts/standards/TS-TESTING.md'],
};

const BODY = '# Layered Test Model\n\nprose\n';

describe('atom origin frontmatter', () => {
  it('round-trips an atom carrying position, count and heading chain', () => {
    const frontmatter: AtomFrontmatter = {
      ...BASE,
      summary: 'How the tiers divide the suite',
      heading_chain: 'Rerank > Fusion > RRF',
      origin_index: 0,
      origin_count: 7,
    };

    const parsed = parseAtom(serializeAtom(frontmatter, BODY));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.atom.frontmatter).toEqual(frontmatter);
    expect(parsed.atom.body).toBe(BODY);
  });

  it('leaves an atom carrying none of them byte-identical', () => {
    const text = serializeAtom(BASE, BODY);

    expect(text).toBe(
      [
        '---',
        'type: standard',
        'id: ts-testing-layered-test-model',
        'title: Layered Test Model',
        'x_domain: standards',
        'status: stable',
        'sources:',
        '  - claude-artifacts/standards/TS-TESTING.md',
        '---',
        BODY,
      ].join('\n')
    );
  });

  it.each(['-1', '1.5', 'first'])('refuses a non-integer origin_index (%s)', value => {
    const text = serializeAtom(BASE, BODY).replace('status: stable', `origin_index: ${value}\nstatus: stable`);

    const parsed = parseAtom(text);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('field "origin_index" MUST be a non-negative integer');
  });

  it('refuses a negative origin_count', () => {
    const text = serializeAtom(BASE, BODY).replace('status: stable', 'origin_count: -2\nstatus: stable');

    const parsed = parseAtom(text);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('field "origin_count" MUST be a non-negative integer');
  });
});

const SUMMARY = '<!-- LLM-PRIMARY: How the tiers divide the suite -->';
const INTRO_BODY =
  'intro text about the layered test model and its tiers, describing what each tier covers and why the introduction of a document carries enough prose of its own to stand as a separate atom of the whole corpus';
const UNIT_BODY =
  'fast unit tier tests run in under a millisecond each, and the unit tier section carries enough prose of its own that it stands alone as an atom of the corpus instead of folding into the introduction above it';
const DOC = `${SUMMARY}\n\n# Layered Test Model\n\n${INTRO_BODY}\n\n## Unit tier\n\n${UNIT_BODY}\n`;
const STANDARDS_ROOT = 'claude-artifacts/standards';

interface IngestFixture {
  readonly root: string;
  readonly out: string;
}

const ingested = async (text: string): Promise<IngestFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-origin-fm-'));
  const standards = join(root, 'claude-artifacts', 'standards');
  await mkdir(standards, { recursive: true });
  await writeFile(join(standards, 'TS-TESTING.md'), text, 'utf8');
  const out = join(root, 'out');
  await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: out, repoRoot: root });
  return { root, out };
};

const atomText = async (fixture: IngestFixture, name: string): Promise<string> =>
  readFile(join(fixture.out, name), 'utf8');

describe('ingest writes an atom its position and section path', () => {
  it('numbers each atom within its own source document', async () => {
    const fixture = await ingested(DOC);

    const intro = await atomText(fixture, 'ts-testing-layered-test-model.md');
    const unit = await atomText(fixture, 'ts-testing-layered-test-model-unit-tier.md');

    expect(intro).toContain('origin_index: 0\n');
    expect(intro).toContain('origin_count: 2\n');
    expect(unit).toContain('origin_index: 1\n');
    expect(unit).toContain('origin_count: 2\n');
  });

  it('joins the heading chain with " > "', async () => {
    const fixture = await ingested(DOC);

    const unit = await atomText(fixture, 'ts-testing-layered-test-model-unit-tier.md');

    expect(unit).toContain('heading_chain: Layered Test Model > Unit tier\n');
  });

  it('re-runs over unchanged input byte-identically', async () => {
    const fixture = await ingested(DOC);
    const first = await readAllAtoms(fixture.out);

    await ingest({ corpusRoots: [STANDARDS_ROOT], outputDir: fixture.out, repoRoot: fixture.root });

    expect(await readAllAtoms(fixture.out)).toEqual(first);
  });
});

const readAllAtoms = async (dir: string): Promise<readonly (readonly [string, string])[]> => {
  const names = [...(await readdir(dir))].filter(name => name.endsWith('.md')).sort();
  return Promise.all(
    names.map(async (name): Promise<readonly [string, string]> => [name, await readFile(join(dir, name), 'utf8')])
  );
};

interface CliFixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const RETRIEVE_DOC = `${SUMMARY}\n\n# Layered Test Model\n\n${INTRO_BODY}\n\n## Unit tier\n\n${UNIT_BODY}\n`;

const cliFixture = async (adapter: string, text: string): Promise<CliFixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-origin-cli-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), text, 'utf8');
  const atomsDir = join(repoRoot, 'atoms');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  await runCli(['index', '--adapter', adapter, '--atoms-dir', atomsDir, '--index-path', join(repoRoot, 'index', adapter)]);
  return { repoRoot, atomsDir };
};

const retrieved = async (
  fixture: CliFixture,
  adapter: string
): Promise<readonly Record<string, unknown>[]> => {
  const result = await runCli([
    'search',
    'retrieval unit tier',
    '-k',
    '2',
    '--adapter',
    adapter,
    '--atoms-dir',
    fixture.atomsDir,
    '--index-path',
    join(fixture.repoRoot, 'index', adapter),
    '--repo-root',
    fixture.repoRoot,
    '--json',
  ]);
  const data = JSON.parse(result.stdout) as Record<string, unknown>;
  return data['atoms'] as readonly Record<string, unknown>[];
};

describe('retrieve carries the origin fields', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each(['linear', 'fts5'])('%s adapter', adapter => {
    it('states position, count, chain and summary on every atom', async () => {
      const fixture = await cliFixture(adapter, RETRIEVE_DOC);

      const atoms = await retrieved(fixture, adapter);

      expect(atoms.length).toBe(2);
      const indices = atoms.map(atom => atom['originIndex']).sort();
      expect(indices).toEqual([0, 1]);
      expect(atoms.map(atom => atom['originCount'])).toEqual([2, 2]);
      expect(atoms.map(atom => atom['summary'])).toEqual([
        'How the tiers divide the suite',
        'How the tiers divide the suite',
      ]);
      expect(atoms.map(atom => atom['headingChain'])).toContain(
        'Layered Test Model > Unit tier'
      );
    });

    it('omits a field the atom does not carry rather than defaulting it', async () => {
      const fixture = await cliFixture(adapter, RETRIEVE_DOC.replace(`${SUMMARY}\n\n`, ''));

      const atoms = await retrieved(fixture, adapter);

      expect(atoms.length).toBeGreaterThan(0);
      expect(atoms.every(atom => !('summary' in atom))).toBe(true);
      expect(atoms.every(atom => typeof atom['originIndex'] === 'number')).toBe(true);
    });
  });
});

/**
 * `origin_count` counts the atoms that EXIST, not the chunks the document
 * offered. A document whose second chunk was refused as a duplicate must state
 * "1 of 1" — stating "0 of 2" sends a caller looking for an atom that is in no
 * corpus, which is a false completeness signal, not a missing one.
 */
const SHARED_BODY =
  'the debugging rules describe how an investigation is bounded, which evidence is admissible, and ' +
  'when an escalation is mandatory, and this paragraph is long enough on its own to clear both the ' +
  'chunker fold threshold and the exact-body dedupe floor so the two mirrored copies below form one ' +
  'byte-identical duplicate group rather than two independent atoms of the corpus';
const ALPHA_INTRO =
  'alpha opens by naming the documents it governs and the order their sections are meant to be read in, ' +
  'carrying prose enough of its own to stand as an atom rather than folding into the section beneath it';
const ALPHA_OWN =
  'a section alpha owns outright, describing the one rule no other document restates, at a length that ' +
  'clears the fold threshold so it is written as an atom of its own rather than merged with its neighbour';
const BETA_INTRO =
  'beta opens on a different subject entirely, restating none of alpha, and carries prose enough of its ' +
  'own to stand as an atom rather than folding into the mirrored section that follows it in this document';
const ALPHA_DOC = `# Alpha Doc\n\n${ALPHA_INTRO}\n\n## Own Section\n\n${ALPHA_OWN}\n\n## Shared Section\n\n${SHARED_BODY}\n`;
const BETA_DOC = `# Beta Doc\n\n${BETA_INTRO}\n\n## Shared Section\n\n${SHARED_BODY}\n`;

interface OriginRow {
  readonly source: string;
  readonly index: number | undefined;
  readonly count: number | undefined;
}

const originRows = async (dir: string): Promise<readonly OriginRow[]> => {
  const files = await readAllAtoms(dir);
  return files.map(([, text]) => {
    const parsed = parseAtom(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return {
      source: parsed.atom.frontmatter.sources[0] ?? '',
      index: parsed.atom.frontmatter.origin_index,
      count: parsed.atom.frontmatter.origin_count,
    };
  });
};

const forSource = (rows: readonly OriginRow[], source: string): readonly OriginRow[] =>
  rows.filter(row => row.source.endsWith(source));

describe('origin numbering counts the atoms that exist', () => {
  const stage = async (): Promise<IngestFixture> => {
    const root = await mkdtemp(join(tmpdir(), 'gnosis-origin-dedupe-'));
    const docs = join(root, 'docs');
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, 'alpha.md'), ALPHA_DOC, 'utf8');
    await writeFile(join(docs, 'beta.md'), BETA_DOC, 'utf8');
    const out = join(root, 'out');
    await ingest({ corpusRoots: ['docs'], outputDir: out, repoRoot: root });
    return { root, out };
  };

  it('renumbers a document densely after a sibling chunk was deduped away', async () => {
    const fixture = await stage();

    const rows = await originRows(fixture.out);

    expect(forSource(rows, 'alpha.md').length).toBe(3);
    expect(forSource(rows, 'beta.md')).toEqual([{ source: 'docs/beta.md', index: 0, count: 1 }]);
  });

  it('writes exactly {0 .. count-1} for every source document, with no gaps', async () => {
    const fixture = await stage();

    const rows = await originRows(fixture.out);

    const sources = [...new Set(rows.map(row => row.source))];
    expect(sources.length).toBe(2);
    sources.forEach(source => {
      const group = rows.filter(row => row.source === source);
      expect(group.map(row => row.count)).toEqual(group.map(() => group.length));
      expect([...group.map(row => row.index)].sort()).toEqual(group.map((_, index) => index));
    });
  });
});
