import type { AtomFrontmatter } from '../src/atom.js';
import { parseAtom, serializeAtom } from '../src/atom.js';
import { extractFootnotes } from '../src/footnotes.js';

const FRONTMATTER: AtomFrontmatter = {
  type: 'knowledge',
  id: 'footnote-carrier',
  title: 'Footnote carrier',
  x_domain: 'runner',
  status: 'stable',
  sources: ['https://example.com/a'],
};

const BODY = [
  'FTS5 uses the unicode61 tokenizer by default.[^tokenizer]',
  '',
  'A fenced block is prose, not a definition:',
  '',
  '```md',
  '[^fenced]: this line only looks like a definition',
  '```',
  '',
  '[^tokenizer]: SQLite FTS5 documentation, section 4.1 — the default',
  '    tokenizer is unicode61, and porter is a wrapper around it.',
  '[^second]: A single-line attribution.',
  '',
].join('\n');

describe('extractFootnotes', () => {
  it('extracts definitions in document order', () => {
    expect(extractFootnotes(BODY).map(note => note.label)).toEqual(['tokenizer', 'second']);
  });

  it('joins a multi-line definition and dedents its continuation', () => {
    const notes = extractFootnotes(BODY);
    expect(notes[0]?.text).toBe(
      'SQLite FTS5 documentation, section 4.1 — the default\ntokenizer is unicode61, and porter is a wrapper around it.'
    );
    expect(notes[1]?.text).toBe('A single-line attribution.');
  });

  it('ignores a definition-shaped line inside a fenced code block', () => {
    expect(extractFootnotes(BODY).some(note => note.label === 'fenced')).toBe(false);
  });

  it('ignores an inline reference that is not a definition', () => {
    expect(extractFootnotes('Prose with a reference.[^tokenizer]\n')).toEqual([]);
  });

  it('returns an empty list for a body with no definitions', () => {
    expect(extractFootnotes('')).toEqual([]);
    expect(extractFootnotes('Plain prose.\n')).toEqual([]);
  });

  it('treats the label as opaque, not as a join key', () => {
    const notes = extractFootnotes('[^1]: one\n[^a-b_c]: two\n');
    expect(notes).toEqual([
      { label: '1', text: 'one' },
      { label: 'a-b_c', text: 'two' },
    ]);
  });
});

describe('serializeAtom body opacity', () => {
  it('round-trips footnotes, fences and continuations unmangled', () => {
    const text = serializeAtom(FRONTMATTER, BODY);
    const result = parseAtom(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atom.body).toBe(BODY);
    expect(serializeAtom(result.atom.frontmatter, result.atom.body)).toBe(text);
    expect(extractFootnotes(result.atom.body)).toEqual(extractFootnotes(BODY));
  });
});
