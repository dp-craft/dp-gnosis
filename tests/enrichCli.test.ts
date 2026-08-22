/**
 * The CLI half of enrichment: the `enrich` verb, the four new flags, and the
 * scope each one is honoured in.
 *
 * The rule this file exists to protect is the CLI's oldest one — an unknown
 * flag is a HARD error, never an ignored token. A `--limit` accepted on
 * `retrieve`, or a `--field-weights` accepted on `ingest`, would return a
 * success code for a run that did not do what was asked, which is the worst
 * failure an LLM-driven CLI can have. Every new flag is therefore asserted both
 * where it IS honoured and where it is refused.
 *
 * `fetch` is stubbed: no live server, and the generation path is exercised
 * end-to-end through `runCli`.
 */
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AtomFrontmatter } from '../src/atom.js';
import { serializeAtom } from '../src/atom.js';
import { FLAGS } from '../src/cli/args.js';
import { runCli } from '../src/cli/cli.js';
import {
  defaultEnrichmentPath,
  ENRICH_MODEL_FLAG,
  ENRICHMENT_FILE_NAME,
  ENRICHMENT_FLAG,
  LIMIT_FLAG
} from '../src/cli/enrichCommand.js';
import { EXIT_OK, EXIT_PARTIAL, EXIT_USAGE } from '../src/cli/outcome.js';
import { FIELD_WEIGHTS_FLAG, resolveFieldWeights } from '../src/cli/retrieveCommand.js';
import { DEFAULT_FIELD_WEIGHTS, ENRICH_MODEL_ID, FTS_COLUMNS } from '../src/config.js';
import { ENRICHMENT_PROMPT_VERSION } from '../src/enrichment.js';

const LABELS = ['Alpha', 'Bravo'] as const;

const FIELDS = {
  short: 'A short line.',
  long: 'A longer situating passage naming the section.',
  doc_description: 'The whole document, in one sentence.',
  keywords: ['alpha', 'bravo'],
  questions: ['What is alpha?', 'Why bravo?'],
};

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

/**
 * Atoms are written DIRECTLY rather than ingested: this file is about the CLI's
 * flag surface, and running the real chunker here would make an ingest change
 * able to fail an enrichment test for a reason that has nothing to do with it.
 */
const frontmatter = (label: string): AtomFrontmatter => ({
  type: 'knowledge',
  id: label.toLowerCase(),
  title: `Zestful ${label}`,
  x_domain: 'testing',
  status: 'stable',
  sources: [`doc/${label}.md`],
});

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-enrich-cli-'));
  const atomsDir = join(repoRoot, 'atoms', 'default');
  await mkdir(atomsDir, { recursive: true });
  await Promise.all(
    LABELS.map(async label =>
      await writeFile(
        join(atomsDir, `${label}.md`),
        serializeAtom(frontmatter(label), `${'zestful retrieval '.repeat(40)}\n`),
        'utf8'
      )
    )
  );
  return { repoRoot, atomsDir, indexPath: join(repoRoot, 'index.sqlite') };
};

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

/** Serves the requested generator and answers every generation with `FIELDS`. */
const stubServer = (served: string): void => {
  vi.stubGlobal('fetch', async (url: string): Promise<unknown> =>
    url.endsWith('/v1/models')
      ? okResponse({ data: [{ id: served }] })
      : okResponse({ choices: [{ message: { content: JSON.stringify(FIELDS) } }] })
  );
};

interface Payload {
  readonly exitCode: number;
  readonly command?: string;
  readonly model?: string;
  readonly promptVersion?: number;
  readonly atoms?: number;
  readonly enriched?: number;
  readonly skipped?: number;
  readonly sidecar?: string;
  readonly note?: string;
  readonly error?: string;
}

const enrich = async (fixture: Fixture, extra: readonly string[] = []): Promise<Payload> => {
  const result = await runCli([
    'enrich',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    ...extra,
    '--json',
  ]);
  return JSON.parse(result.stdout) as Payload;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the flag vocabulary grew by exactly the four new flags', () => {
  it.each([FIELD_WEIGHTS_FLAG, ENRICHMENT_FLAG, LIMIT_FLAG, ENRICH_MODEL_FLAG])(
    '%s is a value flag in the closed table',
    flag => {
      expect(FLAGS[flag]).toMatchObject({ kind: 'value' });
    }
  );
});

/** Every `ingest` argv states its own throwaway atoms dir — see `ingestBlastRadius.test.ts`. */
const PINNED_ATOMS_DIR = mkdtempSync(join(tmpdir(), 'gnosis-enrich-cli-pin-'));

describe('each new flag is refused everywhere it cannot be honoured', () => {
  it.each([
    ['retrieve', LIMIT_FLAG, ['retrieve', 'query', LIMIT_FLAG, '1']],
    ['retrieve', ENRICH_MODEL_FLAG, ['retrieve', 'query', ENRICH_MODEL_FLAG, '1']],
    ['retrieve', ENRICHMENT_FLAG, ['retrieve', 'query', ENRICHMENT_FLAG, '1']],
    [
      'ingest (pinned atoms dir)',
      FIELD_WEIGHTS_FLAG,
      ['ingest', '--atoms-dir', PINNED_ATOMS_DIR, 'query', FIELD_WEIGHTS_FLAG, '1'],
    ],
    [
      'ingest (pinned atoms dir)',
      LIMIT_FLAG,
      ['ingest', '--atoms-dir', PINNED_ATOMS_DIR, 'query', LIMIT_FLAG, '1'],
    ],
    ['index', LIMIT_FLAG, ['index', 'query', LIMIT_FLAG, '1']],
    ['bench', ENRICHMENT_FLAG, ['bench', 'query', ENRICHMENT_FLAG, '1']],
    ['enrich', FIELD_WEIGHTS_FLAG, ['enrich', 'query', FIELD_WEIGHTS_FLAG, '1']],
  ])('%s refuses %s with the unknown-flag correction', async (_command, flag, argv) => {
    const result = await runCli(argv as readonly string[]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(`unknown flag "${flag}"`);
  });

  it('honours --enrichment on BOTH sides of the artefact it names', async () => {
    const fixture = await makeFixture();
    const result = await runCli([
      'index',
      '--adapter',
      'fts5',
      '--atoms-dir',
      fixture.atomsDir,
      '--index-path',
      fixture.indexPath,
      ENRICHMENT_FLAG,
      join(fixture.repoRoot, 'absent.jsonl'),
      '--json',
    ]);
    expect(result.exitCode).toBe(EXIT_OK);
  });
});

describe('--field-weights merges OVER the shipped defaults', () => {
  it('leaves every unnamed column at its default', () => {
    const resolved = resolveFieldWeights({ [FIELD_WEIGHTS_FLAG]: 'questions=2' });
    expect(resolved).toEqual({
      ok: true,
      fieldWeights: { ...DEFAULT_FIELD_WEIGHTS, questions: 2 },
    });
  });

  it('returns the shipped defaults when the flag is absent', () => {
    expect(resolveFieldWeights({})).toEqual({ ok: true, fieldWeights: DEFAULT_FIELD_WEIGHTS });
  });

  it('accepts several pairs, and tolerates whitespace around them', () => {
    expect(resolveFieldWeights({ [FIELD_WEIGHTS_FLAG]: ' short=0.5 , keywords=3 ' })).toEqual({
      ok: true,
      fieldWeights: { ...DEFAULT_FIELD_WEIGHTS, short: 0.5, keywords: 3 },
    });
  });

  it('refuses an unknown column, listing the whole fts5 vocabulary', () => {
    const resolved = resolveFieldWeights({ [FIELD_WEIGHTS_FLAG]: 'headline=2' });
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toContain(FTS_COLUMNS.join(', '));
  });

  it('refuses a non-numeric weight rather than scoring by NaN', () => {
    expect(resolveFieldWeights({ [FIELD_WEIGHTS_FLAG]: 'body=lots' }).ok).toBe(false);
  });

  it('refuses a pair with no weight at all', () => {
    expect(resolveFieldWeights({ [FIELD_WEIGHTS_FLAG]: 'body' }).ok).toBe(false);
  });

  it('reaches retrieve as a usage error, exit 2', async () => {
    const fixture = await makeFixture();
    const result = await runCli([
      'retrieve',
      'zestful',
      '--adapter',
      'linear',
      '--atoms-dir',
      fixture.atomsDir,
      FIELD_WEIGHTS_FLAG,
      'headline=2',
    ]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(FIELD_WEIGHTS_FLAG);
  });
});

describe('`enrich` reports the run in the shape a caller reads', () => {
  it('enriches every atom and names the sidecar it wrote', async () => {
    stubServer(ENRICH_MODEL_ID);
    const fixture = await makeFixture();
    const payload = await enrich(fixture);
    expect(payload).toMatchObject({
      exitCode: EXIT_OK,
      command: 'enrich',
      model: ENRICH_MODEL_ID,
      promptVersion: ENRICHMENT_PROMPT_VERSION,
      atoms: 2,
      enriched: 2,
      skipped: 0,
      sidecar: defaultEnrichmentPath(fixture.atomsDir),
    });
  });

  it('defaults the sidecar BESIDE the atoms directory, never inside it', async () => {
    const fixture = await makeFixture();
    expect(defaultEnrichmentPath(fixture.atomsDir)).toBe(
      join(dirname(fixture.atomsDir), ENRICHMENT_FILE_NAME)
    );
  });

  it('writes one JSON line per atom to the file it reported', async () => {
    stubServer(ENRICH_MODEL_ID);
    const fixture = await makeFixture();
    const payload = await enrich(fixture);
    const lines = (await readFile(payload.sidecar ?? '', 'utf8')).split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('honours --enrichment, writing where the caller asked', async () => {
    stubServer(ENRICH_MODEL_ID);
    const fixture = await makeFixture();
    const target = join(fixture.repoRoot, 'sidecars', 'pilot.jsonl');
    const payload = await enrich(fixture, [ENRICHMENT_FLAG, target]);
    expect(payload.sidecar).toBe(target);
    expect((await readFile(target, 'utf8')).length).toBeGreaterThan(0);
  });

  it('honours --limit, leaving the rest for the next run', async () => {
    stubServer(ENRICH_MODEL_ID);
    const fixture = await makeFixture();
    expect(await enrich(fixture, [LIMIT_FLAG, '1'])).toMatchObject({ enriched: 1, atoms: 2 });
  });

  it('skips what is already fresh on a second run', async () => {
    stubServer(ENRICH_MODEL_ID);
    const fixture = await makeFixture();
    await enrich(fixture);
    expect(await enrich(fixture)).toMatchObject({ enriched: 0, skipped: 2, exitCode: EXIT_OK });
  });

  it('honours --enrich-model, and STAMPS the records with the id it used', async () => {
    stubServer('other-generator');
    const fixture = await makeFixture();
    expect(await enrich(fixture, [ENRICH_MODEL_FLAG, 'other-generator'])).toMatchObject({
      model: 'other-generator',
      enriched: 2,
    });
  });
});

describe('a refusal is a PARTIAL result, not a crash', () => {
  it('exits 3 with the refusal in note when the model is not served', async () => {
    stubServer('someone-else');
    const fixture = await makeFixture();
    const payload = await enrich(fixture);
    expect(payload.exitCode).toBe(EXIT_PARTIAL);
    expect(payload.note).toContain('model not served');
    expect(payload).toMatchObject({ enriched: 0 });
  });

  it('refuses a non-positive --limit, naming the correction', async () => {
    const fixture = await makeFixture();
    const result = await runCli([
      'enrich',
      '--atoms-dir',
      fixture.atomsDir,
      LIMIT_FLAG,
      '0',
    ]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(LIMIT_FLAG);
  });

  it('refuses a non-integer --limit before any model is called', async () => {
    const fixture = await makeFixture();
    const result = await runCli(['enrich', '--atoms-dir', fixture.atomsDir, LIMIT_FLAG, '2.5']);
    expect(result.exitCode).toBe(EXIT_USAGE);
  });
});
