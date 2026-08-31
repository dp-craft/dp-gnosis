import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  cell,
  exitCodeOf,
  flagValue,
  invokedDirectly,
  messageOf,
  TOOL_EXIT_GATE_FAILED,
  TOOL_EXIT_OK,
  TOOL_EXIT_REFUSED,
  TOOL_EXIT_USAGE
} from '../src/cli/shared.js';
import type { BeirDataset, BrightDataset, MilqaDataset } from '../src/manifest.js';
import { qrelsSplitOf } from '../src/manifest.js';

const beir: BeirDataset = {
  id: 'scifact',
  format: 'beir-local',
  source: '/tmp/scifact',
  qrels: 'train',
  domain: 'demo',
  docShape: 'abstract',
  enabled: true,
  layers: [],
};

const bright: BrightDataset = {
  id: 'bright-biology',
  format: 'bright',
  split: 'biology',
  granularity: 'long',
  domain: 'demo',
  docShape: 'page',
  enabled: true,
  layers: [],
};

const milqa: MilqaDataset = {
  id: 'milqa',
  format: 'milqa',
  source: '/tmp/milqa',
  qrels: 'dev',
  domain: 'demo',
  docShape: 'paragraph',
  enabled: true,
  layers: [],
};

describe('flagValue', () => {
  it('takes the FIRST occurrence, not the last', () => {
    expect(flagValue(['--k', '10', '--k', '20'], '--k')).toBe('10');
  });

  it('is undefined for an absent flag', () => {
    expect(flagValue(['--k', '10'], '--adapter')).toBeUndefined();
  });

  it('is undefined when the flag is the final token', () => {
    expect(flagValue(['--k'], '--k')).toBeUndefined();
  });

  it('returns the next token even when it looks like a flag', () => {
    expect(flagValue(['--k', '--adapter'], '--k')).toBe('--adapter');
  });
});

describe('messageOf', () => {
  it('unwraps an Error to its message', () => {
    expect(messageOf(new Error('refused'))).toBe('refused');
  });

  it('stringifies a non-Error throw', () => {
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(undefined)).toBe('undefined');
    expect(messageOf(7)).toBe('7');
  });
});

describe('cell', () => {
  it('renders an absent measure as EMPTY, never n/a or 0', () => {
    expect(cell(undefined)).toBe('');
  });

  it('renders zero as a measured zero at four decimals', () => {
    expect(cell(0)).toBe('0.0000');
  });

  it('rounds to four decimals', () => {
    expect(cell(0.123456)).toBe('0.1235');
  });
});

describe('invokedDirectly', () => {
  it('is true for the URL of the process entry point', () => {
    const entryPoint = process.argv[1];
    expect(entryPoint).toBeDefined();
    expect(invokedDirectly(pathToFileURL(entryPoint ?? '').href)).toBe(true);
  });

  it('is false for any other module URL', () => {
    expect(invokedDirectly(import.meta.url)).toBe(false);
    expect(invokedDirectly('file:///nowhere/other.js')).toBe(false);
  });
});

describe('the shared exit table', () => {
  it('names the four codes the tools document', () => {
    expect([
      TOOL_EXIT_OK,
      TOOL_EXIT_USAGE,
      TOOL_EXIT_REFUSED,
      TOOL_EXIT_GATE_FAILED,
    ]).toEqual([0, 2, 3, 4]);
  });
});

describe('exitCodeOf', () => {
  const CAUSES: readonly string[] = ['dp-gnosis-bench/a', 'dp-gnosis-bench/b'];

  it('is REFUSED for an error naming one of this tool\'s refusal causes', () => {
    expect(exitCodeOf(new Error('x', { cause: 'dp-gnosis-bench/b' }), CAUSES)).toBe(
      TOOL_EXIT_REFUSED
    );
  });

  it('is USAGE for an error whose cause belongs to another tool', () => {
    expect(exitCodeOf(new Error('x', { cause: 'dp-gnosis-bench/elsewhere' }), CAUSES)).toBe(
      TOOL_EXIT_USAGE
    );
  });

  it('is USAGE for an error with no cause, and for a non-Error throw', () => {
    expect(exitCodeOf(new Error('x'), CAUSES)).toBe(TOOL_EXIT_USAGE);
    expect(exitCodeOf('dp-gnosis-bench/a', CAUSES)).toBe(TOOL_EXIT_USAGE);
  });

  it('ignores a non-string cause rather than matching it', () => {
    expect(exitCodeOf(new Error('x', { cause: { name: 'dp-gnosis-bench/a' } }), CAUSES)).toBe(
      TOOL_EXIT_USAGE
    );
  });
});

describe('qrelsSplitOf', () => {
  it('scores a BRIGHT entry under its single materialised test split', () => {
    expect(qrelsSplitOf(bright)).toBe('test');
  });

  it('takes the declared split for a BEIR entry', () => {
    expect(qrelsSplitOf(beir)).toBe('train');
  });

  it('takes the declared split for a MILQA entry', () => {
    expect(qrelsSplitOf(milqa)).toBe('dev');
  });
});
