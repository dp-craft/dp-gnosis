/**
 * `answer --synthesize` — the OPT-IN answer synthesiser.
 *
 * No live server is required: `fetch` is stubbed, so both llama-swap calls
 * (`GET /v1/models` and `POST /v1/chat/completions`) are answered in-process.
 *
 * The property asserted hardest is the hard fail: an answer citing a footnote
 * id the pack does not contain reaches NEITHER rendering. A fabricated `[^id]`
 * reads exactly like a sourced claim, so showing it under a success code is
 * the one outcome this flag may never produce. Beside it sit the two other
 * outcomes (`INSUFFICIENT`, a valid answer above the pack) and the guarantee
 * that with the flag absent the pack is byte-identical and no call is made.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliResult } from '../src/cli/cli.js';
import { runCli } from '../src/cli/cli.js';
import { SYNTHESIZE_MODEL_ID } from '../src/config.js';

const INTRO =
  'intro prose about the layered test model and its tiers, describing what each tier covers and why the introduction of a document carries enough prose of its own to stand as a separate atom of the whole corpus';
const UNIT =
  'the fast unit tier of the layered test model runs in under a millisecond per test, and this section carries enough prose of its own that it stands alone as an atom of the corpus rather than folding into the introduction';
const OTHER =
  'a second document about the layered test model and its tiers, written so that it carries enough prose of its own to stand alone as one atom of the corpus and to be retrieved beside the first document';

const DOC_A = `# Layered Test Model\n\n${INTRO}\n\n## Unit tier\n\n${UNIT}\n`;
const DOC_B = `# Tier Notes\n\n${OTHER}\n`;

const fixture = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-synth-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), DOC_A, 'utf8');
  await writeFile(join(corpus, 'TIER-NOTES.md'), DOC_B, 'utf8');
  const atomsDir = join(repoRoot, 'atoms');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  return atomsDir;
};

const answer = async (extra: readonly string[]): Promise<CliResult> =>
  await runCli([
    'answer',
    'layered test model tier',
    '-k',
    '3',
    '--adapter',
    'linear',
    '--atoms-dir',
    atomsDir,
    ...extra,
  ]);

interface JsonPayload {
  readonly synthesized?: boolean;
  readonly answer?: string | null;
  readonly note?: string;
  readonly pack?: string;
  readonly citations?: readonly string[];
}

/** Every synthesising case passes the flag; the byte-identity case never does. */
const synthesized = async (extra: readonly string[]): Promise<CliResult> =>
  await answer(['--synthesize', ...extra]);

const parsed = (result: CliResult): JsonPayload => JSON.parse(result.stdout) as JsonPayload;

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const completion = (content: string): unknown => ({
  choices: [{ message: { role: 'assistant', content } }],
});

interface Recorded {
  readonly urls: string[];
  readonly bodies: string[];
}

/** Answers both llama-swap endpoints, recording every URL and every chat body. */
const stubServer = (models: readonly string[], content: string): Recorded => {
  const recorded: Recorded = { urls: [], bodies: [] };
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }): Promise<unknown> => {
    recorded.urls.push(url);
    if (url.endsWith('/v1/models')) return okResponse({ data: models.map(id => ({ id })) });
    recorded.bodies.push(init?.body ?? '');
    return okResponse(completion(content));
  });
  return recorded;
};

let atomsDir = '';
let firstCitation = '';
let plainText = '';

beforeAll(async () => {
  vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  atomsDir = await fixture();
  const baseline = await answer(['--json']);
  firstCitation = parsed(baseline).citations?.[0] ?? '';
  plainText = (await answer([])).stdout;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('--synthesize — a fabricated citation is a hard fail', () => {
  const FAKE = 'not-a-real-atom-id';
  const FABRICATED = `The unit tier runs in under a millisecond [^${FAKE}].`;

  it('renders the answer NOWHERE, names the offending id and exits 3', async () => {
    stubServer([SYNTHESIZE_MODEL_ID], FABRICATED);
    const result = await synthesized(['--json']);
    const payload = parsed(result);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).not.toContain(FABRICATED);
    expect(payload.answer).toBeNull();
    expect(payload.synthesized).toBe(false);
    expect(payload.pack).not.toContain(FABRICATED);
    expect(payload.note).toContain(FAKE);
  });

  it('keeps it out of the text rendering too, which shows the pack alone', async () => {
    stubServer([SYNTHESIZE_MODEL_ID], FABRICATED);
    const result = await synthesized([]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).not.toContain(FABRICATED);
    expect(result.stdout).toContain(FAKE);
    expect(result.stdout).toContain('<<<GNOSIS-KNOWLEDGE-PACK>>>');
  });
});

describe('--synthesize — the two answers that are rendered', () => {
  it('treats INSUFFICIENT as a valid answer needing no citation: exit 0', async () => {
    stubServer([SYNTHESIZE_MODEL_ID], 'INSUFFICIENT');
    const result = await synthesized(['--json']);
    const payload = parsed(result);

    expect(result.exitCode).toBe(0);
    expect(payload.answer).toBe('INSUFFICIENT');
    expect(payload.synthesized).toBe(true);
    expect(payload.note).toBeUndefined();
  });

  it('renders a validly cited answer ABOVE the pack, exit 0', async () => {
    const content = `The unit tier runs in under a millisecond [^${firstCitation}].`;
    stubServer([SYNTHESIZE_MODEL_ID], content);
    const result = await synthesized([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${content}\n\n${plainText}`);
  });
});

describe('--synthesize — refusals', () => {
  it('refuses an EMPTY content naming the thinking-mode cause, exit 3', async () => {
    stubServer([SYNTHESIZE_MODEL_ID], '');
    const result = await synthesized(['--json']);
    const payload = parsed(result);

    expect(result.exitCode).toBe(3);
    expect(payload.synthesized).toBe(false);
    expect(payload.answer).toBeNull();
    expect(payload.note).toContain('reasoning_content');
    expect(payload.note).toContain('enable_thinking');
  });

  it('refuses a model the catalogue does not serve, exit 3', async () => {
    stubServer(['some-other-model'], 'ignored');
    const result = await synthesized(['--json']);

    expect(result.exitCode).toBe(3);
    expect(parsed(result).note).toContain('model not served');
  });
});

describe('--synthesize — the request body', () => {
  it('sends chat_template_kwargs.enable_thinking false, or content comes back empty', async () => {
    const recorded = stubServer([SYNTHESIZE_MODEL_ID], 'INSUFFICIENT');
    await synthesized(['--json']);
    const body = JSON.parse(recorded.bodies[0] ?? '{}') as {
      readonly chat_template_kwargs?: { readonly enable_thinking?: boolean };
      readonly model?: string;
    };

    expect(body.chat_template_kwargs?.enable_thinking).toBe(false);
    expect(body.model).toBe(SYNTHESIZE_MODEL_ID);
  });
});

describe('--synthesize — where the flag is accepted', () => {
  it('is a usage error on retrieve, which has no pack to synthesize over', async () => {
    const result = await runCli([
      'retrieve',
      'layered test model tier',
      '--adapter',
      'linear',
      '--atoms-dir',
      atomsDir,
      '--synthesize',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown flag "--synthesize"');
  });
});

describe('answer WITHOUT the flag', () => {
  it('is byte-identical and calls no server at all', async () => {
    const recorded = stubServer([SYNTHESIZE_MODEL_ID], 'INSUFFICIENT');
    const result = await answer([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(plainText);
    expect(recorded.urls).toEqual([]);
  });
});
