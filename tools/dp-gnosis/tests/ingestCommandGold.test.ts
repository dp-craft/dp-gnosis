import { vi } from 'vitest';

import { DEFAULT_ADAPTER } from '../src/cli/adapter.js';
import type { CommandContext } from '../src/cli/context.js';
import { runIngestCommand } from '../src/cli/ingestCommand.js';
import { loadJudgedAtomIds } from '../src/goldenIds.js';
import type { IngestOptions, IngestSummary } from '../src/ingest.js';
import { ingest } from '../src/ingest.js';
import { activeProfile } from '../src/vocabulary.js';

/**
 * The WIRING, asserted where it was missing: `ingest` honoured `goldIds` from
 * the start, but the CLI never passed any, so a production ingest deduped
 * gold-blind. Mocking the pipeline keeps this test about the call, not the run.
 */
vi.mock('../src/ingest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ingest.js')>();
  const summary: IngestSummary = { written: 0, skipped: [], pruned: 0, duplicates: 0 };
  return { ...actual, ingest: vi.fn(async () => summary) };
});

const context: CommandContext = {
  positionals: [],
  flags: {},
  adapter: DEFAULT_ADAPTER,
  atomsDir: '/tmp/gnosis-gold-wiring/atoms',
  indexPath: '/tmp/gnosis-gold-wiring/index',
  repoRoot: '/tmp/gnosis-gold-wiring',
  corpusRoots: ['docs'],
  profile: activeProfile(),
};

const passedOptions = async (): Promise<IngestOptions> => {
  await runIngestCommand(context);
  const call = vi.mocked(ingest).mock.calls[0];
  return call === undefined ? { } : call[0];
};

describe('CLI ingest gold wiring', () => {
  it('passes the golden ids to the ingest pipeline', async () => {
    const goldIds = (await passedOptions()).goldIds ?? [];

    expect(goldIds.length).toBeGreaterThan(0);
    expect([...goldIds]).toEqual([...loadJudgedAtomIds()]);
  });
});
