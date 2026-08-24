/**
 * Grouped rendering: several atoms of ONE source document are delivered
 * together, in the order the author wrote them, and no single document may
 * flood the answer.
 *
 * The three properties this file pins, each of which failed before it existed:
 *
 * 1. WITHIN a document the atoms ascend by `originIndex` — a reader quoting the
 *    answer reads the source in reading order, so `(1/n)` never follows `(2/n)`.
 *    Score order is the DOCUMENT order, never the order inside one.
 * 2. The cap is applied to the POOL, not to the delivered slice, so an atom it
 *    drops frees a slot a lower-ranked document's atom takes — `-k` keeps
 *    delivering `-k` while the corpus can supply it.
 * 3. `--flat` is the pre-grouping renderer byte for byte: no reordering, no cap
 *    and no `(i/n)` marker, so every caller reading today's output keeps it.
 *
 * The position marker is asserted to SURVIVE a missing field rather than to
 * default one: the production vault carries `origin_index` since T2.2, but a
 * custom `--atoms-dir` may hold atoms ingested before it, and an answer that
 * crashes on them is worse than one that omits a marker.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import {
  capPerDocument,
  DEFAULT_MAX_PER_DOC,
  groupByDocument,
  NO_CAP,
  positionMarker
} from '../src/cli/grouping.js';
import type { RetrievedAtom } from '../src/port.js';

interface Origin {
  readonly index?: number;
  readonly count?: number;
}

const atom = (id: string, document: string, score: number, origin: Origin = {}): RetrievedAtom => ({
  id,
  title: id,
  domain: 'standards',
  type: 'standard',
  body: id,
  score,
  sourcePath: `/atoms/${id}.md`,
  originPaths: [document],
  ...(origin.index === undefined ? {} : { originIndex: origin.index }),
  ...(origin.count === undefined ? {} : { originCount: origin.count }),
});

const ids = (atoms: readonly RetrievedAtom[]): readonly string[] => atoms.map(item => item.id);

describe('groupByDocument', () => {
  it('orders atoms within a document by reading order, not by score', () => {
    const ranked = [
      atom('a-late', 'A.md', 0.9, { index: 2, count: 3 }),
      atom('b-only', 'B.md', 0.8, { index: 0, count: 1 }),
      atom('a-early', 'A.md', 0.7, { index: 0, count: 3 }),
    ];

    const groups = groupByDocument(ranked);

    expect(groups.map(group => group.document)).toEqual(['A.md', 'B.md']);
    expect(ids(groups[0]?.atoms ?? [])).toEqual(['a-early', 'a-late']);
  });

  it('never lets a later reading position precede an earlier one', () => {
    const ranked = [
      atom('a2', 'A.md', 0.9, { index: 2, count: 3 }),
      atom('a1', 'A.md', 0.8, { index: 1, count: 3 }),
      atom('a0', 'A.md', 0.7, { index: 0, count: 3 }),
    ];

    const markers = (groupByDocument(ranked)[0]?.atoms ?? []).map(positionMarker);

    expect(markers).toEqual(['(1/3)', '(2/3)', '(3/3)']);
  });

  it('ranks a document by its BEST atom, so a strong second document stays ahead', () => {
    const ranked = [
      atom('a0', 'A.md', 0.9, { index: 0, count: 2 }),
      atom('b0', 'B.md', 0.8, { index: 0, count: 1 }),
      atom('a1', 'A.md', 0.1, { index: 1, count: 2 }),
    ];

    expect(groupByDocument(ranked).map(group => group.document)).toEqual(['A.md', 'B.md']);
  });

  it('keeps an atom carrying no reading position, placing it last in its document', () => {
    const ranked = [
      atom('unplaced', 'A.md', 0.9),
      atom('a1', 'A.md', 0.5, { index: 1, count: 2 }),
    ];

    expect(ids(groupByDocument(ranked)[0]?.atoms ?? [])).toEqual(['a1', 'unplaced']);
  });

  it('groups an atom naming no origin document under its own atom file', () => {
    const orphan: RetrievedAtom = { ...atom('orphan', 'A.md', 0.5), originPaths: [] };

    expect(groupByDocument([orphan])).toEqual([
      { document: '/atoms/orphan.md', atoms: [orphan] },
    ]);
  });
});

describe('capPerDocument', () => {
  it('promotes a lower-ranked document into the slot the cap freed', () => {
    const ranked = [
      atom('a0', 'A.md', 0.9, { index: 0, count: 3 }),
      atom('a1', 'A.md', 0.8, { index: 1, count: 3 }),
      atom('a2', 'A.md', 0.7, { index: 2, count: 3 }),
      atom('b0', 'B.md', 0.6, { index: 0, count: 1 }),
    ];

    const capped = capPerDocument(ranked, 2);

    expect(ids(capped)).toEqual(['a0', 'a1', 'b0']);
    expect(ids(capped.slice(0, 3))).toContain('b0');
  });

  it('keeps the ranking order of the atoms it kept', () => {
    const ranked = [
      atom('a0', 'A.md', 0.9),
      atom('b0', 'B.md', 0.8),
      atom('a1', 'A.md', 0.7),
      atom('b1', 'B.md', 0.6),
    ];

    expect(ids(capPerDocument(ranked, 1))).toEqual(['a0', 'b0']);
  });

  it(`caps nothing at ${NO_CAP}, which is how a caller asks for no cap`, () => {
    const ranked = [atom('a0', 'A.md', 0.9), atom('a1', 'A.md', 0.8)];

    expect(capPerDocument(ranked, NO_CAP)).toEqual(ranked);
  });

  it('ships a default cap of 2', () => {
    expect(DEFAULT_MAX_PER_DOC).toBe(2);
  });
});

describe('positionMarker', () => {
  it('states the position one-based, against the document total', () => {
    expect(positionMarker(atom('a', 'A.md', 1, { index: 1, count: 7 }))).toBe('(2/7)');
  });

  it.each([{ count: 7 }, { index: 1 }, {}])(
    'omits the marker rather than inventing one from %o',
    origin => {
      expect(positionMarker(atom('a', 'A.md', 1, origin))).toBe('');
    }
  );
});

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

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const fixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-grouping-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'TS-TESTING.md'), DOC_A, 'utf8');
  await writeFile(join(corpus, 'TIER-NOTES.md'), DOC_B, 'utf8');
  const atomsDir = join(repoRoot, 'atoms');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  return { repoRoot, atomsDir };
};

const retrieve = async (
  place: Fixture,
  extra: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  runCli([
    'retrieve',
    'layered test model tier',
    '-k',
    '4',
    '--adapter',
    'linear',
    '--no-prf',
    '--atoms-dir',
    place.atomsDir,
    '--repo-root',
    place.repoRoot,
    ...extra,
  ]);

/** The atom lines of a text rendering: every line that opens with a score. */
const atomLines = (stdout: string): readonly string[] =>
  stdout.split('\n').filter(line => /^ {2}\d+\.\d{4} {2}/.test(line));

describe('retrieve renders the answer grouped by document', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('caps one document at two atoms and delivers the other document instead', async () => {
    const place = await fixture();

    const result = await retrieve(place, []);
    const lines = atomLines(result.stdout);

    expect(lines.filter(line => line.includes('ts-testing')).length).toBe(DEFAULT_MAX_PER_DOC);
    expect(lines.some(line => line.includes('tier-notes'))).toBe(true);
  });

  it('marks each atom with its reading position, ascending within a document', async () => {
    const place = await fixture();

    const positions = atomLines((await retrieve(place, [])).stdout)
      .filter(line => line.includes('ts-testing'))
      .flatMap(line => [...line.matchAll(/\((\d+)\/(\d+)\)/g)].map(match => Number(match[1])));

    expect(positions.length).toBeGreaterThan(1);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it('renders the pre-grouping lines under --flat: no marker, score order, no cap', async () => {
    const place = await fixture();

    const lines = atomLines((await retrieve(place, ['--flat'])).stdout);
    const scores = lines.map(line => Number(line.trim().split(/\s+/)[0]));

    expect(lines.every(line => !/\(\d+\/\d+\)/.test(line))).toBe(true);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
    expect(lines.filter(line => line.includes('ts-testing')).length).toBeGreaterThan(
      DEFAULT_MAX_PER_DOC
    );
  });
});

const EXIT_USAGE = 2;

describe('the grouping flags refuse a contradiction rather than picking one', () => {
  it('exits 2 when --flat is paired with a per-document cap', async () => {
    const result = await runCli(['retrieve', 'anything', '--flat', '--max-per-doc', '3']);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--flat');
    expect(result.stderr).toContain('--max-per-doc');
  });

  it.each(['1.5', '-1', 'two'])('exits 2 on --max-per-doc %s, naming the correction', async raw => {
    const result = await runCli(['retrieve', 'anything', '--max-per-doc', raw]);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(`"${raw}"`);
    expect(result.stderr).toContain('non-negative integer');
  });

  it.each(['--flat', '--max-per-doc'])('refuses %s outside retrieve', async flag => {
    // Pinned to a temp fixture: an unpinned `ingest` would resolve its output to
    // the production ATOMS_DIR, so the refusal under test is not load-bearing.
    const place = await fixture();
    const result = await runCli([
      'ingest',
      '--atoms-dir',
      place.atomsDir,
      '--repo-root',
      place.repoRoot,
      flag,
      '2',
    ]);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(flag);
  });
});

/**
 * The cap MUST NOT shorten the answer while the corpus can still fill it.
 *
 * Measured before the fix, on the real vault: `-k 10 --max-per-doc 1` delivered
 * 5 atoms and said nothing, because the first pass fetched `k * cap` = 10 atoms
 * that spanned only 5 documents. The pool depth is INVERTED that way — a tighter
 * cap needs a DEEPER pool, since delivering `k` atoms at `cap` per document
 * needs `ceil(k / cap)` distinct documents in the pool.
 *
 * The fixture is 12 documents of 3 atoms each with descending term density, so
 * the best 10 atoms span 4 documents: at `--max-per-doc 1` a `k`-deep pool can
 * deliver 4, and only a deeper one reaches the 10 the corpus can supply.
 */
const WIDE_DOC_COUNT = 12;
const WIDE_K = 10;

const wideBody = (label: string, part: string, repeats: number): string =>
  `${'layered test model tier '.repeat(repeats)}${part} prose of document ${label}, written so that this section stands alone as one atom of the corpus rather than folding into its neighbours, and carrying enough characters of its own to clear the minimum atom size`;

const wideDoc = (label: string, repeats: number): string =>
  [
    `# Layered Test Model ${label}`,
    wideBody(label, 'introductory', repeats),
    `## Unit tier ${label}`,
    wideBody(label, 'unit', repeats),
    `## E2E tier ${label}`,
    wideBody(label, 'end to end', repeats),
  ].join('\n\n');

const WIDE_LABELS = Array.from({ length: WIDE_DOC_COUNT }, (_, index) =>
  String.fromCharCode('A'.charCodeAt(0) + index)
);

const wideFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-wide-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await Promise.all(
    WIDE_LABELS.map((label, index) =>
      writeFile(join(corpus, `DOC-${label}.md`), wideDoc(label, WIDE_DOC_COUNT - index), 'utf8')
    )
  );
  const atomsDir = join(repoRoot, 'atoms');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  return { repoRoot, atomsDir };
};

interface JsonPayload {
  readonly count: number;
  readonly poolSize: number;
  readonly note?: string;
}

const retrieveJson = async (
  place: Fixture,
  extra: readonly string[]
): Promise<JsonPayload> => {
  const result = await runCli([
    'retrieve',
    'layered test model tier',
    '-k',
    String(WIDE_K),
    '--adapter',
    'linear',
    '--no-prf',
    '--atoms-dir',
    place.atomsDir,
    '--repo-root',
    place.repoRoot,
    '--json',
    ...extra,
  ]);
  return JSON.parse(result.stdout) as JsonPayload;
};

describe('a per-document cap deepens the pool instead of shortening the answer', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(`delivers ${WIDE_K} atoms at --max-per-doc 1 while ${WIDE_DOC_COUNT} documents match`, async () => {
    const place = await wideFixture();

    const payload = await retrieveJson(place, ['--max-per-doc', '1']);

    expect(payload.count).toBe(WIDE_K);
    expect(payload.note).toBeUndefined();
  });

  it.each([['--flat'], ['--max-per-doc', '0']])(
    'keeps the pool at exactly -k under %s, so its output is byte-identical',
    async (...extra: readonly string[]) => {
      const place = await wideFixture();

      const payload = await retrieveJson(place, extra);

      expect(payload.poolSize).toBe(WIDE_K);
      expect(payload.note).toBeUndefined();
    }
  );

  it('states that the CAP shortened the answer when the corpus cannot fill it', async () => {
    const place = await fixture();

    const result = await runCli([
      'retrieve',
      'layered test model tier',
      '-k',
      '4',
      '--max-per-doc',
      '1',
      '--adapter',
      'linear',
      '--no-prf',
      '--atoms-dir',
      place.atomsDir,
      '--repo-root',
      place.repoRoot,
      '--json',
    ]);
    const payload = JSON.parse(result.stdout) as JsonPayload;

    expect(payload.count).toBeLessThan(4);
    expect(payload.note).toContain('--max-per-doc');
    expect(payload.note).toContain(`${payload.count} of the 4`);
  });
});
