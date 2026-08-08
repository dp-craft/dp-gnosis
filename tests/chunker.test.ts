import { chunkMarkdown, PREAMBLE_TITLE } from '../src/chunker.js';
import { ATOM_MAX_CHARS } from '../src/config.js';

const FENCE = '```';
const TILDE_FENCE = '~~~';

describe('chunkMarkdown — degenerate input', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('\n\n   \n')).toEqual([]);
  });

  it('emits one preamble chunk when the document has no headings at all', () => {
    const chunks = chunkMarkdown('just prose\n\nand more prose');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingChain).toEqual([]);
    expect(chunks[0]?.title).toBe(PREAMBLE_TITLE);
    expect(chunks[0]?.body).toBe('just prose\n\nand more prose');
    expect(chunks[0]?.startLine).toBe(1);
  });

  it('emits a chunk per heading when the document is only headings', () => {
    const chunks = chunkMarkdown('# A\n## B\n### C\n');
    expect(chunks.map(c => c.title)).toEqual(['A', 'B', 'C']);
    expect(chunks.map(c => c.body)).toEqual(['', '', '']);
    expect(chunks.map(c => c.startLine)).toEqual([1, 2, 3]);
  });

  it('keeps preamble content that precedes the first heading', () => {
    const chunks = chunkMarkdown('intro line\n\n# A\nbody');
    expect(chunks.map(c => c.title)).toEqual([PREAMBLE_TITLE, 'A']);
    expect(chunks[0]?.body).toBe('intro line');
    expect(chunks[1]?.body).toBe('body');
    expect(chunks[1]?.startLine).toBe(3);
  });
});

describe('chunkMarkdown — fenced code blocks never split', () => {
  it('ignores a heading inside a backtick fence', () => {
    const text = ['# Real', 'before', FENCE, '# not a heading', '## also not', FENCE, 'after'].join(
      '\n'
    );
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('Real');
    expect(chunks[0]?.body).toContain('# not a heading');
    expect(chunks[0]?.body).toContain('## also not');
  });

  it('ignores a heading inside a tilde fence', () => {
    const text = ['# Real', TILDE_FENCE, '# not a heading', TILDE_FENCE, 'tail'].join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.body).toContain('# not a heading');
  });

  it('ignores a heading inside a fence carrying a language tag', () => {
    const text = ['# Real', `${FENCE}bash`, '# comment line', FENCE, '# Next'].join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks.map(c => c.title)).toEqual(['Real', 'Next']);
    expect(chunks[0]?.body).toContain('# comment line');
  });

  it('treats an unterminated fence at EOF as open to the end of the document', () => {
    const text = ['# Real', FENCE, '# still code', '## still code too'].join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('Real');
    expect(chunks[0]?.body).toContain('## still code too');
  });

  it('does not confuse a tilde fence with a backtick fence', () => {
    const text = ['# Real', FENCE, TILDE_FENCE, '# inside', FENCE, '# Next'].join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks.map(c => c.title)).toEqual(['Real', 'Next']);
    expect(chunks[0]?.body).toContain('# inside');
  });
});

describe('chunkMarkdown — heading chain', () => {
  it('carries the full ancestor chain down to the chunk own heading', () => {
    const chunks = chunkMarkdown('# A\na\n## B\nb\n### C\nc\n');
    expect(chunks.map(c => c.headingChain)).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C']]);
    expect(chunks.map(c => c.title)).toEqual(['A', 'B', 'C']);
  });

  it('pops the stack when depth jumps back up several levels (H3 to H1)', () => {
    const chunks = chunkMarkdown('# A\n## B\n### C\n# D\nd\n');
    expect(chunks.map(c => c.headingChain)).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C'], ['D']]);
  });

  it('collapses a skipped level (H1 to H3) without inventing a placeholder', () => {
    const chunks = chunkMarkdown('# A\n### C\nc\n');
    expect(chunks.map(c => c.headingChain)).toEqual([['A'], ['A', 'C']]);
    expect(chunks[1]?.title).toBe('C');
  });

  it('gives the preamble an empty chain', () => {
    const chunks = chunkMarkdown('lead\n# A\n');
    expect(chunks[0]?.headingChain).toEqual([]);
  });
});

describe('chunkMarkdown — determinism', () => {
  it('produces byte-identical output for two independent calls', () => {
    const text = [
      'lead in',
      '# A',
      'alpha',
      FENCE,
      '# fenced',
      FENCE,
      '## B',
      'beta '.repeat(900),
      '# C',
      'gamma',
    ].join('\n');
    expect(JSON.stringify(chunkMarkdown(text))).toBe(JSON.stringify(chunkMarkdown(text)));
  });
});

describe('chunkMarkdown — oversize sub-splitting', () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `p${i} ${'x'.repeat(200)}`).join('\n\n');

  it('sub-splits a section that exceeds the hard cap', () => {
    const chunks = chunkMarkdown(`# A\n## Big\n${paragraphs}\n`);
    const big = chunks.filter(c => c.title === 'Big');
    expect(big.length).toBeGreaterThan(1);
    expect(big.every(c => c.body.length <= ATOM_MAX_CHARS)).toBe(true);
  });

  it('keeps the parent chain and title on every sub-chunk', () => {
    const chunks = chunkMarkdown(`# A\n## Big\n${paragraphs}\n`);
    const big = chunks.filter(c => c.title === 'Big');
    expect(big.every(c => c.title === 'Big')).toBe(true);
    big.forEach(c => expect(c.headingChain).toEqual(['A', 'Big']));
  });

  it('caps every emitted body across the whole document', () => {
    const chunks = chunkMarkdown(`${paragraphs}\n\n# A\n${paragraphs}\n## B\nshort\n`);
    expect(chunks.every(c => c.body.length <= ATOM_MAX_CHARS)).toBe(true);
  });

  it('never splits inside a fenced code block', () => {
    const fenced = [FENCE, 'y'.repeat(3000), FENCE].join('\n');
    const text = `# A\n${'a'.repeat(2000)}\n\n${fenced}\n\n${'b'.repeat(2000)}\n`;
    const chunks = chunkMarkdown(text);
    expect(chunks.every(c => c.body.length <= ATOM_MAX_CHARS)).toBe(true);
    const fenceCounts = chunks.map(c => c.body.split('\n').filter(l => l === FENCE).length);
    expect(fenceCounts.every(n => n % 2 === 0)).toBe(true);
    expect(chunks.some(c => c.body.includes('y'.repeat(3000)))).toBe(true);
  });

  it('does not sub-split a section that fits under the cap', () => {
    const chunks = chunkMarkdown(`# A\n${'z'.repeat(ATOM_MAX_CHARS - 10)}\n`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(1);
  });

  it('advances startLine across sub-chunks', () => {
    const chunks = chunkMarkdown(`# A\n${paragraphs}\n`);
    const lines = chunks.map(c => c.startLine);
    expect(lines[0]).toBe(1);
    expect(lines.every((n, i) => i === 0 || n > (lines[i - 1] ?? 0))).toBe(true);
  });
});
