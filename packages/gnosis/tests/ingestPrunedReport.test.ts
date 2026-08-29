import { vi } from 'vitest';

import { DEFAULT_ADAPTER } from '../src/cli/adapter.js';
import type { CommandContext } from '../src/cli/context.js';
import { runIngestCommand } from '../src/cli/ingestCommand.js';
import type { IngestSummary } from '../src/ingest.js';
import { ingestProfilePath } from '../src/paths.js';
import { activeProfile } from '../src/vocabulary.js';

/**
 * `pruned` is the one DESTRUCTIVE number the command produces — atoms deleted
 * because their source is gone. It was computed and dropped on the floor, so a
 * run that destroyed atoms read exactly like one that destroyed none.
 */
const summary: IngestSummary = { written: 1, skipped: [], pruned: 3, duplicates: 0 };

vi.mock('../src/ingest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ingest.js')>();
  return { ...actual, ingest: vi.fn(async () => summary) };
});

const context: CommandContext = {
  positionals: [],
  flags: {},
  adapter: DEFAULT_ADAPTER,
  atomsDir: '/tmp/gnosis-pruned-report/atoms',
  indexPath: '/tmp/gnosis-pruned-report/index',
  repoRoot: '/tmp/gnosis-pruned-report',
  profilePath: ingestProfilePath(),
  corpusRoots: ['docs'],
  profile: activeProfile(),
};

describe('CLI ingest prune reporting', () => {
  it('names the pruned count in the text summary', async () => {
    const outcome = await runIngestCommand(context);

    expect(outcome.text).toContain('pruned 3');
  });

  it('carries pruned in the --json object without moving the exit code', async () => {
    const outcome = await runIngestCommand(context);
    const data = outcome.data as Record<string, unknown>;

    expect(data.pruned).toBe(3);
    expect(outcome.exitCode).toBe(0);
  });
});
