import { QUERY_MAX_TERMS } from '../src/config.js';
import type { DocumentFrequencies, QueryInput } from '../src/query.js';
import { buildQuery, tokenize } from '../src/query.js';

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
