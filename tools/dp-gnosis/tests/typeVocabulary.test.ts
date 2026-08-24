import { resolve } from 'node:path';

import { ATOM_TYPES, expectVocabulary } from '../src/config.js';
import { loadIngestProfile } from '../src/ingestProfile.js';
import { PROFILES_DIR } from '../src/paths.js';

/**
 * A profile declares WHICH types its own corpus carries; the shipped tuple
 * declares which labels EXIST. A profile naming fewer of them is a narrower
 * corpus, not a defect — it simply yields no results for the types it omits.
 */
describe('expectVocabulary', () => {
  it('accepts the full declared vocabulary in declaration order', () => {
    expect(expectVocabulary([...ATOM_TYPES], ATOM_TYPES, 'types')).toEqual(ATOM_TYPES);
  });

  it('accepts a subset given in declaration order', () => {
    expect(expectVocabulary(['knowledge', 'teaching', 'meta'], ATOM_TYPES, 'types')).toEqual(ATOM_TYPES);
  });

  it('accepts a subset given out of order', () => {
    expect(expectVocabulary(['meta', 'adr', 'knowledge'], ATOM_TYPES, 'types')).toEqual(ATOM_TYPES);
  });

  it('returns the FULL declared tuple, never the subset it was given', () => {
    const returned = expectVocabulary(['knowledge'], ATOM_TYPES, 'types');
    expect(returned).toBe(ATOM_TYPES);
    expect(returned.length).toBe(ATOM_TYPES.length);
  });

  it('refuses a member outside the declared vocabulary, naming it and the valid ones', () => {
    const call = (): readonly string[] => expectVocabulary(['knowledge', 'tax-ruling'], ATOM_TYPES, 'types');
    expect(call).toThrow(/tax-ruling/);
    expect(call).toThrow(/lessons-learned/);
  });

  it('refuses an empty vocabulary', () => {
    expect(() => expectVocabulary([], ATOM_TYPES, 'types')).toThrow(/types/);
  });

  it('accepts the hu-tax profile, which declares four of the shipped types', () => {
    const huTax = loadIngestProfile(resolve(PROFILES_DIR, 'hu-tax.profile.json'));
    expect(huTax.types.length).toBeLessThan(ATOM_TYPES.length);
    expect(expectVocabulary(huTax.types, ATOM_TYPES, 'types')).toEqual(ATOM_TYPES);
  });
});
