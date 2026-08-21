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
import { DEFAULT_MAX_PER_DOC, GROUPED_POOL_FLOOR } from '../src/cli/grouping.js';
import { DEFAULT_EXCLUDED_TYPES, RERANK_FUSION_PRESETS, RERANK_MODEL_ID } from '../src/config.js';
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
    '--no-prf',
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
  readonly confidence: string;
  readonly note?: string;
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

    const plain = await json(fixture, ['-k', '2', '--flat']);
    const grouped = await json(fixture, ['-k', '2']);
    stubServer();
    const reranked = await json(fixture, ['-k', '2', '--rerank']);

    // Ungrouped and un-reranked the port is asked for `k`, so the pool IS the answer.
    expect(plain.count).toBe(2);
    expect(plain.poolSize).toBe(2);
    // GROUPED, the per-document cap subtracts from the pool BEFORE the -k slice —
    // that is what lets a lower-ranked document take a capped atom's slot — so the
    // first pass goes DEEPER: `max(k * maxPerDoc, GROUPED_POOL_FLOOR)`, the floor
    // binding here because 2 * 2 is under it. This corpus is smaller than the
    // floor, so the pool is the whole corpus and poolSize reports that.
    expect(GROUPED_POOL_FLOOR).toBeGreaterThan(2 * DEFAULT_MAX_PER_DOC);
    expect(grouped.count).toBe(2);
    expect(grouped.poolSize).toBe(Math.min(GROUPED_POOL_FLOOR, LABELS.length));
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

  // `--flat` is the pre-grouping rendering: a grouped line carries an `(i/n)`
  // reading-position marker, and tests/grouping.test.ts owns that shape.
  it('leaves an un-reranked hit line in the ORIGINAL shape', async () => {
    const lines = hitLines((await retrieve(await makeFixture(), ['--flat'])).stdout);

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

/**
 * `--min-relevance <p>` — the OPT-IN calibrated floor, and the `confidence`
 * field every rendering now carries.
 *
 * The floor is STRICTLY SUBTRACTIVE: it drops atoms the run already delivered
 * and MUST NOT reorder them, promote one from deeper in the pool, or move
 * `poolSize`. That is what the first test pins, against the unfiltered run of
 * the same fixture as the oracle.
 */
const stubScores = (scores: readonly number[]): void => {
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
      if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
      if (queryOf(init).includes(PROBE_MARKER)) return okResponse({ results: HEALTHY_PROBE });
      return okResponse({
        results: scores.map((score, index) => ({ index, relevance_score: score })),
      });
    }
  );
};

/** The floor that keeps the 1.0 / 0.9 / 0.8 raw scores and drops the 0.7 one. */
const PARTIAL_FLOOR = '0.75';

describe('retrieve --min-relevance — a strictly subtractive floor', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps the delivered atoms in their unfiltered order, and drops the rest', async () => {
    const fixture = await makeFixture();
    stubServer();

    const unfiltered = await json(fixture, ['--rerank']);
    const filtered = await json(fixture, ['--rerank', '--min-relevance', PARTIAL_FLOOR]);

    const survivors = unfiltered.atoms
      .filter(entry => (entry.rerankScore ?? 0) >= Number(PARTIAL_FLOOR))
      .map(entry => entry.id);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThan(unfiltered.atoms.length);
    expect(filtered.atoms.map(entry => entry.id)).toEqual(survivors);
    expect(filtered.count).toBe(survivors.length);
    expect(filtered.poolSize).toBe(unfiltered.poolSize);
  });

  it('delivers nothing, and says so, when the floor drops every atom', async () => {
    const fixture = await makeFixture();
    stubScores([0.1, 0.2, 0.3, 0.4]);

    const payload = await json(fixture, ['--rerank', '--min-relevance', '0.9']);

    expect(payload.atoms).toEqual([]);
    expect(payload.count).toBe(0);
    expect(payload.confidence).toBe('none');
    expect(payload.poolSize).toBe(LABELS.length);
    expect(payload.note ?? '').toContain('0.9');
    expect(payload.note ?? '').toContain(String(LABELS.length));
  });
});

describe('confidence — in all three renderings', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const renderings = async (
    fixture: Fixture,
    extra: readonly string[]
  ): Promise<{ readonly json: string; readonly text: string; readonly xml: string }> => ({
    json: (await json(fixture, extra)).confidence,
    text: (await retrieve(fixture, extra)).stdout,
    xml: (await retrieve(fixture, ['--format', 'xml', ...extra])).stdout,
  });

  it('reads weak with no floor in effect — no calibrated evidence was required', async () => {
    const rendered = await renderings(await makeFixture(), []);

    expect(rendered.json).toBe('weak');
    expect(rendered.text).toContain('retrieve: confidence weak');
    expect(rendered.xml).toContain('confidence="weak"');
  });

  it('reads ok when a floor is in effect and the top atom clears it', async () => {
    const fixture = await makeFixture();
    stubServer();

    const rendered = await renderings(fixture, ['--rerank', '--min-relevance', '0.5']);

    expect(rendered.json).toBe('ok');
    expect(rendered.text).toContain('retrieve: confidence ok');
    expect(rendered.xml).toContain('confidence="ok"');
  });

  it('reads none when the floor delivered nothing', async () => {
    const fixture = await makeFixture();
    stubScores([0.1, 0.2, 0.3, 0.4]);

    const rendered = await renderings(fixture, ['--rerank', '--min-relevance', '0.9']);

    expect(rendered.json).toBe('none');
    expect(rendered.text).toContain('retrieve: confidence none');
    expect(rendered.xml).toContain('confidence="none"');
  });
});

/** Every key the `--json` payload carried before `confidence` existed. */
const PRE_CONFIDENCE_KEYS: readonly string[] = [
  'command',
  'adapter',
  'query',
  'k',
  'mode',
  'indexState',
  'count',
  'poolSize',
  'atoms',
  'skipped',
  'exitCode',
];

describe('a run without --min-relevance changes only by the confidence field', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('adds exactly one key to the --json payload', async () => {
    const payload = JSON.parse((await retrieve(await makeFixture(), ['--json'])).stdout) as Record<
      string,
      unknown
    >;

    // `budgetMode` joined it with `--budget-mode` (T3.3): the payload MUST say
    // which measure the budget enforced, or a byte-bounded answer and a
    // token-counted one are indistinguishable at the same `--max-tokens`.
    expect(Object.keys(payload).sort()).toEqual(
      [...PRE_CONFIDENCE_KEYS, 'confidence', 'budgetMode'].sort()
    );
  });

  it('adds exactly one line to the text rendering, leaving every other line as it was', async () => {
    const text = (await retrieve(await makeFixture(), [])).stdout;

    const lines = text.trimEnd().split('\n');
    expect(lines.filter(line => line.includes('confidence'))).toEqual([
      'retrieve: confidence weak',
    ]);
    // The second added line is the budget measure (T3.3), pinned the same way.
    expect(lines.filter(line => line.includes('counted as'))).toEqual([
      'retrieve: budget 64000 counted as bytes',
    ]);
    const rest = lines.filter(
      line => !line.startsWith('retrieve: confidence') && !line.startsWith('retrieve: budget')
    );
    expect(rest[0]).toMatch(/^retrieve: mode [\w:-]+, indexState \w+, atoms \d+$/);
    rest.slice(1).forEach(line => expect(line).toMatch(/^ {2}\d+\.\d{4} {2}|^ {4}origin {2}/));
  });

  it('adds exactly one attribute to the xml root, and nothing to a document', async () => {
    const xml = (await retrieve(await makeFixture(), ['--format', 'xml'])).stdout;

    expect(xml.match(/confidence/g)).toHaveLength(1);
    expect(xml).toContain('confidence="weak"');
    xml
      .split('\n')
      .filter(line => line.startsWith('  <document'))
      .forEach(line =>
        expect(line).toMatch(/^ {2}<document id="[^"]+" score="\d+\.\d{4}" domain="[^"]+">$/)
      );
  });
});

describe('--min-relevance refuses rather than filtering something it cannot calibrate', () => {
  const refuse = async (extra: readonly string[]): Promise<CliResult> =>
    await runCli(['retrieve', 'zestful retrieval', '--adapter', 'linear', ...extra]);

  it('refuses a value outside 0…1, never clamping it', async () => {
    const result = await refuse(['--rerank', '--min-relevance', '1.5']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--min-relevance');
    expect(result.stderr).toContain('1.5');
    expect(result.stderr).toContain('never clamped');
  });

  it('refuses a non-finite value', async () => {
    const result = await refuse(['--rerank', '--min-relevance', 'mostly']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('mostly');
  });

  it('refuses the floor without --rerank — nothing would carry a calibrated score', async () => {
    const result = await refuse(['--min-relevance', '0.5']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--rerank');
  });

  it('refuses a reranker with no measured calibration, naming it and the calibrated ids', async () => {
    const result = await refuse([
      '--rerank',
      '--rerank-model',
      'mxbai-rerank-large-v2',
      '--min-relevance',
      '0.5',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('mxbai-rerank-large-v2');
    expect(result.stderr).toContain(RERANK_MODEL_ID);
  });
});

/**
 * `count: 0` — the ACTIONABLE empty answer.
 *
 * A zero count is a valid answer ("it is not in the vault"), so it stays exit 0
 * and `confidence: none`. What it MUST also carry is WHY it is empty: a run
 * whose type filter emptied it and a run whose terms matched nothing read
 * identically otherwise, and their remedies are different.
 */
const NOTHING_MATCHED = 'nothing in the vault matched these terms';

const NONSENSE = 'zzzqqxx flarbnorble wibblewobble';

const retrieveEmpty = async (
  fixture: Fixture,
  extra: readonly string[]
): Promise<CliResult> =>
  await runCli([
    'retrieve',
    NONSENSE,
    '--adapter',
    'linear',
    '--no-prf',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    ...extra,
  ]);

const emptyPayload = async (
  fixture: Fixture,
  extra: readonly string[]
): Promise<JsonPayload> =>
  parsePayload((await retrieveEmpty(fixture, ['--json', ...extra])).stdout);

const noteOf = async (fixture: Fixture, extra: readonly string[]): Promise<string> =>
  (await emptyPayload(fixture, extra)).note ?? '';

describe('an empty answer states WHY it is empty, and stays exit 0', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is exit 0 with confidence none on every empty variant', async () => {
    const fixture = await makeFixture();

    const variants = [[], ['--include-history'], ['--type', 'adr'], ['--exclude-type', 'adr']];
    for (const extra of variants) {
      const result = await retrieveEmpty(fixture, extra);
      const payload = await emptyPayload(fixture, extra);
      expect(result.exitCode).toBe(0);
      expect(payload.count).toBe(0);
      expect(payload.confidence).toBe('none');
      expect(payload.note ?? '').toContain(NOTHING_MATCHED);
    }
  });

  it('names the query phrasing, and no filter, when nothing was filtered', async () => {
    const note = await noteOf(await makeFixture(), ['--include-history']);

    expect(note).toContain(NOTHING_MATCHED);
    expect(note).toContain('Query rephrasing');
    expect(note).not.toContain('--type');
    expect(note).not.toContain('--include-history');
  });

  it('names the PROFILE DEFAULT exclusion, and --include-history, when the caller passed no filter flag', async () => {
    const note = await noteOf(await makeFixture(), []);

    expect(note).toContain(NOTHING_MATCHED);
    DEFAULT_EXCLUDED_TYPES.forEach(type => expect(note).toContain(type));
    expect(note).toContain('--include-history');
    expect(note).toContain('Query rephrasing');
  });

  it('names an explicit --type list and its own remedy', async () => {
    const note = await noteOf(await makeFixture(), ['--type', 'adr,plan']);

    expect(note).toContain('--type adr,plan');
    expect(note).not.toContain(DEFAULT_EXCLUDED_TYPES[0] ?? 'feature-log');
  });

  it('names an explicit --exclude-type list and its own remedy', async () => {
    const note = await noteOf(await makeFixture(), ['--exclude-type', 'adr,plan']);

    expect(note).toContain('--exclude-type adr,plan');
    expect(note).toContain('--include-history');
  });

  it('carries the note in all three renderings', async () => {
    const fixture = await makeFixture();

    const text = (await retrieveEmpty(fixture, [])).stdout;
    const xml = (await retrieveEmpty(fixture, ['--format', 'xml'])).stdout;

    expect(text).toContain(NOTHING_MATCHED);
    expect(text).toContain('retrieve: confidence none');
    expect(xml).toContain('count="0"');
    expect(xml).toContain('confidence="none"');
    expect(xml.split('\n').some(line => line.startsWith('  <note>') && line.includes(NOTHING_MATCHED))).toBe(true);
  });

  it('keeps a REFUSAL ahead of the empty note', async () => {
    const fixture = await makeFixture();
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new Error('connection refused');
    });

    const result = await retrieveEmpty(fixture, ['--json', '--rerank']);
    const payload = parsePayload(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(payload.note ?? '').toContain(NOTHING_MATCHED);
    expect((payload.note ?? '').startsWith(NOTHING_MATCHED)).toBe(false);
  });

  it('reports an ABSENT corpus as "nothing was searched", never as "nothing matched"', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-empty-'));
    const result = await runCli([
      'retrieve',
      NONSENSE,
      '--adapter',
      'linear',
      '--no-prf',
      '--atoms-dir',
      join(repoRoot, 'no-atoms'),
      '--repo-root',
      repoRoot,
      '--json',
    ]);
    const payload = parsePayload(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(payload.note ?? '').toContain('nothing was searched');
    expect(payload.note ?? '').not.toContain(NOTHING_MATCHED);
  });

  it('leaves a NON-EMPTY run without any of it', async () => {
    const fixture = await makeFixture();

    const payload = await json(fixture, []);
    const text = (await retrieve(fixture, [])).stdout;
    const xml = (await retrieve(fixture, ['--format', 'xml'])).stdout;

    expect(payload.count).toBeGreaterThan(0);
    expect(payload.note).toBeUndefined();
    expect(text).not.toContain(NOTHING_MATCHED);
    expect(xml).not.toContain('<note>');
  });
});

/**
 * A REFUSED rerank MUST NOT be floored.
 *
 * The floor filters on a calibrated cross-encoder probability. When the rerank
 * was refused nothing carries one, so applying the floor drops every atom for
 * lack of a measurement that never happened — and the resulting `count: 0` +
 * `confidence: none` is exactly the shape the caller contract reads as "it is
 * not in the vault". A transient network fault MUST NOT assert a false negative
 * about the corpus.
 */
const SCORED_BELOW = 'scored below the';

describe('the relevance floor is NOT applied when the rerank was refused', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const refusedFloor = async (fixture: Fixture): Promise<CliResult> => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new Error('connection refused');
    });
    return await retrieve(fixture, ['--json', '--rerank', '--min-relevance', '0.5']);
  };

  it('delivers the un-floored first pass, weak, exit 3, and says the floor did not run', async () => {
    const fixture = await makeFixture();
    const unfloored = await json(fixture, []);

    const result = await refusedFloor(fixture);
    const payload = parsePayload(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(payload.atoms.map(entry => entry.id)).toEqual(unfloored.atoms.map(entry => entry.id));
    expect(payload.count).toBe(unfloored.count);
    expect(payload.confidence).toBe('weak');
    expect(payload.note ?? '').not.toContain(SCORED_BELOW);
    expect(payload.note ?? '').toContain('0.5');
    expect(payload.note ?? '').toContain('was NOT applied');
    // The refusal still leads and still names its own cause.
    expect((payload.note ?? '').startsWith('dp-gnosis/rerank-probe-failed')).toBe(true);
  });

  it('says it in the text and xml renderings too, and never claims a score', async () => {
    const fixture = await makeFixture();
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new Error('connection refused');
    });

    const text = (await retrieve(fixture, ['--rerank', '--min-relevance', '0.5'])).stdout;
    const xml = (await retrieve(fixture, ['--format', 'xml', '--rerank', '--min-relevance', '0.5']))
      .stdout;

    expect(text).toContain('was NOT applied');
    expect(text).not.toContain(SCORED_BELOW);
    expect(text).toContain('retrieve: confidence weak');
    expect(xml).toContain('was NOT applied');
    expect(xml).not.toContain(SCORED_BELOW);
    expect(xml).toContain('confidence="weak"');
  });

  it('leaves the HONEST scored-below case exactly as it was', async () => {
    const fixture = await makeFixture();
    stubScores([0.1, 0.2, 0.3, 0.4]);

    const payload = await json(fixture, ['--rerank', '--min-relevance', '0.9']);

    expect(payload.count).toBe(0);
    expect(payload.confidence).toBe('none');
    expect(payload.note ?? '').toContain(`${LABELS.length} atom(s) ${SCORED_BELOW} 0.9`);
    expect(payload.note ?? '').not.toContain('was NOT applied');
  });
});
