import { ATOM_TYPES, domainForSource, typeForSource } from '../src/config.js';

/** The measured prefix→domain table, restated as the contract ingest must satisfy. */
const DOMAIN_CASES: readonly (readonly [string, string | undefined])[] = [
  ['RUNNER-CHANGE.md', 'runner'],
  ['tools/agentic-code-runner/src/index.ts', 'runner'],
  ['claude-artifacts/standards/TS-TESTING.md', 'standards'],
  ['doc/40-code-standards/90-decisions/ADR-018.md', 'adr'],
  ['claude-artifacts/speckit/workflow.md', 'standards'],
  ['doc/85-teaching/retrieval-101.md', 'docs'],
  ['.claude/agents/code-logic-writer.md', 'claude'],
  ['dp-gnosis/corpus-hu/odoo/bevezetes.md', 'docs'],
  ['dp-gnosis/cache/bench/corpus-ext/sql-postgresql/x.md', 'docs'],
  ['src/db/idb.ts', undefined],
];

describe('domainForSource', () => {
  it('maps every declared root to its domain, and an unclaimed path to undefined', () => {
    expect(DOMAIN_CASES.map(([path]) => domainForSource(path))).toEqual(
      DOMAIN_CASES.map(([, domain]) => domain)
    );
  });

  it('lets the longer root win over the shorter one containing it', () => {
    expect(domainForSource('claude-artifacts/standards/TS-E2E-TESTING.md')).toBe('standards');
    expect(domainForSource('doc/40-code-standards/90-decisions/ADR-001.md')).toBe('adr');
    expect(domainForSource('doc/40-code-standards/naming.md')).toBe('docs');
  });

  it('claims the external benchmark corpus root without claiming its parents', () => {
    expect(domainForSource('dp-gnosis/cache/bench/corpus-ext/css-sass/x.md')).toBe('docs');
    expect(domainForSource('dp-gnosis/cache/bench/other/x.md')).toBeUndefined();
    expect(domainForSource('dp-gnosis/cache/index.json')).toBeUndefined();
  });
});

/** The measured prefix→type table, restated as the contract ingest must satisfy. */
const CASES: readonly (readonly [string, string])[] = [
  ['doc/90-history/10-feature-log/047-engine.md', 'feature-log'],
  ['doc/80-research-library/papers/rag-survey.md', 'paper'],
  ['doc/90-history/20-benchmark-runs/2026-08-01.md', 'benchmark'],
  ['doc/90-history/30-reviews/pre-merge-044.md', 'review'],
  ['doc/40-code-standards/90-decisions/ADR-018.md', 'adr'],
  ['doc/80-research-library/vendor-docs/lancedb.md', 'vendor-doc'],
  ['doc/85-teaching/retrieval-101.md', 'teaching'],
  ['doc/_meta/conventions.md', 'meta'],
  ['claude-artifacts/agentic-runner-rules/atoms/code/decomposition.md', 'runner-rule'],
  ['claude-artifacts/standards/TS-TESTING.md', 'standard'],
  ['doc/40-code-standards/naming.md', 'standard'],
  ['doc/50-testing-strategy/layers.md', 'standard'],
  ['dp-gnosis/cache/bench/corpus-ext/sql-postgresql/x.md', 'vendor-doc'],
];

describe('typeForSource', () => {
  it('maps every declared prefix to its type', () => {
    expect(CASES.map(([path]) => typeForSource(path))).toEqual(CASES.map(([, type]) => type));
  });

  it('maps a 95-brainstorms segment to brainstorm under any parent', () => {
    expect(typeForSource('doc/30-spec-driven-workflow/95-brainstorms/dag.md')).toBe('brainstorm');
    expect(typeForSource('doc/10-agentic-runner/95-brainstorms/ladder.md')).toBe('brainstorm');
    expect(typeForSource('doc/60-aichatney-app/95-brainstorms/chat.md')).toBe('brainstorm');
  });

  it('falls back to knowledge for a path no rule claims', () => {
    expect(typeForSource('RUNNER-CHANGE.md')).toBe('knowledge');
    expect(typeForSource('doc/70-unlisted/notes.md')).toBe('knowledge');
  });

  it('lets the longer prefix win over the shorter one containing it', () => {
    expect(typeForSource('doc/40-code-standards/90-decisions/ADR-001.md')).toBe('adr');
    expect(typeForSource('doc/40-code-standards/90-decisions-notes.md')).toBe('standard');
  });

  it('resolves every path to a member of the closed vocabulary', () => {
    const resolved = CASES.map(([path]) => typeForSource(path));
    expect(resolved.every(type => ATOM_TYPES.includes(type))).toBe(true);
  });
});
