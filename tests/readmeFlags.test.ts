/**
 * Locks README § Flags against the CLI's flag vocabulary (`FLAGS`, `src/cli/args.ts`).
 *
 * Measured 2026-08-18, before the fix: the README documented `--hybrid-weight`,
 * which this CLI REFUSES as an unknown flag (it is a bench flag), and omitted
 * `--profile` and `--type`. A one-directional `FLAGS ⊆ README` check would have
 * missed the `--hybrid-weight` half — the more dangerous half, because a caller
 * reads the README and gets exit 2 under a documented flag. So the assertion is
 * SET EQUALITY IN BOTH DIRECTIONS, and a failure names each direction separately
 * because the fix differs: one direction means "document it", the other means
 * "delete it or implement it".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FLAGS } from '../src/cli/args.js';

const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url));

const FLAG_TOKEN = /^--?[a-z0-9-]+$/;

/** Table cells, honouring the `\|` escape used inside README cell prose. */
const cellsOf = (row: string): readonly string[] =>
  row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim());

/** README § Flags: from the `### Flags` heading up to the next `####` heading. */
const flagsSection = (readme: string): readonly string[] => {
  const lines = readme.split('\n');
  const start = lines.findIndex(line => line.trim() === '### Flags');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.startsWith('####'));
  return end === -1 ? rest : rest.slice(0, end);
};

const isTableRow = (line: string): boolean =>
  line.trim().startsWith('|') && !/^\s*\|[\s-]*\|/.test(line);

/** Backticked flag tokens in a row's FIRST cell (one row documents `--help` / `-h`). */
const flagsInRow = (row: string): readonly string[] =>
  [...(cellsOf(row)[0] ?? '').matchAll(/`([^`]+)`/g)]
    .flatMap(match => (match[1] === undefined ? [] : [match[1]]))
    .filter(token => FLAG_TOKEN.test(token));

const documentedRows = (readme: string): readonly (readonly [string, string])[] =>
  flagsSection(readme)
    .filter(isTableRow)
    .flatMap(row => flagsInRow(row).map(flag => [flag, row] as const));

/** Both diff directions, kept separate: each one has a different fix. */
const diffFlags = (
  documented: ReadonlySet<string>,
  implemented: ReadonlySet<string>
): { readonly undocumented: readonly string[]; readonly nonexistent: readonly string[] } => ({
  undocumented: [...implemented].filter(flag => !documented.has(flag)).sort(),
  nonexistent: [...documented].filter(flag => !implemented.has(flag)).sort(),
});

const readme = readFileSync(README_PATH, 'utf8');
const rows = documentedRows(readme);
const documented = new Set(rows.map(([flag]) => flag));
const implemented = new Set(Object.keys(FLAGS));

describe('README § Flags is the whole flag vocabulary, both directions', () => {
  it('documents every flag the CLI accepts, and no flag it refuses', () => {
    const { undocumented, nonexistent } = diffFlags(documented, implemented);
    expect(
      { undocumented, nonexistent },
      `README § Flags drifted from FLAGS (src/cli/args.ts).\n` +
        `  in FLAGS but undocumented (add a README row): ${undocumented.join(', ') || 'none'}\n` +
        `  documented but NOT a real flag (the CLI exits 2 on it — delete the row): ` +
        `${nonexistent.join(', ') || 'none'}`
    ).toEqual({ undocumented: [], nonexistent: [] });
  });

  it('parses a non-empty vocabulary, so an empty-set match cannot pass vacuously', () => {
    expect(documented.size).toBeGreaterThan(10);
  });

  it('names each drift direction separately, because the two fixes differ', () => {
    expect(diffFlags(new Set(['--gone']), new Set(['--fresh']))).toEqual({
      undocumented: ['--fresh'],
      nonexistent: ['--gone'],
    });
  });
});

describe('a value flag is documented with its value and default', () => {
  const valueFlags = Object.entries(FLAGS)
    .filter(([, spec]) => spec.kind === 'value')
    .map(([name]) => name);

  it.each(valueFlags)('%s has no empty cell in its README row', flag => {
    const row = rows.find(([name]) => name === flag)?.[1];
    expect(row, `no README row documents ${flag}`).toBeDefined();
    expect(cellsOf(row ?? '').filter(cell => cell === '')).toEqual([]);
  });
});
