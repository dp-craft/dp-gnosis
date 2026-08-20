/**
 * The `ident-porter-fold` chain: an identifier-shaped raw token keeps its WHOLE
 * spelling as one unstemmed term beside the `porter-fold` parts it already
 * contributed, on the index side and the query side alike.
 *
 * Every probe is asserted as an EXACT string under BOTH chains, because the
 * value of the new chain is entirely in the delta: `porter-fold` output must be
 * byte-identical to what it was before the chain existed, and the ident output
 * must differ ONLY where an identifier-shaped token appears.
 */
import { toMatchExpression } from '../src/adapters/fts5Adapter.js';
import {
  analyze,
  analyzeToText,
  isIdentifierShaped,
  stemTerm,
  tokenize
} from '../src/query.js';

/** The six probes, verified live at HEAD before the chain was added. */
const PROBES = {
  prose: 'zustand selector stability',
  adr: 'adr-018 layered test model',
  paths: '@/features/chat useChatStore.retrieve(query)',
  flags: 'lint:test-shape RUNNER_EVAL_CAPTURE',
  hungarian: 'kerekitesi szabalyok AFA osszege',
  question: 'how to start e2e tests',
} as const;

describe('toMatchExpression under porter-fold (regression guard)', () => {
  it('leaves prose alone', () => {
    expect(toMatchExpression(PROBES.prose, 'porter-fold')).toBe(
      '"zustand" OR "selector" OR "stabil"'
    );
  });

  it('splits a hyphenated identifier into an adjacency-requiring phrase', () => {
    expect(toMatchExpression(PROBES.adr, 'porter-fold')).toBe(
      '"adr 018" OR "layer" OR "test" OR "model"'
    );
  });

  it('splits a path and a dotted call into phrases', () => {
    expect(toMatchExpression(PROBES.paths, 'porter-fold')).toBe(
      '"featur chat" OR "usechatstor retriev queri"'
    );
  });

  it('splits a flag and a screaming constant into phrases', () => {
    expect(toMatchExpression(PROBES.flags, 'porter-fold')).toBe(
      '"lint test shape" OR "runner eval captur"'
    );
  });

  it('leaves Hungarian prose alone', () => {
    expect(toMatchExpression(PROBES.hungarian, 'porter-fold')).toBe(
      '"kerekitesi" OR "szabalyok" OR "afa" OR "osszeg"'
    );
  });

  it('leaves a question alone', () => {
    expect(toMatchExpression(PROBES.question, 'porter-fold')).toBe(
      '"how" OR "to" OR "start" OR "e2" OR "test"'
    );
  });
});

describe('toMatchExpression under ident-porter-fold', () => {
  it('leaves prose byte-identical to porter-fold', () => {
    expect(toMatchExpression(PROBES.prose, 'ident-porter-fold')).toBe(
      '"zustand" OR "selector" OR "stabil"'
    );
  });

  it('adds the whole-token alternative for a hyphenated identifier', () => {
    expect(toMatchExpression(PROBES.adr, 'ident-porter-fold')).toBe(
      '("adr_018" OR "adr 018") OR "layer" OR "test" OR "model"'
    );
  });

  it('adds the whole-token alternative for a path and a dotted call', () => {
    expect(toMatchExpression(PROBES.paths, 'ident-porter-fold')).toBe(
      '("at_features_chat" OR "featur chat") OR ' +
        '("usechatstore_retrieve_query" OR "usechatstor retriev queri")'
    );
  });

  it('adds the whole-token alternative for a flag and a screaming constant', () => {
    expect(toMatchExpression(PROBES.flags, 'ident-porter-fold')).toBe(
      '("lint_test_shape" OR "lint test shape") OR ' +
        '("runner_eval_capture" OR "runner eval captur")'
    );
  });

  it('leaves Hungarian prose byte-identical to porter-fold', () => {
    expect(toMatchExpression(PROBES.hungarian, 'ident-porter-fold')).toBe(
      '"kerekitesi" OR "szabalyok" OR "afa" OR "osszeg"'
    );
  });

  it('leaves a question byte-identical to porter-fold', () => {
    expect(toMatchExpression(PROBES.question, 'ident-porter-fold')).toBe(
      '"how" OR "to" OR "start" OR "e2" OR "test"'
    );
  });

  it('keeps adjacency additive inside the whole-token group', () => {
    expect(toMatchExpression('adr-018', 'ident-porter-fold', true)).toBe(
      '("adr_018" OR "adr" OR "018" OR "adr 018")'
    );
  });

  it('still emits undefined for a term-free query', () => {
    expect(toMatchExpression('  "  ', 'ident-porter-fold')).toBeUndefined();
  });
});

describe('isIdentifierShaped', () => {
  it.each(['@/features/chat', 'lint:test-shape', 'RUNNER_EVAL_CAPTURE', 'adr-018', 'a.b', 'useChatStore'])(
    'treats %s as identifier shaped',
    raw => {
      expect(isIdentifierShaped(raw)).toBe(true);
    }
  );

  it.each(['zustand', '018', 'bevallás', 'HTTP'])('treats %s as prose', raw => {
    expect(isIdentifierShaped(raw)).toBe(false);
  });

  it.each(['a.b', 'a_b', 'a:b', 'a/b', 'adr-018'])(
    'treats the internal separator in %s as identifier shaped',
    raw => {
      expect(isIdentifierShaped(raw)).toBe(true);
    }
  );

  /**
   * AN EDGE SEPARATOR IS PUNCTUATION. Prose carrying a trailing `.` or `:` is
   * the bulk of what the loose predicate admitted, and every admitted token
   * injected a second, unstemmed copy of itself into the index.
   */
  it.each(['pack.', 'them:', 'sequence.', 'numbers.**', '-leading', 'trailing-', '|---|---|'])(
    'treats the edge separator in %s as prose',
    raw => {
      expect(isIdentifierShaped(raw)).toBe(false);
    }
  );
});

describe('ident-porter-fold token stream', () => {
  it('emits the whole token before its parts', () => {
    expect(analyze('@/features/chat', 'ident-porter-fold')).toEqual([
      'at_features_chat',
      'featur',
      'chat',
    ]);
  });

  it('emits parts only for a non-identifier token', () => {
    expect(analyze('layered test model', 'ident-porter-fold')).toEqual([
      'layer',
      'test',
      'model',
    ]);
  });

  it('emits nothing extra when the whole token equals its single part', () => {
    expect(analyze('foo_', 'ident-porter-fold')).toEqual(['foo']);
  });

  it('emits nothing extra when the token normalizes to nothing', () => {
    expect(analyze('--', 'ident-porter-fold')).toEqual([]);
  });

  /**
   * THE REGRESSION THIS TIGHTENING EXISTS TO PREVENT: a prose token with a
   * trailing period must analyse byte-identically under BOTH chains, so it
   * contributes exactly one term to the index instead of two.
   */
  it.each(['pack.', 'them: the sequence.', 'a row of numbers.**'])(
    'analyses %s byte-identically to porter-fold',
    text => {
      expect(analyze(text, 'ident-porter-fold')).toEqual(analyze(text, 'porter-fold'));
    }
  );

  /**
   * INDEX-SIDE SYMMETRY: a body carrying `@/features/chat` holds the whole-token
   * term AND the two parts ADJACENT, so a `porter-fold`-shaped phrase query
   * (`"featur chat"`) still matches an ident-built index.
   */
  it('keeps the parts adjacent so a phrase query still matches', () => {
    const stream = analyze('see @/features/chat for details', 'ident-porter-fold');
    expect(stream).toContain('at_features_chat');
    const chat = stream.indexOf('chat');
    expect(stream[chat - 1]).toBe('featur');
    expect(analyzeToText('see @/features/chat for details', 'ident-porter-fold')).toContain(
      'featur chat'
    );
  });
});

describe('porter-fold is unchanged by the ident chain', () => {
  const CORPUS = [
    'zustand selector stability',
    '@/features/chat useChatStore.retrieve(query)',
    'adr-018 layered test model',
    'kerekítési szabályok az ÁFA összegére',
    'lint:test-shape RUNNER_EVAL_CAPTURE',
  ] as const;

  it.each(CORPUS)('still reproduces tokenize+stemTerm for %s', text => {
    expect(analyze(text, 'porter-fold')).toEqual(tokenize(text).map(stemTerm));
  });
});

/**
 * CROSS-ADAPTER ANALYZER AGREEMENT.
 *
 * `linear-scan` and `minisearch` do NOT take an `AnalyzerId` — both import
 * `tokenize` + `stemTerm` from `query.ts` directly (minisearch as its
 * `tokenize`/`processTerm` options, linear-scan inline), and `run.ts` REFUSES a
 * non-default `--analyzer` on them for exactly that reason. They therefore
 * cannot be driven by chain id without an index, so agreement is asserted at
 * the seam the three adapters genuinely share: the term stream `tokenize` +
 * `stemTerm` produces IS `porter-fold`, and the fts5 index side (`analyzeToText`)
 * produces that same stream under that chain.
 */
describe('cross-adapter analyzer agreement', () => {
  const INPUTS = [
    'zustand selector stability',
    '@/features/chat useChatStore.retrieve(query)',
    'kerekítési szabályok az ÁFA összegére',
    'RUNNER_EVAL_CAPTURE Mixed Case Prose',
  ] as const;

  it.each(INPUTS)('linear/minisearch terms equal the porter-fold chain for %s', text => {
    const sharedTerms = tokenize(text).map(stemTerm);
    expect(analyze(text, 'porter-fold')).toEqual(sharedTerms);
    expect(analyzeToText(text, 'porter-fold')).toBe(sharedTerms.join(' '));
  });

  it.each(INPUTS)('the ident chain is a superset of the shared terms for %s', text => {
    const sharedTerms = tokenize(text).map(stemTerm);
    const ident = analyze(text, 'ident-porter-fold');
    expect(ident.filter(term => sharedTerms.includes(term))).toEqual(sharedTerms);
  });
});
