/**
 * The CLI-path type exclusion: `retrieve` hides the shipped
 * `defaultExcludedTypes` unless the caller asks otherwise.
 *
 * The rule under test is that the exclusion lives in the CLI's filter
 * resolution ALONE — it is expressed as `RetrieveOptions.types` and nothing in
 * ingest, the port or an adapter knows about it, so the bench path (which calls
 * the port directly) measures exactly what it measured before.
 */
import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/cli.js';
import { helpText } from '../src/cli/help.js';
import {
  EXCLUDE_TYPE_FLAG,
  INCLUDE_HISTORY_FLAG,
  resolveTypeFilter,
  TYPE_FLAG
} from '../src/cli/retrieveCommand.js';
import { atomTypes, defaultExcludedTypes } from '../src/vocabulary.js';

const filterOf = (flags: Record<string, string | true>): readonly string[] | undefined => {
  const resolved = resolveTypeFilter(flags);
  if (!resolved.ok) throw new Error(`expected a resolved filter, got: ${resolved.error}`);
  return resolved.types;
};

const errorOf = (flags: Record<string, string | true>): string => {
  const resolved = resolveTypeFilter(flags);
  if (resolved.ok) throw new Error('expected a refusal, got a resolved filter');
  return resolved.error;
};

describe('defaultExcludedTypes()', () => {
  it('mirrors the shipped profile as members of the closed type vocabulary', () => {
    expect(defaultExcludedTypes()).toEqual(['feature-log', 'benchmark', 'review', 'brainstorm']);
    expect(defaultExcludedTypes().every(type => atomTypes().includes(type))).toBe(true);
  });
});

describe('resolveTypeFilter', () => {
  it('excludes the profile default when no filter flag is passed', () => {
    const types = filterOf({});

    expect(types).toEqual(atomTypes().filter(type => !defaultExcludedTypes().includes(type)));
    expect(types).not.toContain('feature-log');
    expect(types).toContain('knowledge');
  });

  it('passes no filter at all with --include-history, so the port sees the today-path', () => {
    expect(filterOf({ [INCLUDE_HISTORY_FLAG]: true })).toBeUndefined();
  });

  it('lets --exclude-type REPLACE the default exclusion rather than extend it', () => {
    const types = filterOf({ [EXCLUDE_TYPE_FLAG]: 'adr,plan' });

    expect(types).not.toContain('adr');
    expect(types).not.toContain('plan');
    expect(types).toContain('feature-log');
  });

  it('keeps --type as the whole filter, with nothing subtracted from it', () => {
    expect(filterOf({ [TYPE_FLAG]: 'adr,review' })).toEqual(['adr', 'review']);
  });

  it('refuses --type together with --exclude-type, naming both flags', () => {
    const error = errorOf({ [TYPE_FLAG]: 'adr', [EXCLUDE_TYPE_FLAG]: 'review' });

    expect(error).toContain(TYPE_FLAG);
    expect(error).toContain(EXCLUDE_TYPE_FLAG);
  });

  it('refuses an --exclude-type value outside the closed vocabulary', () => {
    const error = errorOf({ [EXCLUDE_TYPE_FLAG]: 'adr,nonsense' });

    expect(error).toContain('nonsense');
    expect(error).toContain(atomTypes()[0]);
  });

  it('refuses an exclusion that would empty the vocabulary instead of searching nothing', () => {
    const error = errorOf({ [EXCLUDE_TYPE_FLAG]: atomTypes().join(',') });

    expect(error).toContain(EXCLUDE_TYPE_FLAG);
    expect(error).toContain(INCLUDE_HISTORY_FLAG);
  });
});

describe('the two flags outside retrieve', () => {
  it('refuses --exclude-type on another command the way an unknown flag is refused', async () => {
    const result = await runCli(['index', EXCLUDE_TYPE_FLAG, 'adr']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(EXCLUDE_TYPE_FLAG);
  });

  it('refuses --include-history on another command the same way', async () => {
    const result = await runCli(['index', INCLUDE_HISTORY_FLAG]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(INCLUDE_HISTORY_FLAG);
  });
});

describe('--help', () => {
  it('states the two flags, the excluded types and where the exclusion applies', () => {
    expect(helpText()).toContain(EXCLUDE_TYPE_FLAG);
    expect(helpText()).toContain(INCLUDE_HISTORY_FLAG);
    expect(helpText()).toContain('feature-log | benchmark | review | brainstorm');
    expect(helpText()).toContain('a RETRIEVE-TIME default');
    expect(helpText()).toContain('derives the vault datasets');
    expect(helpText()).toContain('never on ingest');
    expect(helpText()).toContain('the types stay ingested and indexed');
  });

  it('does not claim the exclusion never reaches the bench', () => {
    expect(helpText()).not.toContain('never the bench');
    expect(helpText()).not.toContain('CLI path only');
  });
});

/**
 * Flag scope: `RETRIEVAL_FLAGS` in `cli.ts` accepts these six on BOTH retrieval
 * commands, and `ask` honours each of them through `performRetrieval` — so
 * help MUST NOT scope any of them to `search` alone. `--synthesize` is the
 * only genuinely single-command flag (`ANSWER_ONLY_FLAGS`).
 */
describe('--help flag scoping', () => {
  const RETRIEVAL_SCOPED_FLAGS: readonly string[] = [
    '--format',
    TYPE_FLAG,
    '--max-tokens',
    '--rerank',
    '--rephrase',
    '--max-per-doc',
  ];

  it('scopes no flag to `search` only', () => {
    expect(helpText()).not.toContain('on `search` only');
  });

  it('states both retrieval commands for every flag both accept', () => {
    const lines = helpText().split('\n').filter(entry => !entry.startsWith('Flags:'));
    RETRIEVAL_SCOPED_FLAGS.forEach(flag => {
      const line = lines.find(entry => entry.includes(flag));
      expect(line, `no help line introduces ${flag}`).toBeDefined();
      expect(line).toContain('`search` and `ask`');
    });
  });

  it('keeps --synthesize scoped to ask alone', () => {
    expect(helpText()).toContain('--synthesize on `ask` only');
  });
});
