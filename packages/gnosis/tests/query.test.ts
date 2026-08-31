import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  ANALYZERS,
  analyzeToText,
  DEFAULT_ANALYZER,
  stemTerm,
  stemText,
  tokenize
} from '../src/query.js';

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

/**
 * Real-corpus sample. The vault atoms are the production analyzer input but are
 * gitignored (`.gitignore:96`), so a fresh clone falls back to the tracked
 * markdown the vault is ingested FROM — either way the guard runs over real
 * prose, never a synthetic string list.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SAMPLE_DIRS: readonly string[] = [
  resolve(REPO_ROOT, 'benchmark-data/vault/atoms'),
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

  it('exposes exactly the seven named chains', () => {
    expect(Object.keys(ANALYZERS).sort()).toEqual([
      'hulight-fold',
      'ident-hulight-fold',
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
