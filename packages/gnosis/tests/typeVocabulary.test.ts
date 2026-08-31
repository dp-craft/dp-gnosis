import { resolve } from 'node:path';

import { expectVocabulary } from '../src/config.js';
import { loadIngestProfile } from '../src/ingestProfile.js';
import { profilesDir } from '../src/paths.js';
import { atomTypes } from '../src/vocabulary.js';

/**
 * A profile declares WHICH types its own corpus carries; the shipped tuple
 * declares which labels EXIST. A profile naming fewer of them is a narrower
 * corpus, not a defect — it simply yields no results for the types it omits.
 */
describe('expectVocabulary', () => {
  it('accepts the full declared vocabulary in declaration order', () => {
    expect(expectVocabulary([...atomTypes()], atomTypes(), 'types')).toEqual(atomTypes());
  });

  it('accepts a subset given in declaration order', () => {
    expect(expectVocabulary(['knowledge', 'teaching', 'meta'], atomTypes(), 'types')).toEqual(atomTypes());
  });

  it('accepts a subset given out of order', () => {
    expect(expectVocabulary(['meta', 'adr', 'knowledge'], atomTypes(), 'types')).toEqual(atomTypes());
  });

  it('returns the FULL declared tuple, never the subset it was given', () => {
    const returned = expectVocabulary(['knowledge'], atomTypes(), 'types');
    expect(returned).toBe(atomTypes());
    expect(returned.length).toBe(atomTypes().length);
  });

  it('refuses a member outside the declared vocabulary, naming it and the valid ones', () => {
    const call = (): readonly string[] => expectVocabulary(['knowledge', 'tax-ruling'], atomTypes(), 'types');
    expect(call).toThrow(/tax-ruling/);
    expect(call).toThrow(/lessons-learned/);
  });

  it('refuses an empty vocabulary', () => {
    expect(() => expectVocabulary([], atomTypes(), 'types')).toThrow(/types/);
  });

  it('accepts the hu-tax profile, which declares four of the shipped types', () => {
    const huTax = loadIngestProfile(resolve(profilesDir(), 'hu-tax.profile.json'));
    expect(huTax.types.length).toBeLessThan(atomTypes().length);
    expect(expectVocabulary(huTax.types, atomTypes(), 'types')).toEqual(atomTypes());
  });
});
