import type { AtomFrontmatter, AtomStatus } from '../src/atom.js';
import { isRetrievable } from '../src/retrievability.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

const frontmatter = (status: AtomStatus, staleAfter?: string): AtomFrontmatter => ({
  type: 'knowledge_atom',
  id: 'runner-gate-contract',
  title: 'Gate contract',
  x_domain: 'runner',
  status,
  ...(staleAfter === undefined ? {} : { stale_after: staleAfter }),
  sources: ['RUNNER-CHANGE.md'],
});

describe('isRetrievable', () => {
  it('returns draft and stable atoms', () => {
    expect(isRetrievable(frontmatter('draft'), NOW)).toBe(true);
    expect(isRetrievable(frontmatter('stable'), NOW)).toBe(true);
  });

  it('excludes a deprecated atom', () => {
    expect(isRetrievable(frontmatter('deprecated'), NOW)).toBe(false);
  });

  it('excludes an atom whose stale_after is strictly in the past', () => {
    expect(isRetrievable(frontmatter('stable', '2026-08-07'), NOW)).toBe(false);
  });

  it('returns an atom whose stale_after is in the future', () => {
    expect(isRetrievable(frontmatter('stable', '2026-08-09'), NOW)).toBe(true);
  });

  // Boundary rule: stale_after names the LAST day the atom is valid, so an atom
  // whose stale_after equals today's UTC calendar day is still retrievable.
  it('returns an atom whose stale_after is exactly today (UTC)', () => {
    expect(isRetrievable(frontmatter('stable', '2026-08-08'), NOW)).toBe(true);
    expect(isRetrievable(frontmatter('stable', '2026-08-08'), new Date('2026-08-08T23:59:59Z'))).toBe(
      true
    );
    expect(isRetrievable(frontmatter('stable', '2026-08-08'), new Date('2026-08-09T00:00:00Z'))).toBe(
      false
    );
  });

  it('returns an atom with no stale_after at all', () => {
    expect(isRetrievable(frontmatter('stable'), NOW)).toBe(true);
  });

  it('excludes a deprecated atom even when its stale_after is in the future', () => {
    expect(isRetrievable(frontmatter('deprecated', '2099-01-01'), NOW)).toBe(false);
  });
});
