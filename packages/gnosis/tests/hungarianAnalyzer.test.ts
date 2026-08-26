/**
 * The `hulight-fold` chain — a lexicon-free Hungarian light suffix stripper that
 * REPLACES the Porter stage — and `ident-hulight-fold`, its composition with the
 * identifier mechanism.
 *
 * Both chains are CORPUS-SCOPED and opt-in. The value of a stemmer is entirely
 * in which cuts it makes and which it refuses, so every case is asserted as an
 * EXACT string: a stemmer asserted with `toContain` is a stemmer nobody can tell
 * has regressed. The existing chains are re-asserted here byte for byte, because
 * "adds a chain" is only true while `porter-fold`, `nostem-fold` and
 * `ident-porter-fold` emit exactly what they emitted before it existed.
 */
import { toMatchExpression } from '../src/adapters/fts5Adapter.js';
import { analyze } from '../src/query.js';

/** `analyze` of a single raw token under the new chain, as one term. */
const stemOf = (token: string): readonly string[] => analyze(token, 'hulight-fold');

describe('hulight-fold strips Hungarian inflection', () => {
  /**
   * Each pair is the algorithm RUN over the documented steps — terminal
   * inflection, possessive, plural, derivational, undouble — with every cut
   * refused that would leave fewer than `MIN_STEM_LENGTH` characters and a
   * refused cut ENDING its step.
   *
   * A lexicon-free stripper over-stems where a lexicon would not, and that is
   * asserted rather than hidden: `cimkekkel` reaches `cimk` (not the lemma
   * `cimke`, which needs the knowledge that the `k` is the plural), `adonemhez`
   * reaches `adon` (the possessive `em` is indistinguishable from a stem), and
   * `bevallashoz` reaches `beval` (undouble cannot know the `ll` is the stem's).
   * Each is a DELIBERATE consequence of the documented steps; changing one is a
   * change to the algorithm, not a fix to a test.
   */
  it.each([
    ['naplokban', 'napl'], // plural `ok` off `naplok` leaves four characters, the minimum
    ['kotelezettsegek', 'kotelezettseg'],
    ['cimkekkel', 'cimk'],
    ['adoszamat', 'adoszam'],
    ['csoportokat', 'csoport'],
    ['oszlopokba', 'oszlop'],
    ['bevallashoz', 'beval'],
    ['adonemhez', 'adon'],
    ['lepeseknel', 'lepes'],
    ['adatbazisra', 'adatbaz'],
    ['szamolni', 'szamol'],
    ['javitva', 'javit'],
    ['konyvelunk', 'konyvel'],
    ['elhatarolast', 'elhatarol'],
  ])('stems %s to %s', (input, expected) => {
    expect(stemOf(input)).toEqual([expected]);
  });

  /** The stemmer runs AFTER folding, so it only ever sees lowercase ASCII. */
  it('sees the folded spelling of an accented token', () => {
    expect(analyze('kötelezettségek', 'hulight-fold')).toEqual(['kotelezettseg']);
    expect(analyze('Naplókban', 'hulight-fold')).toEqual(['napl']);
  });

  /**
   * NO BARE CONSONANT+`t` RULE. Such a rule fires on stems that legitimately end
   * in `t` and MEASURABLY creates new vocabulary gaps, so the accusative is cut
   * only after a vowel or a linking vowel.
   */
  it.each(['kozpont', 'csoport'])('leaves the stem-final t of %s alone', token => {
    expect(stemOf(token)).toEqual([token]);
  });

  /** A cut that would leave fewer than four characters is refused outright. */
  it('never cuts a five-character token below four characters', () => {
    expect(stemOf('hazak')).toEqual(['hazak']);
    expect(stemOf('hazak')).not.toEqual(['haz']);
    expect(stemOf('lepes')).toEqual(['lepes']);
  });

  it('leaves a token with no recognised suffix untouched', () => {
    expect(analyze('adat naplo kozpont', 'hulight-fold')).toEqual(['adat', 'naplo', 'kozpont']);
  });

  /** English prose is NOT the target: the chain must not silently Porter-stem. */
  it('does not apply the Porter rules the chain replaces', () => {
    expect(analyze('stability', 'hulight-fold')).toEqual(['stability']);
    expect(analyze('stability', 'porter-fold')).toEqual(['stabil']);
  });
});

describe('ident-hulight-fold', () => {
  it('emits the whole-token slug before its hulight parts', () => {
    expect(analyze('l10n_hu_nav_evat', 'ident-hulight-fold')).toEqual([
      'l10n_hu_nav_evat',
      'l10n',
      'hu',
      'nav',
      'evat',
    ]);
  });

  it('emits the same shape ident-porter-fold emits for an identifier', () => {
    expect(analyze('@/features/chat', 'ident-hulight-fold')).toEqual([
      'at_features_chat',
      'featur',
      'chat',
    ]);
  });

  it('emits hulight parts only for a non-identifier token', () => {
    expect(analyze('naplokban es cimkekkel', 'ident-hulight-fold')).toEqual([
      'napl',
      'es',
      'cimk',
    ]);
  });

  it('emits nothing extra when the token normalizes to nothing', () => {
    expect(analyze('--', 'ident-hulight-fold')).toEqual([]);
  });

  /**
   * THE QUERY SIDE MUST RECOGNISE BOTH IDENT CHAINS. A query-side path keyed to
   * one literal chain id would silently weld the whole-token term into the parts
   * phrase for the other, producing a nonsense literal nothing matches.
   */
  it('produces the parenthesised whole-OR-parts group', () => {
    expect(toMatchExpression('l10n_hu_nav_evat', 'ident-hulight-fold')).toBe(
      '("l10n_hu_nav_evat" OR "l10n hu nav evat")'
    );
  });

  it('keeps adjacency additive inside the whole-token group', () => {
    expect(toMatchExpression('adr-018', 'ident-hulight-fold', true)).toBe(
      '("adr_018" OR "adr" OR "018" OR "adr 018")'
    );
  });

  it('leaves Hungarian prose without a whole-token alternative', () => {
    expect(toMatchExpression('naplokban cimkekkel', 'ident-hulight-fold')).toBe(
      '"napl" OR "cimk"'
    );
  });

  it('still emits undefined for a term-free query', () => {
    expect(toMatchExpression('  "  ', 'ident-hulight-fold')).toBeUndefined();
  });
});

/**
 * THE REGRESSION GUARD. The six probes of `identAnalyzer.test.ts`, asserted
 * against the values captured at HEAD before the two chains existed.
 */
describe('the existing chains are byte-identical', () => {
  const PROBES = {
    prose: 'zustand selector stability',
    adr: 'adr-018 layered test model',
    paths: '@/features/chat useChatStore.retrieve(query)',
    flags: 'lint:test-shape RUNNER_EVAL_CAPTURE',
    hungarian: 'kerekitesi szabalyok AFA osszege',
    question: 'how to start e2e tests',
  } as const;

  it('leaves porter-fold untouched', () => {
    expect(analyze(PROBES.prose, 'porter-fold')).toEqual(['zustand', 'selector', 'stabil']);
    expect(analyze(PROBES.adr, 'porter-fold')).toEqual(['adr', '018', 'layer', 'test', 'model']);
    expect(analyze(PROBES.paths, 'porter-fold')).toEqual([
      'featur',
      'chat',
      'usechatstor',
      'retriev',
      'queri',
    ]);
    expect(analyze(PROBES.flags, 'porter-fold')).toEqual([
      'lint',
      'test',
      'shape',
      'runner',
      'eval',
      'captur',
    ]);
    expect(analyze(PROBES.hungarian, 'porter-fold')).toEqual([
      'kerekitesi',
      'szabalyok',
      'afa',
      'osszeg',
    ]);
    expect(analyze(PROBES.question, 'porter-fold')).toEqual([
      'how',
      'to',
      'start',
      'e2',
      'test',
    ]);
  });

  it('leaves nostem-fold untouched', () => {
    expect(analyze(PROBES.prose, 'nostem-fold')).toEqual(['zustand', 'selector', 'stability']);
    expect(analyze(PROBES.adr, 'nostem-fold')).toEqual([
      'adr',
      '018',
      'layered',
      'test',
      'model',
    ]);
    expect(analyze(PROBES.paths, 'nostem-fold')).toEqual([
      'features',
      'chat',
      'usechatstore',
      'retrieve',
      'query',
    ]);
    expect(analyze(PROBES.flags, 'nostem-fold')).toEqual([
      'lint',
      'test',
      'shape',
      'runner',
      'eval',
      'capture',
    ]);
    expect(analyze(PROBES.hungarian, 'nostem-fold')).toEqual([
      'kerekitesi',
      'szabalyok',
      'afa',
      'osszege',
    ]);
    expect(analyze(PROBES.question, 'nostem-fold')).toEqual([
      'how',
      'to',
      'start',
      'e2e',
      'tests',
    ]);
  });

  it('leaves ident-porter-fold untouched', () => {
    expect(analyze(PROBES.prose, 'ident-porter-fold')).toEqual([
      'zustand',
      'selector',
      'stabil',
    ]);
    expect(analyze(PROBES.adr, 'ident-porter-fold')).toEqual([
      'adr_018',
      'adr',
      '018',
      'layer',
      'test',
      'model',
    ]);
    expect(analyze(PROBES.paths, 'ident-porter-fold')).toEqual([
      'at_features_chat',
      'featur',
      'chat',
      'usechatstore_retrieve_query',
      'usechatstor',
      'retriev',
      'queri',
    ]);
    expect(analyze(PROBES.flags, 'ident-porter-fold')).toEqual([
      'lint_test_shape',
      'lint',
      'test',
      'shape',
      'runner_eval_capture',
      'runner',
      'eval',
      'captur',
    ]);
    expect(analyze(PROBES.hungarian, 'ident-porter-fold')).toEqual([
      'kerekitesi',
      'szabalyok',
      'afa',
      'osszeg',
    ]);
    expect(analyze(PROBES.question, 'ident-porter-fold')).toEqual([
      'how',
      'to',
      'start',
      'e2',
      'test',
    ]);
  });

  it('leaves the ident-porter-fold query side untouched', () => {
    expect(toMatchExpression(PROBES.adr, 'ident-porter-fold')).toBe(
      '("adr_018" OR "adr 018") OR "layer" OR "test" OR "model"'
    );
    expect(toMatchExpression(PROBES.paths, 'porter-fold')).toBe(
      '"featur chat" OR "usechatstor retriev queri"'
    );
  });
});
