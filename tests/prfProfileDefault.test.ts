/**
 * The PROFILE-CARRIED feedback default: what the shipped profiles state, how
 * argv and the profile compose, and the seam the BENCH sits behind.
 *
 * The flag surface itself is pinned in `prfCli.test.ts`, the model in
 * `prf.test.ts` and the rescore in `fts5Adapter.test.ts`; this file owns the
 * DEFAULT's provenance and its resolution order alone.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPort } from '../src/cli/adapter.js';
import type { FlagValues } from '../src/cli/args.js';
import { runCli } from '../src/cli/cli.js';
import { resolvePrf } from '../src/cli/retrieveCommand.js';
import { loadIngestProfile, parseIngestProfile } from '../src/ingestProfile.js';
import { SERVED_PRF_PARAMS } from '../src/prf.js';

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

describe('profile defaultPrf', () => {
  it('is ABSENT unless the profile states it, so an external profile is unchanged', () => {
    const parsed = parseIngestProfile(RAW_PROFILE, 'probe.json');

    expect(parsed.defaultPrf).toBeUndefined();
    expect(profileAt('web-research.profile.json').defaultPrf).toBeUndefined();
  });

  it('carries the MEASURED cell on both shipped profiles — one owner, not two literals', () => {
    expect(SERVED_PRF_PARAMS).toEqual({ fbDocs: 10, fbTerms: 40, alpha: 0.5 });
    expect(profileAt('default.profile.json').defaultPrf).toEqual(SERVED_PRF_PARAMS);
    expect(profileAt('hu-tax.profile.json').defaultPrf).toEqual(SERVED_PRF_PARAMS);
  });

  it.each([
    ['fbDocs', 0],
    ['fbTerms', 1.5],
    ['alpha', 2],
  ])('REFUSES a malformed %s rather than correcting it', (key, value) => {
    const raw = { ...RAW_PROFILE, defaultPrf: { ...SERVED_PRF_PARAMS, [key]: value } };

    expect(() => parseIngestProfile(raw, 'probe.json')).toThrow(key);
  });
});

const flags = (values: FlagValues): FlagValues => values;

describe('resolvePrf — flag beats profile beats OFF', () => {
  it('takes the profile cell when argv states nothing', () => {
    const resolved = resolvePrf(flags({}), 'fts5', SERVED_PRF_PARAMS);

    expect(resolved).toEqual({
      ok: true,
      prf: SERVED_PRF_PARAMS,
      prfSource: 'profile',
      prfNote: undefined,
    });
  });

  it('is OFF when neither argv nor the profile turns it on', () => {
    expect(resolvePrf(flags({}), 'fts5', undefined)).toEqual({
      ok: true,
      prf: undefined,
      prfSource: undefined,
      prfNote: undefined,
    });
  });

  it('--no-prf turns a profile default OFF, so the losing leg stays testable', () => {
    const resolved = resolvePrf(flags({ '--no-prf': true }), 'fts5', SERVED_PRF_PARAMS);

    expect(resolved).toEqual({
      ok: true,
      prf: undefined,
      prfSource: undefined,
      prfNote: undefined,
    });
  });

  it('lets an explicit tuning flag override one field of the profile cell', () => {
    const resolved = resolvePrf(flags({ '--prf-terms': '5' }), 'fts5', SERVED_PRF_PARAMS);

    expect(resolved).toEqual({
      ok: true,
      prf: { fbDocs: 10, fbTerms: 5, alpha: 0.5 },
      prfSource: 'profile',
      prfNote: undefined,
    });
  });

  it('still refuses a tuning flag when PRF is off overall', () => {
    const off = resolvePrf(flags({ '--prf-docs': '3' }), 'fts5', undefined);
    const disabled = resolvePrf(
      flags({ '--prf-docs': '3', '--no-prf': true }),
      'fts5',
      SERVED_PRF_PARAMS
    );

    expect(off).toEqual({ ok: false, error: expect.stringContaining('--prf-docs') });
    expect(disabled).toEqual({ ok: false, error: expect.stringContaining('--prf-docs') });
  });

  it('refuses --prf and --no-prf together rather than resolving the contradiction', () => {
    const both = resolvePrf(flags({ '--prf': true, '--no-prf': true }), 'fts5', undefined);

    expect(both).toEqual({ ok: false, error: expect.stringContaining('--no-prf') });
  });

  it('REFUSES an explicit --prf on an adapter that cannot carry the rescore', () => {
    const refused = resolvePrf(flags({ '--prf': true }), 'linear', SERVED_PRF_PARAMS);

    expect(refused).toEqual({ ok: false, error: expect.stringContaining('linear') });
  });

  it('lets a PROFILE default run unexpanded there, and SAYS so', () => {
    const resolved = resolvePrf(flags({}), 'linear', SERVED_PRF_PARAMS);

    expect(resolved.ok).toBe(true);
    expect(resolved).toMatchObject({ prf: undefined });
    expect(resolved.ok && resolved.prfNote).toContain('linear');
  });
});

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

const LABELS = ['Alpha', 'Bravo', 'Delta'] as const;

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-prf-profile-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await Promise.all(
    LABELS.map(label =>
      writeFile(
        join(corpus, `${label}.md`),
        `# Zestful Retrieval ${label}\n\nzestful retrieval selector stability memo render ${label}\n`,
        'utf8'
      )
    )
  );
  const atomsDir = join(repoRoot, 'atoms');
  const indexPath = join(repoRoot, 'index', 'atoms.db');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  await runCli(['index', '--atoms-dir', atomsDir, '--index-path', indexPath, '--adapter', 'fts5']);
  return { repoRoot, atomsDir, indexPath };
};

describe('the bench seam', () => {
  it('is byte-identical with no prf option, whichever profile is loaded', async () => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    const fixture = await makeFixture();
    vi.unstubAllEnvs();
    const benchRetrieve = async (): Promise<string> => {
      const port = createPort('fts5', fixture.atomsDir, fixture.indexPath);
      const result = await port.retrieve('zestful retrieval', { k: 3 });
      port.close?.();
      return JSON.stringify(result);
    };

    const withDefaultProfile = await benchRetrieve();
    expect(profileAt('default.profile.json').defaultPrf).toEqual(SERVED_PRF_PARAMS);
    const withPrfLessProfile = await benchRetrieve();
    expect(profileAt('web-research.profile.json').defaultPrf).toBeUndefined();

    expect(withPrfLessProfile).toBe(withDefaultProfile);
  });
});
