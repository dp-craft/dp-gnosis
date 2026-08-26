/**
 * The PROFILE-CARRIED analyzer default: what the shipped profiles state, and
 * the refusal an unknown chain id earns.
 *
 * The chains themselves are pinned in `query.test.ts` and the stamp the index
 * carries in `fts5Adapter.test.ts`; this file owns the DEFAULT's provenance —
 * that it is absent-means-`DEFAULT_ANALYZER`, and that it is CORPUS-SCOPED.
 */
import { join, resolve } from 'node:path';

import { loadIngestProfile, parseIngestProfile } from '../src/ingestProfile.js';
import { DEFAULT_ANALYZER } from '../src/query.js';

const PROFILE_DIR = resolve(__dirname, '..', 'profiles');

const profileAt = (name: string) => loadIngestProfile(join(PROFILE_DIR, name));

const RAW_PROFILE = {
  name: 'probe',
  domains: ['engineering'],
  types: ['knowledge'],
  defaultType: 'knowledge',
  domainRules: [{ prefix: 'doc', domain: 'engineering' }],
  typeRules: [],
  segmentRules: [],
};

describe('profile defaultAnalyzer', () => {
  it('is ABSENT unless the profile states it, and ROUND-TRIPS the id when it does', () => {
    const absent = parseIngestProfile(RAW_PROFILE, 'probe.json');
    const stated = parseIngestProfile(
      { ...RAW_PROFILE, defaultAnalyzer: 'hulight-fold' },
      'probe.json'
    );

    expect(absent.defaultAnalyzer).toBeUndefined();
    expect(stated.defaultAnalyzer).toBe('hulight-fold');
  });

  it('carries the MEASURED Hungarian chain on the shipped hu-tax profile ALONE', () => {
    expect(DEFAULT_ANALYZER).toBe('porter-fold');
    expect(profileAt('hu-tax.profile.json').defaultAnalyzer).toBe('ident-hulight-fold');
    expect(profileAt('default.profile.json').defaultAnalyzer).toBeUndefined();
    expect(profileAt('web-research.profile.json').defaultAnalyzer).toBeUndefined();
  });

  it('REFUSES an unknown chain id, naming the value rather than falling back', () => {
    const raw = { ...RAW_PROFILE, defaultAnalyzer: 'hunspell-fold' };

    expect(() => parseIngestProfile(raw, 'probe.json')).toThrow('hunspell-fold');
  });

  it('names the known chain ids in the refusal, so a typo is correctable', () => {
    const raw = { ...RAW_PROFILE, defaultAnalyzer: 'porter-folds' };

    expect(() => parseIngestProfile(raw, 'probe.json')).toThrow('ident-hulight-fold');
  });

  it('REFUSES a present-but-non-string value rather than coercing it', () => {
    const raw = { ...RAW_PROFILE, defaultAnalyzer: 7 };

    expect(() => parseIngestProfile(raw, 'probe.json')).toThrow(/"defaultAnalyzer" is "7"/);
  });
});
