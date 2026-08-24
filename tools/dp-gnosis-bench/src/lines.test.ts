import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { countNonEmptyLines, mapNonEmptyLines } from './lines.js';

const dir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-lines-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The expression this module replaces, kept verbatim as the equivalence oracle. */
const oldLines = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0);

const fixture = (name: string, content: string): string => {
  const path = resolve(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
};

const identity = (line: string): string => line;

const cases: readonly (readonly [string, string])[] = [
  ['blank lines interspersed, trailing newline', 'a\n\nb\n\n\nc\n'],
  ['no trailing newline', 'a\n\nb\nc'],
  ['crlf line endings', 'a\r\n\r\nb\r\nc\r\n'],
  ['whitespace-only lines', 'a\n   \n\t\nb\n'],
  ['single line, no newline at all', 'only'],
  ['empty file', ''],
  ['leading newline', '\n\na\n'],
];

describe('mapNonEmptyLines', () => {
  it.each(cases)('matches the old split/filter expression: %s', (_name, content) => {
    const path = fixture(`case-${_name.replace(/\W+/g, '-')}.txt`, content);
    expect(mapNonEmptyLines(path, identity)).toEqual(oldLines(path));
  });

  it('applies the projection to every kept line, in file order', () => {
    const path = fixture('project.jsonl', '{"n":1}\n\n{"n":2}\n');
    expect(mapNonEmptyLines(path, line => JSON.parse(line) as { n: number })).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  it('keeps the carriage return inside the line, as the old expression did', () => {
    const path = fixture('crlf-body.txt', 'a\r\nb\r\n');
    expect(mapNonEmptyLines(path, identity)).toEqual(['a\r', 'b\r']);
  });
});

describe('countNonEmptyLines', () => {
  it.each(cases)('matches the old .filter(...).length: %s', (_name, content) => {
    const path = fixture(`count-${_name.replace(/\W+/g, '-')}.txt`, content);
    expect(countNonEmptyLines(path)).toBe(oldLines(path).length);
  });
});

/**
 * Larger than one read chunk, with two-byte characters at an offset chosen so a
 * character AND a line both straddle the chunk boundary — the two ways a naive
 * chunked reader corrupts data.
 */
describe('across read-chunk boundaries', () => {
  const body = `x${'á'.repeat(100)}`;
  const path = fixture(
    'multi-chunk.txt',
    Array.from({ length: 6000 }, (_unused, i) => (i % 500 === 0 ? '' : body)).join('\n')
  );

  it('reads more than one chunk', () => {
    expect(readFileSync(path).byteLength).toBeGreaterThan(1024 * 1024);
  });

  it('matches the old expression line for line', () => {
    expect(mapNonEmptyLines(path, identity)).toEqual(oldLines(path));
  });

  it('counts identically to the old expression', () => {
    expect(countNonEmptyLines(path)).toBe(oldLines(path).length);
  });
});
