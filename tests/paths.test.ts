import { isAbsolute } from 'node:path';

import {
  ATOM_CHUNK_TARGET_CHARS,
  ATOM_DOMAINS,
  ATOM_MAX_CHARS,
  domainForSource,
  SOURCE_ROOT_DOMAINS
} from '../src/config.js';
import {
  ATOMS_DIR,
  INDEX_DIR,
  PROPOSALS_DIR,
  REPO_ROOT,
  RUNTIME_ROOT,
  VAULT_ROOT
} from '../src/paths.js';

describe('paths', () => {
  it('exposes only absolute paths', () => {
    const all = [REPO_ROOT, VAULT_ROOT, ATOMS_DIR, PROPOSALS_DIR, RUNTIME_ROOT, INDEX_DIR];
    expect(all.every(p => isAbsolute(p))).toBe(true);
  });

  it('composes the vault and runtime trees under the repo root', () => {
    expect(VAULT_ROOT).toBe(`${REPO_ROOT}/gnosis`);
    expect(ATOMS_DIR).toBe(`${VAULT_ROOT}/atoms`);
    expect(PROPOSALS_DIR).toBe(`${VAULT_ROOT}/proposals`);
    expect(RUNTIME_ROOT).toBe(`${REPO_ROOT}/.dp-gnosis`);
    expect(INDEX_DIR).toBe(`${RUNTIME_ROOT}/index`);
  });

  it('anchors REPO_ROOT on this package, not the working directory', () => {
    expect(REPO_ROOT.endsWith('/tools/dp-gnosis')).toBe(false);
    expect(ATOMS_DIR).toContain('/gnosis/atoms');
  });
});

describe('domainForSource', () => {
  it('maps every declared source root to its domain', () => {
    const mapped = SOURCE_ROOT_DOMAINS.map(rule => domainForSource(`${rule.prefix}x.md`));
    expect(mapped).toEqual(SOURCE_ROOT_DOMAINS.map(rule => rule.domain));
  });

  it('maps the four known prefixes explicitly', () => {
    expect(domainForSource('RUNNER-GUIDE.md')).toBe('runner');
    expect(domainForSource('tools/agentic-code-runner/README.md')).toBe('runner');
    expect(domainForSource('claude-artifacts/standards/TS-TESTING.md')).toBe('standards');
    expect(domainForSource('doc/40-code-standards/90-decisions/adr-018-layered-tests.md')).toBe(
      'adr'
    );
  });

  it('returns undefined for an unmapped path', () => {
    expect(domainForSource('src/features/chat/index.ts')).toBeUndefined();
    expect(domainForSource('docs/plans/some-plan.md')).toBeUndefined();
    expect(domainForSource('')).toBeUndefined();
  });

  it('only ever yields a member of the closed domain vocabulary', () => {
    const domains = SOURCE_ROOT_DOMAINS.map(rule => rule.domain);
    expect(domains.every(d => ATOM_DOMAINS.includes(d))).toBe(true);
  });
});

describe('atom size policy', () => {
  it('targets chunks below the hard cap', () => {
    expect(ATOM_CHUNK_TARGET_CHARS).toBeLessThan(ATOM_MAX_CHARS);
  });
});
