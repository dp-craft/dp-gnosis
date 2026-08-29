/**
 * Locks `packages/gnosis/INTEGRATION.md`'s stated MCP argv against the argv the
 * MCP server really builds. Measured 2026-08-29 the doc carried one defect of
 * this repository's own failure class — a claim about the code the code
 * contradicts: the stated argv omitted `--rerank`, and a neighbouring sentence
 * asserted the tool "does not enable it", while `answerArgv` has passed
 * `--rerank` unconditionally. `tests/mcpProtocol.test.ts` pins the argv; nothing
 * pinned the SENTENCE, so the prose rotted alone.
 *
 * The comparison runs in BOTH directions because the fixes differ: "the doc
 * under-states what the tool runs" and "the doc advertises a flag the tool never
 * passes" are not the same edit. Extraction is a pure function over text, so
 * each failing direction is demonstrated against a deliberately broken input
 * rather than merely hoped for — an extractor that silently matched nothing
 * would otherwise pass both directions vacuously.
 *
 * Only the argv span is locked. The surrounding paragraphs are free prose.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { answerArgv } from '../src/mcp/protocol.js';

const INTEGRATION_DOC = fileURLToPath(new URL('../INTEGRATION.md', import.meta.url));

/** The one line that states what the tool runs. */
const CLAIM = 'through `runCli`';

/**
 * The claim's FIRST backticked span is the stated argv; later spans on the same
 * line name files and JSON fields, which are not part of the contract.
 */
const statedArgvSpan = (text: string): string => {
  const line = text.split('\n').find(candidate => candidate.includes(CLAIM)) ?? '';
  return /`([^`]+)`/.exec(line)?.[1] ?? '';
};

/**
 * Optional arguments are written `[-k <k>]`, so the brackets are stripped before
 * a token is judged — `[-k` is the same flag as `-k`. A placeholder like `<d>]`
 * survives stripping but does not start with `-`, so it is dropped.
 */
const flagsIn = (tokens: readonly string[]): readonly string[] =>
  [...new Set(tokens.map(token => token.replace(/[[\]]/g, '')).filter(token => token.startsWith('-')))].sort();

const docFlags = (text: string): readonly string[] => flagsIn(statedArgvSpan(text).split(/\s+/));

/** Every optional argument supplied, so the code emits its whole flag vocabulary. */
const codeFlags = (): readonly string[] => flagsIn(answerArgv({ question: 'q', k: 1, domain: 'd' }));

const missingFrom = (
  expected: readonly string[],
  actual: readonly string[]
): readonly string[] => expected.filter(flag => !actual.includes(flag));

const doc = readFileSync(INTEGRATION_DOC, 'utf8');

describe('INTEGRATION.md states exactly the argv the MCP tool runs', () => {
  const stated = docFlags(doc);
  const emitted = codeFlags();

  it('states every flag the code emits', () => {
    expect(
      missingFrom(emitted, stated),
      'INTEGRATION.md under-states what the MCP tool runs — `answerArgv` passes a flag ' +
        'the doc does not show (the `--rerank` defect). Fix the DOC, not the code'
    ).toEqual([]);
  });

  it('states no flag the code does not emit', () => {
    expect(
      missingFrom(stated, emitted),
      'INTEGRATION.md advertises a flag `answerArgv` never passes — either the doc is ' +
        'stale or the flag was dropped from `src/mcp/protocol.ts`'
    ).toEqual([]);
  });

  it('extracts a non-empty flag set including `--rerank`, so an empty match cannot pass vacuously', () => {
    expect(stated).toContain('--rerank');
    expect(stated.length).toBeGreaterThan(1);
  });

  it('reads the flags out of a bracketed argv span', () => {
    expect(docFlags('The tool runs `ask <question> [-k <k>] --json --rerank [--domain <d>]` through `runCli` and reads it.')).toEqual(
      ['--domain', '--json', '--rerank', '-k']
    );
  });

  it('names the flag a doc omits', () => {
    const omitted = 'runs `ask <question> [-k <k>] --json [--domain <d>]` through `runCli`.';
    expect(missingFrom(codeFlags(), docFlags(omitted))).toEqual(['--rerank']);
  });

  it('names the flag a doc invents', () => {
    const invented = 'runs `ask <question> [-k <k>] --json --rerank --explain [--domain <d>]` through `runCli`.';
    expect(missingFrom(docFlags(invented), codeFlags())).toEqual(['--explain']);
  });
});
