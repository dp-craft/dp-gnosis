import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type FlagSpec, GATE_VALUE_FLAGS, unknownFlags } from './flags.js';
import { PAIR_FLAGS, parsePairArgs } from './pair.js';
import { parseArgs, RUN_FLAGS } from './run.js';
import { parseSweepArgs, SWEEP_FLAGS } from './sweep.js';

const SRC = dirname(fileURLToPath(import.meta.url));

const readSource = (file: string): string => readFileSync(resolve(SRC, file), 'utf8');

/** Every argument a parser hands to `flagValue` / `required` / `argv.includes`. */
const CALL_SITE = /(?:flagValue|required)\(\s*argv\s*,\s*([^),]+?)\s*\)|argv\.includes\(\s*([^)]+?)\s*\)/g;

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
  ])('%s', (file, spec) => {
    const missing = parsedFlags(file).filter(flag => !declared(spec).includes(flag));
    expect(missing).toEqual([]);
  });

  it('found the call sites at all, so an empty scan cannot pass vacuously', () => {
    expect(parsedFlags('run.ts').length).toBeGreaterThan(10);
    expect(parsedFlags('gate.ts')).toEqual(['--baseline', '--fail-under']);
    expect(parsedFlags('sweep.ts').length).toBe(4);
    expect(parsedFlags('pair.ts').length).toBe(6);
  });
});
