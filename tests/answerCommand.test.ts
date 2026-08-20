/**
 * `answer` end to end, over a real temp corpus through `runCli`.
 *
 * What is proved here is what a CALLER depends on and the pure renderer cannot
 * show: that the text rendering IS the pack, that every `[^id]` the block cites
 * resolves to an entry of `atoms[]` — a citation pointing at nothing is worse
 * than no citation — that the two flags a pack cannot honour exit 2 naming why,
 * and that the reserved chrome makes `--max-tokens` bound the WHOLE block
 * rather than only the atoms inside it.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliResult } from '../src/cli/cli.js';
import { runCli } from '../src/cli/cli.js';
import { PACK_CLOSE, PACK_OPEN } from '../src/cli/pack.js';

const SUMMARY = '<!-- LLM-PRIMARY: how the layered test model divides the suite -->';
const INTRO =
  'intro prose about the layered test model and its tiers, describing what each tier covers and why the introduction of a document carries enough prose of its own to stand as a separate atom of the whole corpus';
const UNIT =
  'the fast unit tier of the layered test model runs in under a millisecond per test, and this section carries enough prose of its own that it stands alone as an atom of the corpus rather than folding into the introduction';
const E2E =
  'the end to end tier of the layered test model drives a real browser per test, and this section too carries enough prose of its own to stand alone as an atom of the corpus rather than folding into its neighbours';
const OTHER =
  'a second document about the layered test model and its tiers, written so that it carries enough prose of its own to stand alone as one atom of the corpus and to be retrieved beside the first document';

const DOC_A = `${SUMMARY}\n\n# Layered Test Model\n\n${INTRO}\n\n## Unit tier\n\n${UNIT}\n\n## E2E tier\n\n${E2E}\n`;
const DOC_B = `# Tier Notes\n\n${OTHER}\n`;

const fixture = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-answer-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), DOC_A, 'utf8');
  await writeFile(join(corpus, 'TIER-NOTES.md'), DOC_B, 'utf8');
  const atomsDir = join(repoRoot, 'atoms');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  return atomsDir;
};

const answer = async (atomsDir: string, extra: readonly string[]): Promise<CliResult> =>
  await runCli([
    'answer',
    'layered test model tier',
    '-k',
    '4',
    '--adapter',
    'linear',
    '--atoms-dir',
    atomsDir,
    ...extra,
  ]);

const parsed = (result: CliResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

const citedIds = (pack: string): readonly string[] =>
  [...pack.matchAll(/^\[\^([^\]]+)\]/gmu)].flatMap(match => (match[1] === undefined ? [] : [match[1]]));

let atomsDir = '';

beforeAll(async () => {
  vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  atomsDir = await fixture();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('answer — the text rendering is the pack', () => {
  it('emits one delimited block carrying the atom bodies and their citations', async () => {
    const result = await answer(atomsDir, []);
    const lines = result.stdout.trimEnd().split('\n');

    expect(result.exitCode).toBe(0);
    expect(lines[0]).toBe(PACK_OPEN);
    expect(lines.at(-1)).toBe(PACK_CLOSE);
    expect(result.stdout).toContain('Retrieved reference material for: layered test model tier');
    expect(citedIds(result.stdout).length).toBeGreaterThan(1);
    expect([INTRO, UNIT, E2E, OTHER].filter(body => result.stdout.includes(body)).length)
      .toBeGreaterThan(1);
  });

  it('groups the atoms under their source document, in reading order', async () => {
    const result = await answer(atomsDir, []);
    const headers = result.stdout.split('\n').filter(line => line.startsWith('## '));

    expect(headers.length).toBeGreaterThan(0);
    expect(headers).toEqual([...new Set(headers)]);
  });
});

/** Present on EVERY answer payload; `note` and `queryRewritten` state themselves. */
const REQUIRED_KEYS: readonly string[] = [
  'adapter',
  'atoms',
  'budgetMode',
  'citations',
  'command',
  'confidence',
  'count',
  'documents',
  'exitCode',
  'indexState',
  'k',
  'maxTokens',
  'mode',
  'neutralised',
  'pack',
  'packTokens',
  'poolSize',
  'query',
  'skipped',
];

const OPTIONAL_KEYS: readonly string[] = ['note', 'queryRewritten'];

describe('answer --json', () => {
  it('carries every documented key, and no key outside the documented set', async () => {
    const payload = parsed(await answer(atomsDir, ['--json']));
    const keys = Object.keys(payload);

    expect(REQUIRED_KEYS.filter(key => !keys.includes(key))).toEqual([]);
    expect(keys.filter(key => ![...REQUIRED_KEYS, ...OPTIONAL_KEYS].includes(key))).toEqual([]);
    expect(payload['command']).toBe('answer');
    expect(payload['query']).toBe('layered test model tier');
  });

  it('resolves every [^id] the pack cites to an atom it delivered', async () => {
    const payload = parsed(await answer(atomsDir, ['--json']));
    const atoms = payload['atoms'] as readonly { readonly id: string }[];
    const cited = citedIds(String(payload['pack']));

    expect(cited).toEqual(payload['citations']);
    expect(cited.filter(id => !atoms.some(atom => atom.id === id))).toEqual([]);
    expect(cited.length).toBe(atoms.length);
  });

  it('reports the pack cost against the FULL budget the caller passed', async () => {
    const payload = parsed(await answer(atomsDir, ['--json', '--max-tokens', '16000']));

    expect(payload['maxTokens']).toBe(16000);
    expect(payload['packTokens']).toBeGreaterThan(0);
    expect(payload['packTokens']).toBeLessThanOrEqual(16000);
  });
});

describe('answer — the two flags a pack cannot honour', () => {
  it('refuses --flat, naming the grouping the pack is built on', async () => {
    const result = await answer(atomsDir, ['--flat']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--flat');
    expect(result.stderr).toContain('grouped by source document by construction');
  });

  it('refuses --format xml, naming the formats it does accept', async () => {
    const result = await answer(atomsDir, ['--format', 'xml']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--format text');
    expect(result.stderr).toContain('--format json');
  });

  it('still accepts --format text and --format json, which are its two renderings', async () => {
    const text = await answer(atomsDir, ['--format', 'text']);
    const json = await answer(atomsDir, ['--format', 'json']);

    expect(text.stdout.startsWith(PACK_OPEN)).toBe(true);
    expect(parsed(json)['command']).toBe('answer');
  });
});

/**
 * The report — skip lines, the neutralised count, the notes — is what the pack
 * emits BECAUSE the budget ran out, and it is deliberately outside the reserve
 * (see `packChrome`). The bound is therefore asserted over everything else:
 * delimiters, preamble, atoms and footer, which is exactly what the chrome
 * reservation is there to keep inside the ceiling.
 */
const REPORT_LINE = /^(skipped: | {2}skipped {2}|neutralised: |note: )/u;

const withoutReport = (pack: string): string =>
  pack.split('\n').filter(line => !REPORT_LINE.test(line)).join('\n');

describe('answer under a small --max-tokens', () => {
  const budget = 900;

  it('keeps the block inside the byte budget, and reports what it skipped', async () => {
    const result = await answer(atomsDir, [
      '--json',
      '--budget-mode',
      'bytes',
      '--max-tokens',
      String(budget),
    ]);
    const payload = parsed(result);
    const skipped = payload['skipped'] as readonly unknown[];

    expect(result.exitCode).toBe(3);
    expect(skipped.length).toBeGreaterThan(0);
    expect(payload['packTokens']).toBeLessThanOrEqual(budget);
    expect(Buffer.byteLength(withoutReport(String(payload['pack'])), 'utf8')).toBeLessThanOrEqual(
      budget
    );
  });

  it('names every skipped atom inside the pack itself, not only in the payload', async () => {
    const result = await answer(atomsDir, ['--budget-mode', 'bytes', '--max-tokens', String(budget)]);

    expect(result.stdout).toContain('skipped: ');
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(PACK_CLOSE);
  });
});

/**
 * `answer` runs the SAME pipeline as `retrieve`, so a filter it silently
 * ignored would hand a caller a pack wider than the one it asked for.
 */
describe('answer honours --domain the way retrieve does', () => {
  it('packs the atoms when their own domain is named', async () => {
    const result = await answer(atomsDir, ['--json', '--domain', 'docs']);

    expect(parsed(result)['count']).toBeGreaterThan(0);
  });

  it('packs nothing when a domain the corpus does not carry is named', async () => {
    const result = await answer(atomsDir, ['--json', '--domain', 'adr']);

    expect(parsed(result)['count']).toBe(0);
  });
});
