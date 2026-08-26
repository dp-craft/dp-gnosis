/**
 * C11a — the zero-posting query-term diagnostic, and the retrieve-path warning
 * built on it.
 *
 * The property under test is a WARNING that must be both PRESENT when the hole
 * exists and ABSENT — byte for byte — when it does not: a diagnostic that
 * perturbs a clean run's output has changed the thing it was meant to observe.
 * Both directions are asserted side by side.
 *
 * The third case is the LANDMINE case. `analyze(analyze(x)) !== analyze(x)` for
 * 4.3 % of terms, and `abuse` is one of them: it analyses to `abus`, which
 * analyses again to `abu`. The index holds `abus`, so a query for `abuse` MUST
 * report no gap — an implementation that analysed the query twice, or that fed
 * an already-analysed vocabulary term back through the query path, would report
 * `abu` missing and invent a hole in a term the index plainly holds.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { buildFts5Index, readIndexAnalyzer } from '../src/adapters/fts5Adapter.js';
import { readVocabularyGap } from '../src/adapters/fts5VocabularyGap.js';
import { runRetrieveCommand } from '../src/cli/retrieveCommand.js';
import { buildCorpusManifest, serializeCorpusManifest } from '../src/corpusManifest.js';
import { analyze } from '../src/query.js';
import { activeProfile } from '../src/vocabulary.js';

let root = '';
let atomsDir = '';
let indexPath = '';
let manifestPath = '';

interface AtomSpec {
  readonly id: string;
  readonly body: string;
}

/**
 * `abuse` and `stability` are load-bearing: the first is a non-idempotent stem,
 * the second is what the inflected-query case matches through.
 */
const ATOMS: readonly AtomSpec[] = [
  { id: 'atom-a', body: 'zustand selector stability rules for a store' },
  { id: 'atom-b', body: 'a policy against abuse of the locator escape hatch' },
];

const atomText = (spec: AtomSpec): string =>
  [
    '---',
    'type: knowledge',
    `id: ${spec.id}`,
    `title: title of ${spec.id}`,
    'x_domain: runner',
    'status: stable',
    'sources:',
    '  - docs/src.md',
    '---',
    spec.body,
    '',
  ].join('\n');

const writeManifest = (): void => {
  const manifest = buildCorpusManifest({
    profile: 'test',
    atoms: ATOMS.map(spec => ({
      id: spec.id,
      type: 'knowledge',
      domain: 'runner',
      content: atomText(spec),
    })),
    skipped: 0,
    duplicates: 0,
  });
  writeFileSync(manifestPath, serializeCorpusManifest(manifest), 'utf8');
};

const gapFor = (query: string): ReturnType<typeof readVocabularyGap> =>
  readVocabularyGap(indexPath, query, readIndexAnalyzer(indexPath));

const retrieveCommand = async (query: string): ReturnType<typeof runRetrieveCommand> =>
  await runRetrieveCommand({
    adapter: 'fts5',
    atomsDir,
    indexPath,
    repoRoot: root,
    flags: {},
    positionals: [query],
    corpusRoots: ['docs'],
    profile: activeProfile(),
  });

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-vocabgap-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  manifestPath = resolve(root, 'corpus-manifest.json');
  mkdirSync(atomsDir, { recursive: true });
  ATOMS.forEach(spec => writeFileSync(resolve(atomsDir, `${spec.id}.md`), atomText(spec), 'utf8'));
  writeManifest();
  buildFts5Index({ atomsDir, indexPath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readVocabularyGap — a query the index can reach', () => {
  it('reports no gap, and a posting count for every analysed term', () => {
    const gap = gapFor('zustand selector');
    expect(gap.gapTerms).toEqual([]);
    expect(gap.gapCount).toBe(0);
    expect(gap.termCount).toBe(2);
    expect(gap.terms).toEqual([
      { term: 'zustand', postings: 1 },
      { term: 'selector', postings: 1 },
    ]);
  });

  it('counts a repeated term once — a term is one vocabulary fact', () => {
    const gap = gapFor('selector selector selector');
    expect(gap.termCount).toBe(1);
    expect(gap.gapCount).toBe(0);
  });
});

describe('readVocabularyGap — a query the index cannot reach', () => {
  it('names exactly the invented term, and leaves the reachable ones alone', () => {
    const gap = gapFor('selector borogove');
    expect(gap.gapTerms).toEqual([analyze('borogove').join(' ')]);
    expect(gap.gapCount).toBe(1);
    expect(gap.termCount).toBe(2);
    expect(gap.terms).toContainEqual({ term: 'selector', postings: 1 });
  });
});

describe('readVocabularyGap — the comparison happens in ANALYSED space, once', () => {
  it('counts a term that only matches after stemming as PRESENT', () => {
    const gap = gapFor('stabilities');
    expect(analyze('stabilities')).toEqual(analyze('stability'));
    expect(gap.gapTerms).toEqual([]);
    expect(gap.terms).toEqual([{ term: 'stabil', postings: 1 }]);
  });

  it('does not re-analyse: a NON-IDEMPOTENT stem is present, not a gap', () => {
    expect(analyze('abuse')).toEqual(['abus']);
    expect(analyze('abus')).toEqual(['abu']);
    const gap = gapFor('abuse');
    expect(gap.terms).toEqual([{ term: 'abus', postings: 1 }]);
    expect(gap.gapCount).toBe(0);
  });
});

describe('retrieve — a query with no zero-posting term', () => {
  it('adds no key and no line: the output is the one it always was', async () => {
    const outcome = await retrieveCommand('selector');
    expect(outcome.data['vocabularyGap']).toBeUndefined();
    expect(outcome.text).not.toMatch(/ZERO postings/);
    expect(outcome.exitCode).toBe(0);
  });
});

describe('retrieve — a query carrying an invented term', () => {
  it('names the term in its own JSON key, without moving the exit code', async () => {
    const clean = await retrieveCommand('selector');
    const outcome = await retrieveCommand('selector borogove');
    const gap = outcome.data['vocabularyGap'] as {
      readonly gapTerms: readonly string[];
      readonly gapCount: number;
      readonly termCount: number;
    };
    expect(gap.gapTerms).toEqual(['borogov']);
    expect(gap.gapCount).toBe(1);
    expect(gap.termCount).toBe(2);
    expect(outcome.exitCode).toBe(clean.exitCode);
  });

  it('states it on its own line of the text rendering', async () => {
    const outcome = await retrieveCommand('selector borogove');
    expect(outcome.text).toMatch(/^retrieve: 1 of 2 analysed query term\(s\) have ZERO postings/m);
    expect(outcome.text).toContain('"borogov"');
  });
});
