import { isAbsolute } from 'node:path';

import {
  ATOM_CHUNK_TARGET_CHARS,
  ATOM_DOMAINS,
  ATOM_MAX_CHARS,
  CORPUS_ROOTS,
  CORPUS_ROOTS_ENV_VAR,
  domainForSource,
  resolveCorpusRoots,
  SOURCE_ROOT_DOMAINS
} from '../src/config.js';
import {
  ATOMS_DIR,
  DOCS_TEST_DIR,
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

  it('composes the vault and cache trees under one top-level dp-gnosis dir', () => {
    expect(VAULT_ROOT).toBe(`${REPO_ROOT}/dp-gnosis/vault`);
    expect(ATOMS_DIR).toBe(`${VAULT_ROOT}/atoms`);
    expect(PROPOSALS_DIR).toBe(`${VAULT_ROOT}/proposals`);
    expect(RUNTIME_ROOT).toBe(`${REPO_ROOT}/dp-gnosis/cache`);
    expect(INDEX_DIR).toBe(`${RUNTIME_ROOT}/index`);
  });

  /**
   * Reports are committed human-facing documents, so they stay in the repo's
   * shared docs tree — putting them under the gitignored cache would delete the
   * comparison history the bench exists to produce.
   */
  it('keeps benchmark reports outside the disposable cache', () => {
    expect(DOCS_TEST_DIR).toBe(`${REPO_ROOT}/docs/test`);
    expect(DOCS_TEST_DIR.startsWith(RUNTIME_ROOT)).toBe(false);
  });

  it('anchors REPO_ROOT on this package, not the working directory', () => {
    expect(REPO_ROOT.endsWith('/tools/dp-gnosis')).toBe(false);
    expect(ATOMS_DIR).toContain('/dp-gnosis/vault/atoms');
  });
});

describe('resolveCorpusRoots', () => {
  it('defaults to the declared corpus roots when the override is absent or blank', () => {
    expect(CORPUS_ROOTS).toEqual(['doc', 'claude-artifacts', 'RUNNER-*.md']);
    expect(resolveCorpusRoots({})).toEqual(CORPUS_ROOTS);
    expect(resolveCorpusRoots({ [CORPUS_ROOTS_ENV_VAR]: '' })).toEqual(CORPUS_ROOTS);
    expect(resolveCorpusRoots({ [CORPUS_ROOTS_ENV_VAR]: ' , ' })).toEqual(CORPUS_ROOTS);
  });

  it('reads a comma-separated override, trimming blanks and dropping empties', () => {
    expect(resolveCorpusRoots({ [CORPUS_ROOTS_ENV_VAR]: 'doc, claude-artifacts ,,' })).toEqual([
      'doc',
      'claude-artifacts',
    ]);
  });
});

describe('domainForSource', () => {
  it('maps every declared source root to its domain', () => {
    const mapped = SOURCE_ROOT_DOMAINS.map(rule => domainForSource(`${rule.prefix}x.md`));
    expect(mapped).toEqual(SOURCE_ROOT_DOMAINS.map(rule => rule.domain));
  });

  it('maps every known prefix explicitly', () => {
    expect(domainForSource('RUNNER-GUIDE.md')).toBe('runner');
    expect(domainForSource('tools/agentic-code-runner/README.md')).toBe('runner');
    expect(domainForSource('claude-artifacts/standards/TS-TESTING.md')).toBe('standards');
    expect(domainForSource('doc/40-code-standards/90-decisions/adr-018-layered-tests.md')).toBe(
      'adr'
    );
    expect(domainForSource('claude-artifacts/speckit/workflow.md')).toBe('standards');
    expect(domainForSource('doc/50-testing-strategy/overview.md')).toBe('docs');
    expect(domainForSource('.claude/agents/code-logic-writer.md')).toBe('claude');
  });

  /**
   * The precedence pair that a broad catch-all row can silently break: both
   * nested roots sit inside a broader one, and losing longest-prefix-wins would
   * relabel every atom under them without failing anything else.
   */
  it('prefers the longest matching prefix over the broader root containing it', () => {
    expect(domainForSource('claude-artifacts/standards/TS-TESTING.md')).toBe('standards');
    expect(domainForSource('doc/40-code-standards/90-decisions/adr-1.md')).toBe('adr');
    expect(domainForSource('doc/40-code-standards/naming.md')).toBe('docs');
  });

  /**
   * Guards the mechanism itself: every nested root MUST still resolve to its
   * own domain, however the table happens to be ordered. Derived from the table
   * rather than hardcoded, so a future nested root is covered on the day it is
   * added.
   */
  it('resolves every nested root to its own domain, not the broader one', () => {
    const nested = SOURCE_ROOT_DOMAINS.filter(rule =>
      SOURCE_ROOT_DOMAINS.some(
        other => other.prefix.length < rule.prefix.length && rule.prefix.startsWith(other.prefix)
      )
    );

    expect(nested.map(rule => rule.prefix)).toEqual([
      'claude-artifacts/standards/',
      'doc/40-code-standards/90-decisions/',
    ]);
    expect(nested.map(rule => domainForSource(`${rule.prefix}x.md`))).toEqual(['standards', 'adr']);
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
