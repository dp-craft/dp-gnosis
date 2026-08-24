import type { Atom, AtomFrontmatter } from '../src/atom.js';
import { parseAtom, serializeAtom } from '../src/atom.js';

const lf = (lines: readonly string[]): string => lines.join('\n');
const crlf = (lines: readonly string[]): string => lines.join('\r\n');

const MINIMAL_LINES = [
  '---',
  'type: knowledge',
  'id: fts5-tokenizer-choice',
  'title: FTS5 tokenizer selection',
  'x_domain: runner',
  'status: stable',
  'sources:',
  '  - https://sqlite.org/fts5.html',
  '---',
  'Body prose.',
  '',
];

const FULL_LINES = [
  '---',
  'type: knowledge',
  'id: fts5-tokenizer-choice',
  'title: FTS5 tokenizer selection',
  'x_domain: runner',
  'status: stable',
  'stale_after: 2027-01-01',
  'sources:',
  '  - https://sqlite.org/fts5.html',
  'verified_by: deterministic-oracle',
  'verified_at: 2026-08-08',
  '---',
  'Body prose.',
  '',
];

const DRAFT_LINES = [
  '---',
  'type: knowledge',
  'id: draft-atom',
  'title: Draft atom',
  'x_domain: standards',
  'status: draft',
  'sources:',
  '  - claude-artifacts/standards/TS-TESTING.md',
  '---',
  'Body prose.',
  '',
];

const MULTI_SOURCE_LINES = [
  '---',
  'type: knowledge',
  'id: multi',
  'title: Multiple sources',
  'x_domain: standards',
  'status: draft',
  'sources:',
  '  - https://example.com/one',
  '  - https://example.com/two',
  '  - claude-artifacts/standards/TS-TESTING.md',
  '---',
  'Body prose.',
  '',
];

const DASHY_BODY_LINES = [
  '---',
  'type: knowledge',
  'id: dashy',
  'title: Body holds a delimiter line',
  'x_domain: adr',
  'status: deprecated',
  'sources:',
  '  - docs/adrs/ADR-018.md',
  '---',
  'Before.',
  '---',
  'After.',
  '',
];

const NO_TRAILING_NEWLINE_LINES = [
  '---',
  'type: knowledge',
  'id: no-trailing',
  'title: No trailing newline',
  'x_domain: runner',
  'status: stable',
  'sources:',
  '  - https://example.com/a',
  '---',
  'Body without a final newline.',
];

const EMPTY_BODY_LINES = [
  '---',
  'type: knowledge',
  'id: empty-body',
  'title: Empty body',
  'x_domain: runner',
  'status: stable',
  'sources:',
  '  - https://example.com/a',
  '---',
  '',
];

const TWO_TRAILING_NEWLINES_LINES = [...MINIMAL_LINES, ''];

const parsed = (text: string): Atom => {
  const result = parseAtom(text);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result.atom;
};

const errorOf = (text: string): string => {
  const result = parseAtom(text);
  if (result.ok) throw new Error('expected a refusal, got a parsed atom');
  return result.error;
};

describe('parseAtom / serializeAtom round-trip', () => {
  const fixtures: readonly (readonly [string, string])[] = [
    ['no optional fields', lf(MINIMAL_LINES)],
    ['all optional fields', lf(FULL_LINES)],
    ['a draft with a repo-relative source', lf(DRAFT_LINES)],
    ['body containing a --- line', lf(DASHY_BODY_LINES)],
    ['no trailing newline', lf(NO_TRAILING_NEWLINE_LINES)],
    ['empty body', lf(EMPTY_BODY_LINES)],
    ['two trailing newlines', lf(TWO_TRAILING_NEWLINES_LINES)],
    ['CRLF document', crlf(FULL_LINES)],
    ['CRLF document, body holds a --- line', crlf(DASHY_BODY_LINES)],
  ];

  fixtures.forEach(([name, text]) => {
    it(`is byte-identical for: ${name}`, () => {
      const atom = parsed(text);
      expect(serializeAtom(atom.frontmatter, atom.body)).toBe(text);
    });
  });
});

describe('parseAtom field extraction', () => {
  it('reads every scalar and the flat source list', () => {
    const atom = parsed(lf(FULL_LINES));
    expect(atom.frontmatter).toEqual({
      type: 'knowledge',
      id: 'fts5-tokenizer-choice',
      title: 'FTS5 tokenizer selection',
      x_domain: 'runner',
      status: 'stable',
      stale_after: '2027-01-01',
      sources: ['https://sqlite.org/fts5.html'],
      verified_by: 'deterministic-oracle',
      verified_at: '2026-08-08',
    });
    expect(atom.body).toBe('Body prose.\n');
  });

  it('omits absent optional fields rather than setting them undefined', () => {
    const atom = parsed(lf(MINIMAL_LINES));
    expect(Object.keys(atom.frontmatter).sort()).toEqual([
      'id',
      'sources',
      'status',
      'title',
      'type',
      'x_domain',
    ]);
  });

  it('keeps the body verbatim, including a delimiter line', () => {
    expect(parsed(lf(DASHY_BODY_LINES)).body).toBe('Before.\n---\nAfter.\n');
  });

  it('reads all three status values', () => {
    expect(parsed(lf(MINIMAL_LINES)).frontmatter.status).toBe('stable');
    expect(parsed(lf(DRAFT_LINES)).frontmatter.status).toBe('draft');
    expect(parsed(lf(DASHY_BODY_LINES)).frontmatter.status).toBe('deprecated');
  });

  it('accepts fields in any order and serializes them canonically', () => {
    const shuffled = lf([
      '---',
      'status: stable',
      'verified_at: 2026-08-08',
      'title: FTS5 tokenizer selection',
      'sources:',
      '  - https://sqlite.org/fts5.html',
      'id: fts5-tokenizer-choice',
      'verified_by: deterministic-oracle',
      'stale_after: 2027-01-01',
      'x_domain: runner',
      'type: knowledge',
      '---',
      'Body prose.',
      '',
    ]);
    const atom = parsed(shuffled);
    expect(serializeAtom(atom.frontmatter, atom.body)).toBe(lf(FULL_LINES));
  });
});

describe('parseAtom refusals (closed subset)', () => {
  const withFrontmatter = (fields: readonly string[]): string =>
    lf(['---', ...fields, '---', 'Body prose.', '']);

  const VALID_FIELDS = [
    'type: knowledge',
    'id: a',
    'title: A',
    'x_domain: runner',
    'status: stable',
    'sources:',
    '  - https://example.com/a',
  ];

  it('refuses a nested sources mapping and names the flat form', () => {
    const text = withFrontmatter([
      'type: knowledge',
      'id: a',
      'title: A',
      'x_domain: runner',
      'status: stable',
      'sources:',
      '  - url: https://example.com/a',
      '    title: Example',
    ]);
    const error = errorOf(text);
    expect(error).toContain('sources');
    expect(error).toContain('flat');
    expect(error).toContain('  - https://');
  });

  it('refuses a nested continuation line under a flat source', () => {
    const error = errorOf(
      withFrontmatter([...VALID_FIELDS, '    title: Example'])
    );
    expect(error).toContain('flat');
  });

  it('refuses a document with no opening delimiter', () => {
    expect(errorOf('type: knowledge\n')).toContain('---');
  });

  it('refuses an unterminated frontmatter block', () => {
    expect(errorOf(lf(['---', ...VALID_FIELDS, 'Body prose.', '']))).toContain('---');
  });

  it('refuses a closing delimiter with no trailing newline', () => {
    expect(errorOf(lf(['---', ...VALID_FIELDS, '---']))).toContain('---');
  });

  it('refuses an unknown field', () => {
    expect(errorOf(withFrontmatter([...VALID_FIELDS, 'x_confidence: 0.9']))).toContain(
      'x_confidence'
    );
  });

  it('refuses a duplicated field', () => {
    expect(errorOf(withFrontmatter([...VALID_FIELDS, 'id: b']))).toContain('duplicate');
  });

  it('refuses a duplicated sources block', () => {
    expect(
      errorOf(withFrontmatter([...VALID_FIELDS, 'sources:', '  - https://example.com/b']))
    ).toContain('duplicate');
  });

  it('refuses each missing required field', () => {
    const required = ['type', 'id', 'title', 'x_domain', 'status'];
    required.forEach(key => {
      const fields = VALID_FIELDS.filter(line => !line.startsWith(`${key}: `));
      expect(errorOf(withFrontmatter(fields))).toContain(key);
    });
  });

  it('refuses an atom with no sources', () => {
    expect(errorOf(withFrontmatter(VALID_FIELDS.slice(0, 5)))).toContain('sources');
  });

  it('refuses an empty sources block', () => {
    expect(errorOf(withFrontmatter([...VALID_FIELDS.slice(0, 5), 'sources:']))).toContain(
      'sources'
    );
  });

  /**
   * AT LEAST one, not exactly one: `ingest.ts` merges the provenance of a
   * byte-identical duplicate group into the surviving copy, so an atom
   * legitimately names every source document whose body it represents.
   */
  it('ACCEPTS more than one source and keeps them in authored order', () => {
    const text = withFrontmatter([...VALID_FIELDS, '  - https://example.com/b']);
    const parsed = parseAtom(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.atom.frontmatter.sources).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('round-trips the three-source fixture byte-identically', () => {
    const text = lf(MULTI_SOURCE_LINES);
    const parsed = parseAtom(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.atom.frontmatter.sources).toHaveLength(3);
    expect(serializeAtom(parsed.atom.frontmatter, parsed.atom.body)).toBe(text);
  });

  it('keeps the empty-sources message distinct from the too-many message', () => {
    expect(errorOf(withFrontmatter(VALID_FIELDS.slice(0, 5)))).toBe(
      'missing required field "sources" — at least one flat source string is required'
    );
  });

  it('accepts exactly one source', () => {
    expect(parsed(withFrontmatter(VALID_FIELDS)).frontmatter.sources).toEqual([
      'https://example.com/a',
    ]);
  });

  it('refuses a status outside the closed vocabulary', () => {
    const fields = VALID_FIELDS.map(line =>
      line === 'status: stable' ? 'status: verified' : line
    );
    const error = errorOf(withFrontmatter(fields));
    expect(error).toContain('status');
    expect(error).toContain('draft');
  });

  it('refuses a relative or malformed date', () => {
    expect(errorOf(withFrontmatter([...VALID_FIELDS, 'stale_after: in 6 months']))).toContain(
      'YYYY-MM-DD'
    );
    expect(errorOf(withFrontmatter([...VALID_FIELDS, 'verified_at: 2026-8-8']))).toContain(
      'YYYY-MM-DD'
    );
  });

  it('refuses padding that would break the byte-identical round-trip', () => {
    expect(errorOf(withFrontmatter([...VALID_FIELDS, 'verified_by:  padded']))).toContain(
      'verified_by:  padded'
    );
    expect(errorOf(withFrontmatter([...VALID_FIELDS, 'verified_by: trailing ']))).toContain(
      'verified_by: trailing'
    );
  });

  it('refuses a source item that is not indented exactly two spaces', () => {
    expect(errorOf(withFrontmatter([...VALID_FIELDS.slice(0, 6), '- https://example.com/a']))).toContain(
      '- https://example.com/a'
    );
  });

  it('refuses an empty frontmatter block', () => {
    expect(errorOf(lf(['---', '---', 'Body prose.', '']))).toContain('type');
  });
});

describe('serializeAtom', () => {
  const FRONTMATTER: AtomFrontmatter = {
    type: 'knowledge',
    id: 'a',
    title: 'A',
    x_domain: 'runner',
    status: 'stable',
    sources: ['https://example.com/a'],
  };

  it('emits the canonical field order with sources between stale_after and verified_by', () => {
    const text = serializeAtom(
      {
        ...FRONTMATTER,
        stale_after: '2027-01-01',
        verified_by: 'deterministic-oracle',
        verified_at: '2026-08-08',
      },
      'Body prose.\n'
    );
    expect(text.split('\n').slice(0, 12)).toEqual([
      '---',
      'type: knowledge',
      'id: a',
      'title: A',
      'x_domain: runner',
      'status: stable',
      'stale_after: 2027-01-01',
      'sources:',
      '  - https://example.com/a',
      'verified_by: deterministic-oracle',
      'verified_at: 2026-08-08',
      '---',
    ]);
  });

  it('follows the body EOL convention for the frontmatter block', () => {
    expect(serializeAtom(FRONTMATTER, 'one\r\ntwo\r\n')).toContain('---\r\ntype: knowledge\r\n');
    expect(serializeAtom(FRONTMATTER, 'one\ntwo\n')).toContain('---\ntype: knowledge\n');
  });
});
