/**
 * Standing guard: NO test in this suite may ingest into the production vault.
 *
 * Measured 2026-08-22: `cli.test.ts` ran `runCli(['ingest', '--budget-mode',
 * 'tokens'])` with neither `--atoms-dir` nor `--repo-root`. `ingest` resolves
 * `options.outputDir ?? ATOMS_DIR`, so the command's output directory WAS the
 * real vault; it survived only because the flag refusal under test exits 2
 * before ingest runs — the test's safety was contingent on the very defect it
 * asserted. When that ordering did not hold, the vault went 14269 → 10490
 * atoms, the `runner` and `standards` domains vanished, and 122 judged gold ids
 * stopped existing (`goldenSet.test.ts` red).
 *
 * The guard is SOURCE-LEVEL on purpose. A runtime check can only see the calls
 * that ran; reading the test sources catches a NEW test that forgets the flag,
 * including one whose command exits before argument resolution. Same technique
 * as `readmeFlags.test.ts`, which reads `src/cli/args.ts` to keep a doc honest.
 *
 * Pinning tokens accepted, and why each is sufficient:
 *   `--atoms-dir`  — the output directory is stated by the caller.
 *   `--profile`    — every profile written by this suite is generated into a
 *                    `mkdtemp` root and states its own `atomsDir`.
 *   `outputDir`    — the direct `ingest({…})` API's own field.
 * A temp PARENT is what actually matters: `writeManifest` writes
 * `corpus-manifest.json` to `dirname(outputDir)`, so an atoms dir sharing a
 * parent with another corpus clobbers that corpus's manifest.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATOMS_DIR } from '../src/paths.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const SELF = 'ingestBlastRadius.test.ts';

/** An argv array literal (no nested brackets) mentioning the `ingest` command. */
const INGEST_ARGV = /\[[^[\]]*'ingest'[^[\]]*\]/g;
/** A direct `ingest({ … })` options literal (no nested braces in this suite). */
const INGEST_OPTIONS = /\bingest\(\{[^{}]*\}/g;
/** `ingest(someOptions)` — the options object is declared elsewhere in the file. */
const INGEST_IDENT = /\bingest\(([A-Za-z_$][\w$]*)\)/g;
/** `'ingest'` occurrences that are prose, not argv: a suite name or an expectation. */
const NON_ARGV = /(?:describe|it|toContain|toBe|toMatch)\(\s*$/;

const ARGV_PINS = ['--atoms-dir', '--profile'] as const;

interface Span {
  readonly from: number;
  readonly to: number;
}

interface Offence {
  readonly file: string;
  readonly snippet: string;
  readonly why: string;
}

const testSources = (): readonly (readonly [string, string])[] =>
  readdirSync(TESTS_DIR)
    .filter(name => name.endsWith('.test.ts') && name !== SELF)
    .map(name => [name, readFileSync(join(TESTS_DIR, name), 'utf8')] as const);

const matchesOf = (source: string, pattern: RegExp): readonly RegExpMatchArray[] =>
  [...source.matchAll(new RegExp(pattern.source, 'g'))];

const compact = (text: string): string => text.replace(/\s+/g, ' ').slice(0, 120);

const unpinnedArgv = (file: string, source: string): readonly Offence[] =>
  matchesOf(source, INGEST_ARGV)
    .filter(match => !ARGV_PINS.some(pin => match[0].includes(pin)))
    .map(match => ({ file, snippet: compact(match[0]), why: 'ingest argv states no --atoms-dir or --profile' }));

const unpinnedOptions = (file: string, source: string): readonly Offence[] =>
  matchesOf(source, INGEST_OPTIONS)
    .filter(match => !match[0].includes('outputDir'))
    .map(match => ({ file, snippet: compact(match[0]), why: 'ingest({…}) states no outputDir' }));

/** An `ingest(x)` call is safe only when `x` is a pinned literal, or `ingest` is a local wrapper. */
const unresolvedIdent = (file: string, source: string): readonly Offence[] =>
  matchesOf(source, INGEST_IDENT)
    .filter(() => !/const ingest = /.test(source))
    .filter(match => !new RegExp(`const ${match[1]} = \\{[^{}]*outputDir`).test(source))
    .map(match => ({ file, snippet: compact(match[0]), why: `ingest(${match[1]}) resolves to no pinned outputDir` }));

/** Every `'ingest'` literal is either prose or covered by an argv array the scan checked. */
const uncoveredLiteral = (file: string, source: string): readonly Offence[] => {
  const covered: readonly Span[] = matchesOf(source, INGEST_ARGV).map(match => ({
    from: match.index ?? 0,
    to: (match.index ?? 0) + match[0].length,
  }));
  return matchesOf(source, /'ingest'/)
    .filter(match => !NON_ARGV.test(source.slice(0, match.index ?? 0)))
    .filter(match => !covered.some(span => (match.index ?? 0) >= span.from && (match.index ?? 0) < span.to))
    .map(match => ({ file, snippet: compact(source.slice(match.index ?? 0, (match.index ?? 0) + 80)), why: 'ingest command literal outside any scanned argv array' }));
};

/** ATOMS_DIR MUST NOT be handed to an ingest call site, whatever the flags say. */
const productionDirPassed = (file: string, source: string): readonly Offence[] =>
  [...matchesOf(source, INGEST_ARGV), ...matchesOf(source, INGEST_OPTIONS)]
    .filter(match => /\bATOMS_DIR\b/.test(match[0]))
    .map(match => ({ file, snippet: compact(match[0]), why: 'ingest call site names the production ATOMS_DIR' }));

const offencesIn = (file: string, source: string): readonly Offence[] => [
  ...unpinnedArgv(file, source),
  ...unpinnedOptions(file, source),
  ...unresolvedIdent(file, source),
  ...uncoveredLiteral(file, source),
  ...productionDirPassed(file, source),
];

describe('no test may ingest into the production vault', () => {
  it('resolves ATOMS_DIR to the tracked vault, so the guard has a real subject', () => {
    expect(ATOMS_DIR.endsWith(join('dp-gnosis', 'vault', 'atoms'))).toBe(true);
  });

  it('scans a non-empty set of sibling test files', () => {
    expect(testSources().length).toBeGreaterThan(20);
  });

  it('pins every ingest call site in this suite to a caller-stated output directory', () => {
    const offences = testSources().flatMap(([file, source]) => offencesIn(file, source));

    expect(offences).toEqual([]);
  });

  it('reports an unpinned ingest argv when one is introduced', () => {
    const planted = "await runCli(['ingest', '--budget-mode', 'tokens']);";

    expect(offencesIn('planted.test.ts', planted).map(offence => offence.why)).toContain(
      'ingest argv states no --atoms-dir or --profile'
    );
  });

  it('reports a direct ingest call that states no outputDir', () => {
    const planted = 'await ingest({ corpusRoots: [ROOT], repoRoot: root });';

    expect(offencesIn('planted.test.ts', planted).map(offence => offence.why)).toContain(
      'ingest({…}) states no outputDir'
    );
  });

  it('reports an ingest call site that names the production atoms dir', () => {
    const planted = "await runCli(['ingest', '--atoms-dir', ATOMS_DIR]);";

    expect(offencesIn('planted.test.ts', planted).map(offence => offence.why)).toContain(
      'ingest call site names the production ATOMS_DIR'
    );
  });
});
