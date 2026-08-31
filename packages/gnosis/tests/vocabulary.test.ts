import { resolve } from 'node:path';

import { loadIngestProfile } from '../src/ingestProfile.js';
import { profilesDir } from '../src/paths.js';
import {
  activeProfile,
  atomDomains,
  defaultAtomType,
  defaultExcludedTypes,
  domainForSource,
  resetActiveProfile,
  setActiveProfile,
  sourceRootDomains,
  typeForSource
} from '../src/vocabulary.js';

/**
 * The vocabulary resolves LAZILY. Every test here restores the default first,
 * so the suite cannot become order-dependent on whichever test installed a
 * profile last — that is the whole reason `resetActiveProfile` exists.
 */
describe('vocabulary', () => {
  beforeEach(() => {
    resetActiveProfile();
  });

  afterEach(() => {
    resetActiveProfile();
  });

  it('resolves the shipped profile when nobody installed one', () => {
    expect(activeProfile().name).toBe('default');
    expect(atomDomains()).toContain('docs');
  });

  it('memoizes the resolved profile, so a second read is the same object', () => {
    expect(activeProfile()).toBe(activeProfile());
  });

  it('reads every derived value off the profile a caller installs', () => {
    const huTax = loadIngestProfile(resolve(profilesDir(), 'hu-tax.profile.json'));
    setActiveProfile(huTax);
    expect(activeProfile()).toBe(huTax);
    expect(atomDomains()).toEqual(huTax.domains);
    expect(defaultAtomType()).toBe(huTax.defaultType);
    expect(sourceRootDomains().map(rule => rule.prefix)).toEqual(
      huTax.domainRules.map(rule => rule.prefix)
    );
  });

  it('restores the shipped profile on reset, so an install never leaks', () => {
    const shipped = activeProfile();
    setActiveProfile(loadIngestProfile(resolve(profilesDir(), 'hu-tax.profile.json')));
    expect(activeProfile().name).not.toBe(shipped.name);
    resetActiveProfile();
    expect(activeProfile().name).toBe(shipped.name);
    expect(defaultExcludedTypes()).toEqual(shipped.defaultExcludedTypes ?? []);
  });

  it('labels a source path from the ACTIVE profile, not from an import-time snapshot', () => {
    expect(domainForSource('docs/research/x.md')).toBe('docs');
    expect(typeForSource('docs/research/x.md')).toBe('research');
    setActiveProfile(loadIngestProfile(resolve(profilesDir(), 'hu-tax.profile.json')));
    expect(domainForSource('docs/research/x.md')).toBeUndefined();
  });
});
