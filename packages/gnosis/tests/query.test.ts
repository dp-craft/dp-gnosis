import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUERY_MAX_TERMS } from '../src/config.js';
import type { DocumentFrequencies, QueryInput } from '../src/query.js';
import {
  analyze,
  ANALYZERS,
  analyzeToText,
  buildQuery,
  DEFAULT_ANALYZER,
  stemTerm,
  stemText,
  tokenize
} from '../src/query.js';

const df = (
  totalDocs: number,
  pairs: readonly (readonly [string, number])[]
): DocumentFrequencies => ({
  totalDocs,
  docFreq: new Map(pairs.map(([term, n]) => [term, n])),
});

const EMPTY_DF: DocumentFrequencies = df(0, []);

/** `café` written precomposed (U+00E9) and decomposed (e + U+0301). */
const PRECOMPOSED = 'café';
const DECOMPOSED = 'café';

describe('tokenize', () => {
  it('lowercases and splits on every non-alphanumeric run', () => {
    expect(tokenize('useChatStore.retrieve(query, opts)')).toEqual([
      'usechatstore',
      'retrieve',
      'query',
      'opts',
    ]);
  });

  it('yields no empty tokens for punctuation-only or empty text', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('  --- .,;  ')).toEqual([]);
  });

  it('keeps digits and repeats, preserving occurrence order', () => {
    expect(tokenize('T003 t003 adr-018')).toEqual(['t003', 't003', 'adr', '018']);
  });

  it('folds diacritics so accented and unaccented spellings share one token', () => {
    expect(tokenize(`${PRECOMPOSED} résumé naïve`)).toEqual([
      'cafe',
      'resume',
      'naive',
    ]);
    expect(tokenize(PRECOMPOSED)).toEqual(tokenize('cafe'));
  });

  it('folds a precomposed and a decomposed spelling to the same token', () => {
    expect(tokenize(DECOMPOSED)).toEqual(tokenize(PRECOMPOSED));
  });
});

describe('buildQuery', () => {
  it('returns an empty string for empty input instead of throwing', () => {
    expect(buildQuery({ targets: [] }, EMPTY_DF)).toBe('');
    expect(buildQuery({ targets: ['   '], testContract: '' }, EMPTY_DF)).toBe('');
  });

  it('orders terms by descending IDF', () => {
    const input: QueryInput = { targets: ['common rare middling'] };
    const freqs = df(100, [
      ['common', 90],
      ['middling', 30],
      ['rare', 2],
    ]);
    expect(buildQuery(input, freqs)).toBe('rare middling common');
  });

  it('breaks equal-IDF ties lexicographically, never by insertion order', () => {
    const freqs = df(10, [
      ['gamma', 1],
      ['beta', 1],
      ['alpha', 1],
      ['delta', 5],
    ]);
    expect(buildQuery({ targets: ['gamma delta beta alpha'] }, freqs)).toBe(
      'alpha beta gamma delta'
    );
    expect(buildQuery({ targets: ['delta alpha gamma beta'] }, freqs)).toBe(
      'alpha beta gamma delta'
    );
  });

  it('is byte-identical across two independent calls on the same input', () => {
    const input: QueryInput = {
      targets: ['src/features/chat/useChatStore.ts'],
      testContract: 'retrieve returns atoms ranked by score',
      specExcerpts: ['the port receives a byte-identical query'],
      requirementDetails: ['determinism is the load-bearing property'],
    };
    const freqs = df(50, [
      ['query', 40],
      ['score', 12],
      ['port', 3],
    ]);
    expect(buildQuery(input, freqs)).toBe(buildQuery(input, freqs));
  });

  it('ignores how the same text is distributed across the input sections', () => {
    const freqs = df(20, [
      ['alpha', 2],
      ['beta', 7],
      ['gamma', 11],
    ]);
    const a = buildQuery(
      { targets: ['alpha'], specExcerpts: ['beta gamma'], requirementDetails: ['delta'] },
      freqs
    );
    const b = buildQuery(
      { targets: ['alpha'], specExcerpts: ['delta'], requirementDetails: ['gamma beta'] },
      freqs
    );
    expect(a).toBe(b);
  });

  it('scores a term absent from docFreq as maximally rare, not NaN', () => {
    const freqs = df(100, [['everywhere', 100]]);
    const out = buildQuery({ targets: ['everywhere unseenterm'] }, freqs);
    expect(out).toBe('unseenterm everywhere');
    expect(out).not.toContain('NaN');
  });

  it('emits a repeated term exactly once', () => {
    expect(buildQuery({ targets: ['foo foo foo', 'foo'] }, EMPTY_DF)).toBe('foo');
  });

  it('caps an oversized input at QUERY_MAX_TERMS distinct terms', () => {
    const terms = Array.from({ length: QUERY_MAX_TERMS + 8 }, (_, i) => `t${String(i + 10)}`);
    const out = buildQuery({ targets: [terms.join(' ')] }, EMPTY_DF);
    const kept = out.split(' ');
    expect(kept).toHaveLength(QUERY_MAX_TERMS);
    expect(kept).toEqual([...terms].sort().slice(0, QUERY_MAX_TERMS));
  });
});

/**
 * Real-corpus sample. The vault atoms are the production analyzer input but are
 * gitignored (`.gitignore:96`), so a fresh clone falls back to the tracked
 * markdown the vault is ingested FROM — either way the guard runs over real
 * prose, never a synthetic string list.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SAMPLE_DIRS: readonly string[] = [
  resolve(REPO_ROOT, 'dp-gnosis/vault/atoms'),
  resolve(REPO_ROOT, 'claude-artifacts'),
  resolve(REPO_ROOT, 'docs'),
];
const SAMPLE_SIZE = 300;

const markdownIn = (dir: string): readonly string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter(name => name.endsWith('.md'))
        .sort()
        .map(name => resolve(dir, name))
    : [];

const sampleBodies = (): readonly string[] =>
  SAMPLE_DIRS.flatMap(markdownIn)
    .slice(0, SAMPLE_SIZE)
    .map(file => readFileSync(file, 'utf8'));

describe('analyzer chains', () => {
  const bodies = sampleBodies();

  it('samples at least 200 real corpus bodies', () => {
    expect(bodies.length).toBeGreaterThanOrEqual(200);
  });

  it('reproduces tokenize+stemTerm exactly for every sampled body', () => {
    const mismatched = bodies.filter(
      body => JSON.stringify(analyze(body, 'porter-fold')) !== JSON.stringify(tokenize(body).map(stemTerm))
    );
    expect(mismatched).toHaveLength(0);
  });

  it('reproduces stemText exactly for every sampled body', () => {
    const mismatched = bodies.filter(body => analyzeToText(body, 'porter-fold') !== stemText(body));
    expect(mismatched).toHaveLength(0);
  });

  // `ident-porter-fold` held this default until it was measured and reverted
  // (`vault` nDCG@10 -0.0155, p=0.0478); it stays selectable, not default.
  it('defaults to the porter-fold chain', () => {
    expect(DEFAULT_ANALYZER).toBe('porter-fold');
    expect(analyze('Café Résumés')).toEqual(analyze('Café Résumés', 'porter-fold'));
    expect(analyzeToText('Café Résumés')).toBe(stemText('Café Résumés'));
  });

  it('holds the invariant for decomposed spellings too', () => {
    expect(analyze(DECOMPOSED)).toEqual(tokenize(DECOMPOSED).map(stemTerm));
    expect(analyze(DECOMPOSED)).toEqual(analyze(PRECOMPOSED));
  });

  // A mark INSIDE a word is the discriminating case: the chain splits before it
  // folds, so a split that treated the combining mark as a separator would cut
  // `haszna|lata` where `tokenize` (which folds first) keeps one token.
  it('holds the invariant when a combining mark sits mid-word', () => {
    const midWord = 'használata cafés';
    expect(analyze(midWord)).toEqual(tokenize(midWord).map(stemTerm));
    expect(analyze(midWord)).toEqual(['hasznalata', 'cafe']);
    expect(analyze(midWord, 'nostem-nofold')).toEqual(['használata', 'cafés']);
  });

  it('exposes exactly the five named chains', () => {
    expect(Object.keys(ANALYZERS).sort()).toEqual([
      'ident-porter-fold',
      'nostem-fold',
      'nostem-nofold',
      'porter-fold',
      'porter-nofold',
    ]);
  });

  // Hungarian: Porter's English `-s` rule truncates a native word, and folding
  // erases the vowel that distinguishes it. Each chain isolates one of the two.
  it('keeps the terminal s of bevallás unless the Porter stage runs', () => {
    expect(analyze('bevallás', 'porter-fold')).toEqual(['bevalla']);
    expect(analyze('bevallás', 'nostem-fold')).toEqual(['bevallas']);
    expect(analyze('bevallás', 'nostem-nofold')).toEqual(['bevallás']);
  });

  it('preserves á and ő only on the nofold chains', () => {
    expect(analyze('használata modulok', 'nostem-nofold')).toEqual(['használata', 'modulok']);
    expect(analyze('használata modulok', 'nostem-fold')).toEqual(['hasznalata', 'modulok']);
    expect(analyze('bővítő', 'porter-nofold')).toEqual([stemTerm('bővítő')]);
    expect(analyze('bővítő', 'porter-fold')).toEqual([stemTerm('bovito')]);
  });

  it('separates the fold stage from the stem stage on an accented input', () => {
    expect(analyze('használata', 'nostem-fold')).not.toEqual(analyze('használata', 'nostem-nofold'));
    expect(analyze('bevallás', 'porter-nofold')).not.toEqual(analyze('bevallás', 'nostem-nofold'));
  });
});
