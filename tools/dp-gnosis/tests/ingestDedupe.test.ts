import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_INGEST_PROFILE } from '../src/config.js';
import { DEFAULT_ADAPTER } from '../src/cli/adapter.js';
import type { CommandContext } from '../src/cli/context.js';
import { runIngestCommand } from '../src/cli/ingestCommand.js';
import { loadJudgedAtomIds } from '../src/goldenIds.js';
import { ATOMS_OWNER_FILE, ingest } from '../src/ingest.js';

/**
 * Exact-body dedupe, measured from the outside: which copy of a MIRRORED
 * document survives. The two properties under test are the ones the T2.1 gate
 * regression traced to — a survivor chosen by sorted source path is permuted by
 * the corpus root set, and it can be the copy the golden set does not judge.
 */
const SHARED_BODY =
  'the debugging rules describe how an investigation is bounded, which evidence is admissible, and ' +
  'when an escalation is mandatory, and this paragraph is long enough on its own to clear both the ' +
  'chunker fold threshold and the exact-body dedupe floor so the two mirrored copies below form one ' +
  'byte-identical duplicate group rather than two independent atoms of the corpus';

const DOC = `# Shared Title\n\n${SHARED_BODY}\n`;

const ROOTS = ['claude-artifacts/standards', 'docs'] as const;

interface Fixture {
  readonly root: string;
  readonly out: string;
}

/** One document, mirrored: `standardsName` under the standards root, `docsName` under `docs/`. */
const stage = async (standardsName: string, docsName: string): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-dedupe-'));
  const standards = join(root, 'claude-artifacts', 'standards');
  const docsDir = join(root, 'docs');
  await mkdir(standards, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(standards, standardsName), DOC, 'utf8');
  await writeFile(join(docsDir, docsName), DOC, 'utf8');
  return { root, out: join(root, 'out') };
};

const writtenAtoms = async (out: string): Promise<readonly string[]> =>
  [...(await readdir(out))].filter(name => name !== ATOMS_OWNER_FILE).sort();

const ALPHA_ID = 'alpha-doc-shared-title';
const ZETA_ID = 'zeta-doc-shared-title';

describe('exact-body dedupe', () => {
  it('keeps the same copy however the mirrored pair is spread over the corpus roots', async () => {
    const zetaInStandards = await stage('zeta-doc.md', 'alpha-doc.md');
    const alphaInStandards = await stage('alpha-doc.md', 'zeta-doc.md');

    await ingest({ corpusRoots: [...ROOTS], outputDir: zetaInStandards.out, repoRoot: zetaInStandards.root });
    await ingest({ corpusRoots: [...ROOTS], outputDir: alphaInStandards.out, repoRoot: alphaInStandards.root });

    expect(await writtenAtoms(zetaInStandards.out)).toEqual([`${ALPHA_ID}.md`]);
    expect(await writtenAtoms(alphaInStandards.out)).toEqual([`${ALPHA_ID}.md`]);
  });

  it('keeps the copy the golden set judges when one is named', async () => {
    const fixture = await stage('alpha-doc.md', 'zeta-doc.md');

    const summary = await ingest({
      corpusRoots: [...ROOTS],
      outputDir: fixture.out,
      repoRoot: fixture.root,
      goldIds: [ZETA_ID],
    });

    expect(await writtenAtoms(fixture.out)).toEqual([`${ZETA_ID}.md`]);
    expect(summary.duplicates).toBe(1);
    expect(summary.skipped.map(skip => skip.reasons.join(''))).toEqual([
      `duplicate-body-of:${ZETA_ID}`,
    ]);
  });

  it('ignores a gold id that names no member of the duplicate group', async () => {
    const fixture = await stage('alpha-doc.md', 'zeta-doc.md');

    await ingest({
      corpusRoots: [...ROOTS],
      outputDir: fixture.out,
      repoRoot: fixture.root,
      goldIds: ['some-other-atom'],
    });

    expect(await writtenAtoms(fixture.out)).toEqual([`${ALPHA_ID}.md`]);
  });

  it('keeps BOTH judged copies when the duplicate group holds two judged documents', async () => {
    const fixture = await stage('alpha-doc.md', 'zeta-doc.md');

    const summary = await ingest({
      corpusRoots: [...ROOTS],
      outputDir: fixture.out,
      repoRoot: fixture.root,
      goldIds: [ALPHA_ID, ZETA_ID],
    });

    expect(await writtenAtoms(fixture.out)).toEqual([`${ALPHA_ID}.md`, `${ZETA_ID}.md`]);
    expect(summary.duplicates).toBe(0);
  });

  it('drops the unjudged mirror of a double-gold group, keeping one atom per judged document', async () => {
    const fixture = await stage('alpha-doc.md', 'zeta-doc.md');
    await writeFile(join(fixture.root, 'docs', 'mu-doc.md'), DOC, 'utf8');

    const summary = await ingest({
      corpusRoots: [...ROOTS],
      outputDir: fixture.out,
      repoRoot: fixture.root,
      goldIds: [ALPHA_ID, ZETA_ID],
    });

    expect(await writtenAtoms(fixture.out)).toEqual([`${ALPHA_ID}.md`, `${ZETA_ID}.md`]);
    expect(summary.duplicates).toBe(1);
    expect(summary.skipped.map(skip => skip.reasons.join(''))).toEqual([
      `duplicate-body-of:${ALPHA_ID}`,
    ]);
  });
});

/**
 * The same property, measured through the CLI COMMAND rather than through
 * `ingest` directly: the pure function honoured `goldIds` from the start, and
 * the defect was that the production `gnosis -- ingest` path never supplied
 * them, so it deduped gold-blind and orphaned judged documents.
 */
const GOLD_STEM = '60-debugging';
const GOLD_HEADING = 'Debugging';
const GOLD_ID = `${GOLD_STEM}-debugging`;
const MIRROR_ID = `00-mirror-${GOLD_HEADING.toLowerCase()}`;

const GOLD_DOC = `# ${GOLD_HEADING}\n\n${SHARED_BODY}\n`;

/** The JUDGED copy sorts SECOND by source path, so path order alone would drop it. */
const stageJudgedSecond = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-cli-gold-'));
  const standards = join(root, 'claude-artifacts', 'standards');
  const docsDir = join(root, 'docs');
  await mkdir(standards, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(standards, '00-mirror.md'), GOLD_DOC, 'utf8');
  await writeFile(join(docsDir, `${GOLD_STEM}.md`), GOLD_DOC, 'utf8');
  return { root, out: join(root, 'out') };
};

const contextFor = (fixture: Fixture): CommandContext => ({
  positionals: [],
  flags: {},
  adapter: DEFAULT_ADAPTER,
  atomsDir: fixture.out,
  indexPath: join(fixture.root, 'index'),
  repoRoot: fixture.root,
  corpusRoots: [...ROOTS],
  profile: DEFAULT_INGEST_PROFILE,
});

describe('CLI ingest dedupe', () => {
  it('keeps the judged copy of a byte-identical group', async () => {
    expect(loadJudgedAtomIds()).toContain(GOLD_ID);
    const fixture = await stageJudgedSecond();

    await runIngestCommand(contextFor(fixture));

    expect(await writtenAtoms(fixture.out)).toEqual([`${GOLD_ID}.md`]);
    expect(await writtenAtoms(fixture.out)).not.toContain(`${MIRROR_ID}.md`);
  });
});
