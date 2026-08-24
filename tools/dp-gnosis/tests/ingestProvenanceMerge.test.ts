import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AtomFrontmatter, parseAtom, serializeAtom } from '../src/atom.js';
import { ingest } from '../src/ingest.js';

/**
 * PROVENANCE MERGE. Exact-body dedupe drops a mirrored document, and the atom
 * that survives is the only thing left pointing at it — so it MUST name every
 * source document whose body it represents. A single-element `sources` makes
 * every other copy invisible to a reader and uncreditable to a golden set.
 */
const SHARED_BODY =
  'the debugging rules describe how an investigation is bounded, which evidence is admissible, and ' +
  'when an escalation is mandatory, and this paragraph is long enough on its own to clear both the ' +
  'chunker fold threshold and the exact-body dedupe floor so the two mirrored copies below form one ' +
  'byte-identical duplicate group rather than two independent atoms of the corpus';

const OTHER_BODY =
  'the responsibility rules describe which feature owns a concern, how a removal test is applied, and ' +
  'why a cross-feature import is refused, and this paragraph is deliberately unlike the shared one so ' +
  'it hashes to its own body key and forms a duplicate group of exactly one member, which is the case ' +
  'that must leave the recorded provenance of a lone document completely untouched by the merge';

const DOC = `# Shared Title\n\n${SHARED_BODY}\n`;
const SOLO_DOC = `# Solo Title\n\n${OTHER_BODY}\n`;

const ROOTS = ['claude-artifacts/standards', 'docs'] as const;

const ALPHA_ID = 'alpha-doc-shared-title';
const ZETA_ID = 'zeta-doc-shared-title';
const SOLO_ID = 'solo-doc-solo-title';

const ALPHA_PATH = 'claude-artifacts/standards/alpha-doc.md';
const ZETA_PATH = 'docs/zeta-doc.md';

interface Fixture {
  readonly root: string;
  readonly out: string;
}

/** `alpha-doc.md` under the standards root, `zeta-doc.md` under `docs/`, one solo document beside them. */
const stage = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-provenance-'));
  const standards = join(root, 'claude-artifacts', 'standards');
  const docsDir = join(root, 'docs');
  await mkdir(standards, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(standards, 'alpha-doc.md'), DOC, 'utf8');
  await writeFile(join(docsDir, 'zeta-doc.md'), DOC, 'utf8');
  await writeFile(join(docsDir, 'solo-doc.md'), SOLO_DOC, 'utf8');
  return { root, out: join(root, 'out') };
};

const sourcesOf = async (out: string, id: string): Promise<readonly string[]> => {
  const parsed = parseAtom(await readFile(join(out, `${id}.md`), 'utf8'));
  return parsed.ok ? parsed.atom.frontmatter.sources : [`UNPARSEABLE: ${parsed.error}`];
};

describe('ingest provenance merge', () => {
  it('gives the surviving atom EVERY dropped mirror path, its own first', async () => {
    const fixture = await stage();

    await ingest({ corpusRoots: [...ROOTS], outputDir: fixture.out, repoRoot: fixture.root });

    expect(await sourcesOf(fixture.out, ALPHA_ID)).toEqual([ALPHA_PATH, ZETA_PATH]);
  });

  it('leaves an atom that shares its body with nobody holding its single path', async () => {
    const fixture = await stage();

    await ingest({ corpusRoots: [...ROOTS], outputDir: fixture.out, repoRoot: fixture.root });

    expect(await sourcesOf(fixture.out, SOLO_ID)).toEqual(['docs/solo-doc.md']);
  });

  it('keeps each double-gold survivor on its OWN path, claiming no sibling document', async () => {
    const fixture = await stage();

    await ingest({
      corpusRoots: [...ROOTS],
      outputDir: fixture.out,
      repoRoot: fixture.root,
      goldIds: [ALPHA_ID, ZETA_ID],
    });

    expect(await sourcesOf(fixture.out, ALPHA_ID)).toEqual([ALPHA_PATH]);
    expect(await sourcesOf(fixture.out, ZETA_ID)).toEqual([ZETA_PATH]);
  });
});

const MERGED_FRONTMATTER: AtomFrontmatter = {
  type: 'standard',
  id: ALPHA_ID,
  title: 'Shared Title',
  x_domain: 'standards',
  status: 'stable',
  sources: [ALPHA_PATH, ZETA_PATH],
};

const MERGED_BODY = `${SHARED_BODY}\n`;

/** The write guard `validate.ts:roundTripError` asks — a merged atom MUST pass it. */
describe('merged sources round-trip', () => {
  it('survives parseAtom(serializeAtom(atom)) byte-identically', () => {
    const text = serializeAtom(MERGED_FRONTMATTER, MERGED_BODY);
    const parsed = parseAtom(text);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.atom.frontmatter.sources).toEqual([ALPHA_PATH, ZETA_PATH]);
    expect(serializeAtom(parsed.atom.frontmatter, parsed.atom.body)).toBe(text);
  });
});
