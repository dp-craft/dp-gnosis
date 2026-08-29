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
import { ingestProfilePath } from '../src/paths.js';
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
    sources: [],
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
    profilePath: ingestProfilePath(),
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
    expect(outcome.text).toMatch(/^search: 1 of 2 analysed query term\(s\) have ZERO postings/m);
    expect(outcome.text).toContain('"borogov"');
  });
});

/**
 * The IDENT-CHAIN case. `analyze(x, 'ident-hulight-fold')` emits the WHOLE
 * identifier token beside its parts, but fts5's `unicode61` tokenizer splits
 * `_` at INDEX time — so an ident-built index holds ZERO underscore-bearing
 * terms and a byte-for-byte `term = ?` bind on the whole token can only ever
 * report a gap. Retrieval REACHES those atoms (`toMatchExpression` emits the
 * identifier as a PHRASE of its parts), so the gap is FALSE: the diagnostic
 * would report its worst number on the arm the ident chain exists to improve.
 *
 * The fix judges a multi-part identifier by its parts — zero when any part is
 * missing, otherwise the rarest part's postings, which is an UPPER BOUND on the
 * phrase's reach. The parts come from analysing the RAW query token ONCE with
 * the parts chain; nothing on the vocabulary side is ever re-analysed.
 */
const IDENT_ANALYZER = 'ident-hulight-fold';

/** `ado` sits in BOTH atoms, `bevallas`/`2024` in one — so the bound is 1, not 2. */
const IDENT_ATOMS: readonly AtomSpec[] = [
  { id: 'ident-a', body: 'ado_bevallas_2024 kezelese a rendszerben' },
  { id: 'ident-b', body: 'ado alapu szamitas selector' },
];

let identAtomsDir = '';
let identIndexPath = '';

const identGapFor = (query: string): ReturnType<typeof readVocabularyGap> =>
  readVocabularyGap(identIndexPath, query, readIndexAnalyzer(identIndexPath));

const postingsFor = (
  gap: ReturnType<typeof readVocabularyGap>,
  term: string
): number | undefined => gap.terms.find(entry => entry.term === term)?.postings;

beforeEach(() => {
  identAtomsDir = resolve(root, 'ident-atoms');
  identIndexPath = resolve(root, 'ident-index', 'atoms.db');
  mkdirSync(identAtomsDir, { recursive: true });
  IDENT_ATOMS.forEach(spec =>
    writeFileSync(resolve(identAtomsDir, `${spec.id}.md`), atomText(spec), 'utf8')
  );
  buildFts5Index({ atomsDir: identAtomsDir, indexPath: identIndexPath, analyzer: IDENT_ANALYZER });
});

describe('readVocabularyGap — a NON-ident chain is untouched by the ident path', () => {
  it('binds each analysed part directly, with no whole-token term', () => {
    const gap = gapFor('stability_rules');
    expect(gap.terms).toEqual([
      { term: 'stabil', postings: 1 },
      { term: 'rule', postings: 1 },
    ]);
    expect(gap.gapTerms).toEqual([]);
  });
});

describe('readVocabularyGap — an ident chain judges an identifier by its PARTS', () => {
  it('reports the whole identifier as REACHABLE when every part is present', () => {
    const gap = identGapFor('ado_bevallas_2024');
    expect(postingsFor(gap, 'ado_bevallas_2024')).toBeGreaterThan(0);
    expect(gap.gapTerms).not.toContain('ado_bevallas_2024');
  });

  it('bounds the identifier by its RAREST part, never by its commonest', () => {
    const gap = identGapFor('ado_bevallas_2024');
    expect(postingsFor(gap, 'ado')).toBe(2);
    expect(postingsFor(gap, 'beval')).toBe(1);
    expect(postingsFor(gap, 'ado_bevallas_2024')).toBe(1);
  });

  it('names the WHOLE token the query supplied, not one of its parts', () => {
    const gap = identGapFor('ado_bevallas_2024');
    expect(gap.terms[0]?.term).toBe('ado_bevallas_2024');
  });

  it('reports a real gap when EVERY part is absent', () => {
    const gap = identGapFor('borogove_wabe_2099');
    expect(postingsFor(gap, 'borogove_wabe_2099')).toBe(0);
    expect(gap.gapTerms).toContain('borogove_wabe_2099');
  });

  it('reports a real gap when ONE part is absent — a phrase needs them all', () => {
    const gap = identGapFor('ado_borogove');
    expect(postingsFor(gap, 'ado')).toBe(2);
    expect(postingsFor(gap, 'borogo')).toBe(0);
    expect(postingsFor(gap, 'ado_borogove')).toBe(0);
    expect(gap.gapTerms).toContain('ado_borogove');
  });
});
