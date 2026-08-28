import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_ADAPTER } from '../src/cli/adapter.js';
import { FLAGS } from '../src/cli/args.js';
import type { CommandContext } from '../src/cli/context.js';
import { GOLD_IDS_FLAG, runIngestCommand } from '../src/cli/ingestCommand.js';
import { EXIT_PARTIAL } from '../src/cli/outcome.js';
import { loadJudgedAtomIds } from '../src/goldenIds.js';
import { ATOMS_OWNER_FILE } from '../src/ingest.js';
import { goldenDir, ingestProfilePath } from '../src/paths.js';
import { activeProfile } from '../src/vocabulary.js';

/**
 * The gold source ingest dedupes against is a SHIPPED-PATH INPUT, and it used to
 * be an invisible default: `loadJudgedAtomIds()` read `golden/` with nobody
 * naming it, and every read error was swallowed. Deleting the directory did not
 * fail — it changed which copy of a byte-identical pair survives, and therefore
 * which SOURCE FILE counts as gold.
 *
 * The two arms below are the whole property: PRESENT resolves the atom set it
 * always did, ABSENT-BUT-REQUESTED refuses and names the path. There is no third
 * arm in which the difference is silent.
 */
const SHARED_BODY =
  'the debugging rules describe how an investigation is bounded, which evidence is admissible, and ' +
  'when an escalation is mandatory, and this paragraph is long enough on its own to clear both the ' +
  'chunker fold threshold and the exact-body dedupe floor so the two mirrored copies below form one ' +
  'byte-identical duplicate group rather than two independent atoms of the corpus';

const ROOTS = ['claude-artifacts/standards', 'docs'] as const;

const GOLD_STEM = '60-debugging';
const GOLD_ID = `${GOLD_STEM}-debugging`;
const GOLD_DOC = `# Debugging\n\n${SHARED_BODY}\n`;

interface Fixture {
  readonly root: string;
  readonly out: string;
}

/** The JUDGED copy sorts SECOND by source path, so path order alone would drop it. */
const stageJudgedSecond = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-gold-source-'));
  const standards = join(root, 'claude-artifacts', 'standards');
  const docsDir = join(root, 'docs');
  await mkdir(standards, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(standards, '00-mirror.md'), GOLD_DOC, 'utf8');
  await writeFile(join(docsDir, `${GOLD_STEM}.md`), GOLD_DOC, 'utf8');
  return { root, out: join(root, 'out') };
};

const writtenAtoms = async (out: string): Promise<readonly string[]> =>
  [...(await readdir(out))].filter(name => name !== ATOMS_OWNER_FILE).sort();

const contextFor = (fixture: Fixture, flags: Record<string, string>): CommandContext => ({
  positionals: [],
  flags,
  adapter: DEFAULT_ADAPTER,
  atomsDir: fixture.out,
  indexPath: join(fixture.root, 'index'),
  repoRoot: fixture.root,
  profilePath: ingestProfilePath(),
  corpusRoots: [...ROOTS],
  profile: activeProfile(),
});

describe('the ingest gold source is named, never defaulted invisibly', () => {
  it('is DECLARED by the shipped profile, and resolves what it resolved before', () => {
    expect(activeProfile().goldIdsPath).toBe(goldenDir());
    expect(loadJudgedAtomIds(goldenDir())).toContain(GOLD_ID);
  });

  it('keeps the judged copy when the declared gold source is present', async () => {
    const fixture = await stageJudgedSecond();

    await runIngestCommand(contextFor(fixture, {}));

    expect(await writtenAtoms(fixture.out)).toEqual([`${GOLD_ID}.md`]);
  });

  it('REFUSES with exit 3 naming the path when a requested gold source cannot be read', async () => {
    const fixture = await stageJudgedSecond();
    const missing = join(fixture.root, 'no-such-golden');

    const outcome = await runIngestCommand(contextFor(fixture, { [GOLD_IDS_FLAG]: missing }));

    expect(outcome.exitCode).toBe(EXIT_PARTIAL);
    expect(outcome.text).toContain(missing);
    await expect(readdir(fixture.out)).rejects.toThrow();
  });

  it('is a real value flag of the CLI vocabulary', () => {
    expect(FLAGS[GOLD_IDS_FLAG]).toEqual({ kind: 'value', placeholder: '<dir|file>' });
  });
});
