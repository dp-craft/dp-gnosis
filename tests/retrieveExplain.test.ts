/**
 * INTERPRETABLE retrieval scores — why an atom is in the answer, not just where.
 *
 * Two halves. The pure half (`src/cli/explain.ts`) decides WHICH query terms an
 * atom actually carries, WHICH ≤400-char window carries the most of them, and
 * how a score reads against the other atoms in the same answer. The CLI half
 * puts those on the `--json` payload and the raw cross-encoder score on the text
 * line.
 *
 * The load-bearing assertion is the LAST describe: the ranking ORDER is
 * unchanged by any of it, reranked and not. The reranked order is pinned against
 * `fuseRanking` itself as the oracle, so a regression that reordered the answer
 * while carrying the new fields fails here rather than being read as an
 * improvement.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { explainAtoms, matchedTerms, snippetOf } from '../src/cli/explain.js';
import { RERANK_FUSION_PRESETS, RERANK_MODEL_ID } from '../src/config.js';
import type { RetrievedAtom } from '../src/port.js';
import { analyze } from '../src/query.js';
import { fuseRanking, resetRerankProbeCache } from '../src/rerank.js';

const SNIPPET_MAX = 400;

const stem = (word: string): string => analyze(word)[0] ?? '';

describe('matchedTerms — the ANALYSED overlap, in query order', () => {
  it('keeps only the query terms the body carries, stemmed', () => {
    const terms = matchedTerms('zestful retrievals for pineapple', 'one zestful retrieval over atoms');

    expect(terms).toEqual([stem('zestful'), stem('retrieval')]);
  });

  it('dedupes a repeated query term rather than counting it twice', () => {
    expect(matchedTerms('retrieval retrievals retrieved', 'retrieval')).toEqual([stem('retrieval')]);
  });

  it('is empty when the body carries none of them', () => {
    expect(matchedTerms('pineapple', 'one zestful retrieval over atoms')).toEqual([]);
  });
});

const FILLER = 'padding sentence about other things ';

/** One isolated hit at the head, then a dense cluster far beyond one window. */
const CLUSTERED_BODY =
  `zestful ${FILLER.repeat(20)}retrieval of retrieval by retrieval ${FILLER.repeat(5)}`;

describe('snippetOf — the densest ≤400-char window', () => {
  it('picks the window holding the most matched-term occurrences', () => {
    const snippet = snippetOf(CLUSTERED_BODY, [stem('retrieval'), stem('zestful')]);

    expect(snippet).toContain('retrieval of retrieval by retrieval');
    expect(snippet.startsWith('zestful')).toBe(false);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(CLUSTERED_BODY).toContain(snippet);
  });

  it('falls back to the head of the body when nothing matched', () => {
    expect(snippetOf(CLUSTERED_BODY, [])).toBe(CLUSTERED_BODY.slice(0, SNIPPET_MAX));
  });

  it('is never longer than the body — a body that already fits IS the window', () => {
    const short = 'a zestful retrieval';

    expect(snippetOf(short, [stem('retrieval')])).toBe(short);
    expect(snippetOf(short, [])).toBe(short);
  });

  it('snaps both ends to whitespace rather than cutting a word', () => {
    const snippet = snippetOf(CLUSTERED_BODY, [stem('retrieval')]);
    const start = CLUSTERED_BODY.indexOf(snippet);

    expect(start === 0 || /\s/.test(CLUSTERED_BODY[start - 1] ?? '')).toBe(true);
    const after = CLUSTERED_BODY[start + snippet.length];
    expect(after === undefined || /\s/.test(after)).toBe(true);
  });

  it('breaks a tie by taking the EARLIEST window', () => {
    // Two lone occurrences, further apart than one window: neither window can
    // hold both, so the counts tie and the earliest must win.
    const body = `retrieval${'x '.repeat(SNIPPET_MAX)}retrieval`;

    const snippet = snippetOf(body, [stem('retrieval')]);

    expect(snippet.startsWith('retrieval')).toBe(true);
    expect(snippet.indexOf('retrieval', 1)).toBe(-1);
  });
});

const atom = (id: string, score: number): RetrievedAtom => ({
  id,
  title: id,
  domain: 'docs',
  type: 'knowledge',
  body: 'a zestful retrieval of atoms',
  score,
  sourcePath: `/tmp/${id}.md`,
  originPaths: [],
});

describe('explainAtoms — scoreNormalised over the RETURNED atoms', () => {
  it('min-maxes the returned scores', () => {
    const explained = explainAtoms('retrieval', [atom('a', 3), atom('b', 2), atom('c', 1)]);

    expect(explained.map(entry => entry.scoreNormalised)).toEqual([1, 0.5, 0]);
  });

  it('reports null for a single atom — one score carries no relative signal', () => {
    expect(explainAtoms('retrieval', [atom('a', 3)])[0]?.scoreNormalised).toBeNull();
  });

  it('reports null for a FLAT set rather than calling every atom a 1', () => {
    const explained = explainAtoms('retrieval', [atom('a', 2), atom('b', 2)]);

    expect(explained.map(entry => entry.scoreNormalised)).toEqual([null, null]);
  });
});

const LABELS = ['Alpha', 'Bravo', 'Delta', 'Gamma'] as const;

const body = (repeats: number): string =>
  'zestful retrieval '.repeat(repeats).padEnd(400, 'x padding sentence about other things ');

const doc = (label: string, repeats: number): string =>
  `# Zestful Retrieval ${label}\n\n${body(repeats)}\n`;

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-explain-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await Promise.all(
    LABELS.map((label, index) =>
      writeFile(join(corpus, `${label}.md`), doc(label, index + 2), 'utf8')
    )
  );
  await runCli(['ingest', '--atoms-dir', join(repoRoot, 'atoms'), '--repo-root', repoRoot]);
  return { repoRoot, atomsDir: join(repoRoot, 'atoms') };
};

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const retrieve = async (fixture: Fixture, extra: readonly string[]): Promise<CliResult> =>
  await runCli([
    'retrieve',
    'zestful retrieval',
    '--adapter',
    'linear',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    ...extra,
  ]);

interface JsonAtom {
  readonly id: string;
  readonly body: string;
  readonly score: number;
  readonly firstPassScore?: number;
  readonly rerankScore?: number;
  readonly matchedTerms: readonly string[];
  readonly snippet: string;
  readonly scoreNormalised: number | null;
}

interface JsonPayload {
  readonly atoms: readonly JsonAtom[];
  readonly count: number;
  readonly poolSize: number;
  readonly mode: string;
}

const parsePayload = (stdout: string): JsonPayload => JSON.parse(stdout) as JsonPayload;

const json = async (fixture: Fixture, extra: readonly string[]): Promise<JsonPayload> =>
  parsePayload((await retrieve(fixture, ['--json', ...extra])).stdout);

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const PROBE_MARKER = 'BM25';

const queryOf = (init: { readonly body?: string } | undefined): string =>
  String(JSON.parse(String(init?.body ?? '{}'))['query'] ?? '');

const HEALTHY_PROBE = [
  { index: 0, relevance_score: 2.07 },
  { index: 1, relevance_score: -11 },
];

/** `order` lists first-pass indices best-first; position p scores `1 - p/10`. */
const RERANK_ORDER = [1, 2, 3, 0] as const;

const rawScoreAt = (position: number): number => 1 - position * 0.1;

const stubServer = (): void => {
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
      if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
      if (queryOf(init).includes(PROBE_MARKER)) return okResponse({ results: HEALTHY_PROBE });
      return okResponse({
        results: RERANK_ORDER.map((index, position) => ({
          index,
          relevance_score: rawScoreAt(position),
        })),
      });
    }
  );
};

describe('retrieve --json — the interpretability fields', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('carries matchedTerms, a snippet and scoreNormalised on every atom', async () => {
    const payload = await json(await makeFixture(), []);

    expect(payload.atoms.length).toBeGreaterThan(1);
    payload.atoms.forEach(entry => {
      expect(entry.matchedTerms).toContain(stem('zestful'));
      expect(entry.body).toContain(entry.snippet);
      expect(entry.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    });
    expect(payload.atoms[0]?.scoreNormalised).toBe(1);
  });

  it('reports poolSize as the FIRST PASS size, before the -k slice', async () => {
    const fixture = await makeFixture();

    const plain = await json(fixture, ['-k', '2']);
    stubServer();
    const reranked = await json(fixture, ['-k', '2', '--rerank']);

    // Without --rerank the port is asked for `k`, so the pool IS the answer.
    expect(plain.count).toBe(2);
    expect(plain.poolSize).toBe(2);
    // With --rerank the pool is the RERANK_K_INIT floor — the whole corpus here
    // — and `-k` cuts it afterwards. That gap is what poolSize exists to report.
    expect(reranked.count).toBe(2);
    expect(reranked.poolSize).toBe(LABELS.length);
  });

  it('omits firstPassScore and rerankScore on a run that did not rerank', async () => {
    const payload = await json(await makeFixture(), []);

    payload.atoms.forEach(entry => {
      expect(entry.firstPassScore).toBeUndefined();
      expect(entry.rerankScore).toBeUndefined();
    });
  });

  it('carries the first-pass and the RAW cross-encoder score on a reranked run', async () => {
    const fixture = await makeFixture();
    const baseline = await json(fixture, []);
    stubServer();

    const reranked = await json(fixture, ['--rerank']);

    const firstPass = new Map(baseline.atoms.map(entry => [entry.id, entry.score]));
    reranked.atoms.forEach(entry => {
      expect(entry.firstPassScore).toBe(firstPass.get(entry.id));
    });
    const ids = baseline.atoms.map(entry => entry.id);
    const rawById = new Map(
      RERANK_ORDER.map((index, position) => [ids[index], rawScoreAt(position)])
    );
    reranked.atoms.forEach(entry => {
      expect(entry.rerankScore).toBeCloseTo(rawById.get(entry.id) ?? 0, 10);
    });
  });
});

describe('retrieve --format text — the rerank score on the hit line', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const hitLines = (stdout: string): readonly string[] =>
    stdout.split('\n').filter(line => /^ {2}\d+\.\d{4}/.test(line));

  it('leaves an un-reranked hit line in the ORIGINAL shape', async () => {
    const lines = hitLines((await retrieve(await makeFixture(), [])).stdout);

    expect(lines.length).toBeGreaterThan(0);
    lines.forEach(line => {
      expect(line).toMatch(/^ {2}\d+\.\d{4} {2}[^\s]+ {2}\[[a-z-]+] {2}.+$/);
      expect(line).not.toContain('rerank');
    });
  });

  it('adds the raw rerank score to every reranked hit line', async () => {
    const fixture = await makeFixture();
    stubServer();

    const lines = hitLines((await retrieve(fixture, ['--rerank'])).stdout);

    expect(lines.length).toBe(LABELS.length);
    lines.forEach(line => expect(line).toMatch(/^ {2}\d+\.\d{4} {2}rerank {2}-?\d+\.\d{4} {2}/));
    expect(lines[0]).toContain(`rerank  ${rawScoreAt(0).toFixed(4)}`);
  });

  it('leaves --format xml untouched by the rerank', async () => {
    const fixture = await makeFixture();
    stubServer();

    const xml = (await retrieve(fixture, ['--rerank', '--format', 'xml'])).stdout;

    const documents = xml.split('\n').filter(line => line.startsWith('  <document'));
    expect(documents).toHaveLength(LABELS.length);
    documents.forEach(line =>
      expect(line).toMatch(/^ {2}<document id="[^"]+" score="\d+\.\d{4}" domain="[^"]+">$/)
    );
    // `mode="linear+rerank"` is the ONLY place the word may appear: no score,
    // no term and no snippet reaches this rendering.
    expect(xml).not.toContain('rerankScore');
    expect(xml).not.toContain('matchedTerms');
    expect(xml).not.toContain('snippet');
  });
});

describe('the ranking ORDER is unchanged by any of it', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reranked: the order and the score are exactly fuseRanking over the first pass', async () => {
    const fixture = await makeFixture();
    const baseline = await json(fixture, []);
    stubServer();

    const reranked = await json(fixture, ['--rerank']);

    const oracle = fuseRanking(
      baseline.atoms.map(entry => entry.id),
      [...RERANK_ORDER],
      RERANK_FUSION_PRESETS.shipped
    );
    expect(reranked.atoms.map(entry => entry.id)).toEqual(oracle.map(entry => entry.item));
    reranked.atoms.forEach((entry, index) => {
      expect(entry.score).toBeCloseTo(oracle[index]?.score ?? 0, 12);
    });
    expect(reranked.mode).toContain('+rerank');
  });

  it('un-reranked: the order and the score are the first pass, untouched', async () => {
    const fixture = await makeFixture();
    const baseline = await json(fixture, []);

    const again = await json(fixture, []);

    expect(again.atoms.map(entry => entry.id)).toEqual(baseline.atoms.map(entry => entry.id));
    expect(again.atoms.map(entry => entry.score)).toEqual(
      [...baseline.atoms].map(entry => entry.score)
    );
    expect([...again.atoms].sort((l, r) => r.score - l.score).map(entry => entry.id)).toEqual(
      again.atoms.map(entry => entry.id)
    );
  });
});
