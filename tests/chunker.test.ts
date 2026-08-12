import { chunkMarkdown, PREAMBLE_TITLE } from '../src/chunker.js';
import { ATOM_MAX_CHARS, ATOM_MIN_CHARS } from '../src/config.js';

const FENCE = '```';
const TILDE_FENCE = '~~~';
/** A body exactly at the floor, so a fixture chunk survives the merge pass. */
const PAD = 'p'.repeat(ATOM_MIN_CHARS);

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
    const bodied = ['# A', PAD, '## B', PAD, '### C', PAD].join('\n');
    const chunks = chunkMarkdown(bodied);
    expect(chunks.map(c => c.title)).toEqual(['A', 'B', 'C']);
    expect(chunks.map(c => c.body)).toEqual([PAD, PAD, PAD]);
    expect(chunks.map(c => c.startLine)).toEqual([1, 3, 5]);
  });

  it('collapses a document of bare headings into a single atom', () => {
    const chunks = chunkMarkdown('# A\n## B\n### C\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingChain).toEqual(['A', 'B', 'C']);
    expect(chunks[0]?.body).toBe('');
    expect(chunks[0]?.startLine).toBe(1);
  });

  it('keeps preamble content that precedes the first heading', () => {
    const chunks = chunkMarkdown(`intro ${PAD}\n\n# A\nbody ${PAD}`);
    expect(chunks.map(c => c.title)).toEqual([PREAMBLE_TITLE, 'A']);
    expect(chunks[0]?.body).toBe(`intro ${PAD}`);
    expect(chunks[1]?.body).toBe(`body ${PAD}`);
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
    const text = ['# Real', `${FENCE}bash`, '# comment line', FENCE, PAD, '# Next', PAD].join('\n');
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
    const text = ['# Real', FENCE, TILDE_FENCE, '# inside', FENCE, PAD, '# Next', PAD].join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks.map(c => c.title)).toEqual(['Real', 'Next']);
    expect(chunks[0]?.body).toContain('# inside');
  });
});

describe('chunkMarkdown — heading chain', () => {
  it('carries the full ancestor chain down to the chunk own heading', () => {
    const chunks = chunkMarkdown(`# A\na ${PAD}\n## B\nb ${PAD}\n### C\nc ${PAD}\n`);
    expect(chunks.map(c => c.headingChain)).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C']]);
    expect(chunks.map(c => c.title)).toEqual(['A', 'B', 'C']);
  });

  it('pops the stack when depth jumps back up several levels (H3 to H1)', () => {
    const chunks = chunkMarkdown(`# A\na ${PAD}\n## B\nb ${PAD}\n### C\nc ${PAD}\n# D\nd ${PAD}\n`);
    expect(chunks.map(c => c.headingChain)).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C'], ['D']]);
  });

  it('collapses a skipped level (H1 to H3) without inventing a placeholder', () => {
    const chunks = chunkMarkdown(`# A\na ${PAD}\n### C\nc ${PAD}\n`);
    expect(chunks.map(c => c.headingChain)).toEqual([['A'], ['A', 'C']]);
    expect(chunks[1]?.title).toBe('C');
  });

  it('gives the preamble an empty chain', () => {
    const chunks = chunkMarkdown(`lead ${PAD}\n# A\na ${PAD}\n`);
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

  it('repeats the header and delimiter rows on every part of an oversize table', () => {
    const header = '| name | detail |';
    const delimiter = '|---|---|';
    const rows = Array.from({ length: 60 }, (_, i) => `| r${i} | ${'d'.repeat(100)} |`);
    const chunks = chunkMarkdown(`# A\n${[header, delimiter, ...rows].join('\n')}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.body.length <= ATOM_MAX_CHARS)).toBe(true);
    expect(chunks.every(c => c.body.startsWith(`${header}\n${delimiter}\n`))).toBe(true);
    expect(chunks.every(c => c.body.split('\n').every(l => l.startsWith('|')))).toBe(true);
  });

  it('repeats the opening fence and closes every part of an oversize fenced block', () => {
    const open = `${FENCE}ts`;
    const body = Array.from({ length: 60 }, (_, i) => `const v${i} = '${'x'.repeat(100)}';`);
    const chunks = chunkMarkdown(`# A\n${[open, ...body, FENCE].join('\n')}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.body.length <= ATOM_MAX_CHARS)).toBe(true);
    expect(chunks.every(c => c.body.startsWith(`${open}\n`))).toBe(true);
    expect(chunks.every(c => c.body.endsWith(`\n${FENCE}`))).toBe(true);
    expect(chunks.every(c => c.body.split('\n').filter(l => l.startsWith(FENCE)).length === 2)).toBe(
      true
    );
  });

  it('splits an oversize paragraph block on line boundaries', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'w'.repeat(100)}`);
    const chunks = chunkMarkdown(`# A\n${lines.join('\n')}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.body.length <= ATOM_MAX_CHARS)).toBe(true);
    expect(chunks.flatMap(c => c.body.split('\n')).every(l => lines.includes(l))).toBe(true);
  });

  it('falls back to character slices for a single line longer than the cap', () => {
    const chunks = chunkMarkdown(`# A\n${'q'.repeat(9000)}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.body.length <= ATOM_MAX_CHARS)).toBe(true);
    expect(chunks.map(c => c.body).join('')).toBe('q'.repeat(9000));
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

describe('chunkMarkdown — minimum atom size', () => {
  const long = (label: string): string => `${label} ${'x'.repeat(ATOM_MIN_CHARS)}`;

  it('merges an under-floor body into the FRONT of the next chunk body', () => {
    const chunks = chunkMarkdown(`## Telepítés\nRöviden.\n### Linux\n${long('linux')}\n`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('Linux');
    expect(chunks[0]?.headingChain).toEqual(['Telepítés', 'Linux']);
    expect(chunks[0]?.body).toBe(`Röviden.\n\n${long('linux')}`);
  });

  it('takes the earlier startLine of the absorbed chunk', () => {
    const chunks = chunkMarkdown(`# A\n${long('a')}\n## S\ntiny\n## T\n${long('t')}\n`);
    expect(chunks.map(c => c.title)).toEqual(['A', 'T']);
    expect(chunks[1]?.startLine).toBe(3);
  });

  it('accumulates consecutive under-floor chunks until the floor is cleared', () => {
    const text = `# A\none\n## B\ntwo\n## C\nthree\n## D\n${long('d')}\n`;
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.body).toBe(`one\n\ntwo\n\nthree\n\n${long('d')}`);
  });

  it('merges a trailing under-floor chunk into the END of the preceding chunk', () => {
    const chunks = chunkMarkdown(`# A\n${long('a')}\n## Tail\nbye\n`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('A');
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.body).toBe(`${long('a')}\n\nbye`);
  });

  it('keeps a lone under-floor chunk as the only atom', () => {
    const chunks = chunkMarkdown('# A\ntiny\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('A');
    expect(chunks[0]?.body).toBe('tiny');
  });

  it('does not merge when the joined body would exceed ATOM_MAX_CHARS', () => {
    const chunks = chunkMarkdown(`# A\ntiny\n## B\n${'z'.repeat(ATOM_MAX_CHARS - 5)}\n`);
    expect(chunks.map(c => c.title)).toEqual(['A', 'B']);
    expect(chunks[0]?.body).toBe('tiny');
  });

  it('emits no under-floor atom for a document of many short sections', () => {
    const text = Array.from({ length: 12 }, (_, i) => `## H${i}\nbody ${i}`).join('\n');
    const bodies = chunkMarkdown(text).map(c => c.body);
    expect(bodies.every(b => b.length >= ATOM_MIN_CHARS)).toBe(true);
  });
});
