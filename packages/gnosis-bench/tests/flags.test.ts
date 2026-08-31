import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { CHARTS_FLAGS, main as chartsMain } from '../src/charts.js';
import { DET_ENRICH_FLAGS, parseDetEnrichArgs } from '../src/deterministicEnrichment.js';
import { ENRICHMENT_GATE_FLAGS, main as enrichGateMain } from '../src/enrichmentGate.js';
import { type FlagSpec, GATE_VALUE_FLAGS, unknownFlags } from '../src/flags.js';
import { FORENSICS_FLAGS, parseForensicsArgs } from '../src/forensicsCli.js';
import { FUSE_FORECAST_FLAGS, parseFuseForecastArgs } from '../src/fuseForecastCli.js';
import { GOLD_AUDIT_FLAGS, parseGoldAuditArgs } from '../src/goldAuditCli.js';
import { PAIR_FLAGS, parsePairArgs } from '../src/pair.js';
import { parseArgs, RUN_FLAGS } from '../src/run.js';
import { parseSweepArgs, SWEEP_FLAGS } from '../src/sweep.js';
import { parseVocabGapArgs, VOCAB_GAP_FLAGS } from '../src/vocabGapCli.js';

// The PARSER SOURCES this test reads, not this file's own directory: the suite
// lives in `tests/` while `flags.ts`, `run.ts`, `pair.ts` and `sweep.ts` stay in
// `src/`. Anchored on this file so it is independent of the invoking directory.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

const readSource = (file: string): string => readFileSync(resolve(SRC, file), 'utf8');

/** Every argument a parser hands to `flagValue` / `required` / `argv.includes`. */
const CALL_SITE = /(?:flagValues?|required)\(\s*argv\s*,\s*([^),]+?)\s*\)|argv\.includes\(\s*([^)]+?)\s*\)/g;

/**
 * `const NAME = '--flag';` — how every flag constant is declared, in the parser's
 * own file or in `flags.ts`, which owns the gate's two.
 */
const constantValue = (source: string, name: string): string | undefined => {
  const pattern = new RegExp(`const ${name} = '(--[\\w-]+)'`);
  return pattern.exec(source)?.[1] ?? pattern.exec(readSource('flags.ts'))?.[1];
};

/**
 * The flag a call site names: a literal, or a `*_FLAG` constant resolved in the
 * file that declares it. Anything else (a parameter such as `name`) is not a
 * flag name and is skipped.
 */
const flagOf = (argument: string, source: string): string | undefined => {
  const literal = /^'(--[\w-]+)'$/.exec(argument)?.[1];
  if (literal !== undefined) return literal;
  return argument.endsWith('_FLAG') ? constantValue(source, argument) : undefined;
};

const parsedFlags = (file: string): readonly string[] => {
  const source = readSource(file);
  return [...source.matchAll(CALL_SITE)]
    .map(match => match[1] ?? match[2] ?? '')
    .flatMap(argument => {
      const flag = flagOf(argument, source);
      return flag === undefined ? [] : [flag];
    });
};

const declared = (spec: FlagSpec): readonly string[] => [...spec.value, ...spec.boolean];

describe('unknown-flag refusal', () => {
  it('names the offending flag and lists the valid ones', () => {
    expect(() => parseArgs(['--rerank-modle', 'qwen3-reranker-4b'])).toThrow(
      /unknown flag "--rerank-modle".*--rerank-model/s
    );
    expect(() => parseSweepArgs(['--k'])).toThrow(/unknown flag "--k".*--k1/s);
    expect(() => parsePairArgs(['--a', 'x', '--b', 'y', '--metrics', 'ndcg10'])).toThrow(
      /unknown flag "--metrics".*--metric/s
    );
  });

  it('accepts the gate flags, which share run.ts argv rather than owning a parser', () => {
    expect(() => parseArgs(['--baseline', 'x', '--fail-under', '0.01'])).not.toThrow();
    expect(() => parseArgs(['--fail-undr', '0.01'])).toThrow(/unknown flag "--fail-undr"/);
    expect(GATE_VALUE_FLAGS.every(flag => declared(RUN_FLAGS).includes(flag))).toBe(true);
  });

  it('still parses every known flag', () => {
    expect(parseArgs(['--adapter', 'linear', '--depth', '50', '--compare']).depth).toBe(50);
    expect(parseSweepArgs(['--k1', '1.0', '--b', '0.5']).bs).toEqual([0.5]);
    expect(parsePairArgs(['--a', 'left', '--b', 'right']).a).toBe('left');
  });

  it('does not read a value flag ARGUMENT as a flag', () => {
    expect(() => parseArgs(['--only', '--rerank'])).not.toThrow();
    expect(parseArgs(['--only', '--rerank']).only).toEqual(['--rerank']);
  });

  it('accepts a negative number as a value', () => {
    expect(unknownFlags(['--fail-under', '-0.01'], RUN_FLAGS)).toEqual([]);
    expect(parseSweepArgs(['--depth', '-1']).depth).toBe(-1);
  });

  it('ignores `--` and bare positionals, as it always did', () => {
    expect(unknownFlags(['--', 'scifact', '-k', '5'], RUN_FLAGS)).toEqual([]);
  });
});

/**
 * The seven zero-GPU tools used to DROP an unrecognised token and run at the
 * default the operator's flag was meant to move — `--kk 20` re-scored at cut 10
 * and the TSV recorded it as if measured at 20. Each parser is asserted through
 * its OWN entry point, so a spec that exists but is never called still fails.
 */
describe('the offline tools refuse an unknown flag', () => {
  const UNKNOWN = ['--kk', '20'];

  it.each([
    ['forensicsCli', (): unknown => parseForensicsArgs(['--run', 'x', ...UNKNOWN])],
    ['goldAuditCli', (): unknown => parseGoldAuditArgs(['--dataset', 'vault', ...UNKNOWN])],
    ['vocabGapCli', (): unknown => parseVocabGapArgs(['--index', 'i', '--queries', 'q', ...UNKNOWN])],
    ['fuseForecastCli', (): unknown => parseFuseForecastArgs([...UNKNOWN])],
    ['enrichmentGate', (): unknown => enrichGateMain(['sidecar.jsonl', 'atoms', ...UNKNOWN])],
    [
      'deterministicEnrichment',
      (): unknown =>
        parseDetEnrichArgs(['--index', 'i', '--corpus', 'c', '--sidecar', 's', ...UNKNOWN]),
    ],
  ])('%s', (_name, invoke) => {
    expect(invoke).toThrow(/unknown flag "--kk"/);
  });

  it('charts takes no flags at all, so every one of them is unknown', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exitCode = chartsMain(
      { specPath: 'charts.json', resultsDir: 'results', outDir: 'out' },
      UNKNOWN
    );
    const written = String(stderr.mock.calls[0]?.[0]);
    stderr.mockRestore();
    expect(exitCode).toBe(2);
    expect(written).toMatch(/unknown flag "--kk"/);
  });

  it('still accepts each tool\'s own flags', () => {
    expect(parseForensicsArgs(['--run', 'x', '--k', '20']).k).toBe(20);
    expect(parseGoldAuditArgs(['--dataset', 'vault', '--out', 'm.json']).outPath).toBe('m.json');
    expect(parseVocabGapArgs(['--index', 'i', '--queries', 'q'])?.indexPath).toBe('i');
    expect(parseFuseForecastArgs(['--only', 'vault']).datasets).toEqual(['vault']);
    expect(
      parseDetEnrichArgs(['--index', 'i', '--corpus', 'c', '--sidecar', 's', '--out', 'o'])?.outDir
    ).toBe('o');
  });
});

/**
 * The anti-drift guard: a flag a parser READS but its spec does not DECLARE
 * would be accepted by the parser and refused by the check, so the CLI would
 * reject its own documented flag. Reading the call sites out of the source is
 * what makes the declared list unable to fall behind in silence.
 */
describe('declared flag sets cover every call site', () => {
  it.each([
    ['run.ts', RUN_FLAGS],
    ['gate.ts', RUN_FLAGS],
    ['sweep.ts', SWEEP_FLAGS],
    ['pair.ts', PAIR_FLAGS],
    ['forensicsCli.ts', FORENSICS_FLAGS],
    ['goldAuditCli.ts', GOLD_AUDIT_FLAGS],
    ['vocabGapCli.ts', VOCAB_GAP_FLAGS],
    ['fuseForecastCli.ts', FUSE_FORECAST_FLAGS],
    ['charts.ts', CHARTS_FLAGS],
    ['enrichmentGate.ts', ENRICHMENT_GATE_FLAGS],
    ['deterministicEnrichment.ts', DET_ENRICH_FLAGS],
  ])('%s', (file, spec) => {
    const missing = parsedFlags(file).filter(flag => !declared(spec).includes(flag));
    expect(missing).toEqual([]);
  });

  it('found the call sites at all, so an empty scan cannot pass vacuously', () => {
    expect(parsedFlags('run.ts').length).toBeGreaterThan(10);
    expect(parsedFlags('gate.ts')).toEqual(['--baseline', '--fail-under']);
    expect(parsedFlags('sweep.ts').length).toBe(4);
    expect(parsedFlags('pair.ts').length).toBe(6);
    expect(parsedFlags('forensicsCli.ts').length).toBe(5);
    expect(parsedFlags('goldAuditCli.ts').length).toBe(4);
    expect(parsedFlags('vocabGapCli.ts').length).toBe(4);
    expect(parsedFlags('fuseForecastCli.ts').length).toBe(2);
    expect(parsedFlags('enrichmentGate.ts').length).toBe(1);
    expect(parsedFlags('deterministicEnrichment.ts').length).toBe(5);
  });

  /**
   * `charts.ts` reads NO flag — its only argv contact is the refusal itself, so
   * its scan is empty by construction and the row above is vacuous on purpose.
   * Pinned here so a flag added to it later cannot stay undeclared in silence.
   */
  it('charts.ts parses no flag at all', () => {
    expect(parsedFlags('charts.ts')).toEqual([]);
    expect(declared(CHARTS_FLAGS)).toEqual([]);
  });
});
