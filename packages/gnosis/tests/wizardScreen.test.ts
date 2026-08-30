/**
 * `wizard/screen.ts` — the framing, tested as the pure function it is.
 *
 * The one property worth a test rather than an eyeball: a section's NUMBER is
 * derived from its position in `SECTIONS`, never written beside the title. A
 * hand-written `3 / 6` drifts the first time a section moves, and it drifts
 * silently — the wizard still runs, it just lies about where you are.
 */
import { describe, expect, it } from 'vitest';

import { banner, note, section, SECTIONS } from '../src/cli/wizard/screen.js';

describe('banner — the run says it has started', () => {
  it('should name the tool inside a box', () => {
    const lines = banner();

    expect(lines.join('\n')).toContain('dp-gnosis · guided setup');
    expect(lines.some(line => line.startsWith('┌'))).toBe(true);
    expect(lines.some(line => line.startsWith('└'))).toBe(true);
  });

  it('should draw every line of the box to one width', () => {
    const widths = banner()
      .filter(line => line.length > 0)
      .map(line => [...line].length);

    expect(new Set(widths).size).toBe(1);
  });
});

describe('SECTIONS — the interview in the order it is asked', () => {
  it('should hold the six titles in interview order', () => {
    expect(SECTIONS).toEqual([
      'Where things go',
      'What to index',
      'How documents are labelled',
      'How text is matched',
      'Reranking',
      'Build',
    ]);
  });
});

describe('section — the counter is DERIVED, so it cannot drift from the order', () => {
  it('should number a title from its position in SECTIONS', () => {
    expect(section('Where things go').join('\n')).toContain('1 / 6 · Where things go');
    expect(section('How text is matched').join('\n')).toContain('4 / 6 · How text is matched');
    expect(section('Build').join('\n')).toContain('6 / 6 · Build');
  });

  it('should open with a blank line and then a rule', () => {
    const lines = section('Reranking');

    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('─');
  });

  it('should number every declared section without a gap or a repeat', () => {
    const numbers = SECTIONS.map(title => section(title)[1] ?? '').map(line => line.slice(3, 4));

    expect(numbers).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('should print a title it does not know without inventing a number for it', () => {
    const rule = section('Not a section')[1] ?? '';

    expect(rule).toContain('Not a section');
    expect(rule).not.toContain('/ 6');
  });
});

describe('note — explanation above the question, never between the answers', () => {
  it('should indent every line of the block', () => {
    const lines = note(['one', 'two']).filter(line => line.length > 0);

    expect(lines.every(line => line.startsWith('  '))).toBe(true);
  });

  it('should separate paragraphs with a blank line and pad the block with one', () => {
    expect(note(['one', 'two'])).toEqual(['', '  one', '', '  two', '']);
  });

  it('should wrap a paragraph too long for a terminal line', () => {
    const long = 'word '.repeat(40).trim();

    const lines = note([long]).filter(line => line.length > 0);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every(line => line.length <= 80)).toBe(true);
    expect(lines.map(line => line.trim()).join(' ')).toBe(long);
  });
});
