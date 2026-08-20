/**
 * `src/api.d.ts` is the consumer contract, and it is only useful if it stays
 * (a) a LEAF — a single dependency in it breaks a consumer package compiling it
 * under a narrower `rootDir` (TS6059) — and (b) TRUE of the types the engine
 * actually produces. Both are checked here: the leaf rule by reading the file,
 * the truth by binding each internal type to its contract counterpart so `tsc`
 * fails the moment one drifts from the other.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { GnosisAnswer, GnosisAtom, GnosisExitCode, GnosisSkippedAtom } from '../src/api.js';
import type { SkippedAtom } from '../src/budget.js';
import type { ExplainedAtom } from '../src/cli/explain.js';
import { EXIT_OK, EXIT_PARTIAL, EXIT_USAGE } from '../src/cli/outcome.js';
import { DEFAULT_ATOM_TYPE } from '../src/config.js';

const API_PATH = fileURLToPath(new URL('../src/api.d.ts', import.meta.url));

/** Comments discuss the leaf rule by name, so they are removed before the scan. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('api.d.ts is a leaf declaration module', () => {
  it('carries no import of any kind, in any position', () => {
    const code = withoutComments(readFileSync(API_PATH, 'utf8'));

    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\b/);
  });

  it('still declares the exported contract after comment stripping', () => {
    const code = withoutComments(readFileSync(API_PATH, 'utf8'));

    // The ALIAS form is load-bearing, not a style choice: an `interface` gets no
    // implicit index signature, so `GnosisAnswer` would stop being assignable to
    // `CommandOutcome.data` (`Readonly<Record<string, unknown>>`) and `payload`
    // could only be bound to it through a cast. An alias is also closed to
    // declaration merging, which is what a published contract wants.
    expect(code).toContain('export type GnosisAnswer');
    expect(code).toContain('export type GnosisExitCode');
  });
});

/*
 * Compile-time bindings. Each is an identity function whose parameter is the
 * INTERNAL type and whose return type is the CONTRACT type — it type-checks
 * only while the internal type remains assignable to the contract.
 */
const asGnosisAtom = (atom: ExplainedAtom): GnosisAtom => atom;
const asGnosisSkippedAtom = (skipped: SkippedAtom): GnosisSkippedAtom => skipped;
const asGnosisExitCode = (code: typeof EXIT_OK | typeof EXIT_USAGE | typeof EXIT_PARTIAL): GnosisExitCode => code;

const EXPLAINED: ExplainedAtom = {
  id: 'ts-testing-layered-test-model',
  title: 'Layered Test Model',
  domain: 'standards',
  type: DEFAULT_ATOM_TYPE,
  body: '# Layered Test Model\n\nprose\n',
  score: 4.25,
  sourcePath: 'vault/ts-testing-layered-test-model.md',
  originPaths: ['claude-artifacts/standards/TS-TESTING.md'],
  originIndex: 0,
  originCount: 2,
  headingChain: 'Layered Test Model > Unit tier',
  summary: 'How the tiers divide the suite',
  matchedTerms: ['layer', 'test'],
  snippet: 'prose',
  scoreNormalised: 1,
};

const SKIPPED: SkippedAtom = {
  id: 'ts-testing-e2e',
  sourcePath: 'vault/ts-testing-e2e.md',
  estimatedTokens: 812,
};

describe('the engine types satisfy the contract', () => {
  it('delivers an ExplainedAtom wherever a GnosisAtom is promised', () => {
    const atom = asGnosisAtom(EXPLAINED);

    expect(atom.snippet).toBe('prose');
    expect(atom.scoreNormalised).toBe(1);
    expect(atom.matchedTerms).toEqual(['layer', 'test']);
  });

  it('leaves the two R4.2-reserved line fields unpopulated', () => {
    const atom = asGnosisAtom(EXPLAINED);

    expect(atom.originStartLine).toBeUndefined();
    expect(atom.originEndLine).toBeUndefined();
  });

  it('delivers a SkippedAtom wherever a GnosisSkippedAtom is promised', () => {
    expect(asGnosisSkippedAtom(SKIPPED)).toEqual(SKIPPED);
  });

  it('admits every exit code the CLI can return', () => {
    expect([asGnosisExitCode(EXIT_OK), asGnosisExitCode(EXIT_USAGE), asGnosisExitCode(EXIT_PARTIAL)]).toEqual([0, 2, 3]);
  });
});

/*
 * Key-set variants. A run without `--rephrase` reports no `queryRewritten`, and
 * a run without `--synthesize` reports no `synthesized` / `answer` — absence is
 * the signal, so each variant is asserted as its OWN literal rather than as one
 * fixture with optional keys set to `undefined`.
 */
const BASE = {
  command: 'answer',
  adapter: 'fts5',
  query: 'layered test model tiers',
  k: 5,
  mode: 'lexical',
  indexState: 'ready',
  count: 1,
  documents: 1,
  poolSize: 100,
  budgetMode: 'tokens',
  maxTokens: 4000,
  packTokens: 812,
  confidence: 'weak',
  pack: '[^ts-testing-layered-test-model] prose',
  citations: ['ts-testing-layered-test-model'],
  atoms: [EXPLAINED],
  skipped: [SKIPPED],
  neutralised: 0,
} as const;

const PLAIN = { ...BASE } satisfies GnosisAnswer;

const REPHRASED = {
  ...BASE,
  queryRewritten: 'layer test model tier',
} satisfies GnosisAnswer;

const SYNTHESIZED = {
  ...BASE,
  synthesized: true,
  answer: 'The suite divides into unit, integration and E2E tiers.[^ts-testing-layered-test-model]',
} satisfies GnosisAnswer;

describe('GnosisAnswer covers each key-set variant', () => {
  it('accepts a plain run with neither a rewrite nor a synthesis', () => {
    expect('queryRewritten' in PLAIN).toBe(false);
    expect('synthesized' in PLAIN).toBe(false);
    expect('answer' in PLAIN).toBe(false);
    expect('note' in PLAIN).toBe(false);
  });

  it('accepts a --rephrase run carrying the rewrite and no synthesis keys', () => {
    expect(REPHRASED.queryRewritten).toBe('layer test model tier');
    expect('synthesized' in REPHRASED).toBe(false);
    expect('answer' in REPHRASED).toBe(false);
  });

  it('accepts a --synthesize run carrying the answer and no rewrite', () => {
    expect(SYNTHESIZED.synthesized).toBe(true);
    expect(SYNTHESIZED.answer).toContain('[^ts-testing-layered-test-model]');
    expect('queryRewritten' in SYNTHESIZED).toBe(false);
  });
});
