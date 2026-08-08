/**
 * `index` — build the selected adapter's index.
 *
 * An adapter with no persistent index (linear) SUCCEEDS here as an explicit,
 * stated no-op rather than erroring. A caller scripting `index` then `retrieve`
 * must not have to know which adapters own an index; making the no-op an error
 * would push that knowledge back out to every caller.
 */
import { buildFts5Index } from '../adapters/fts5Adapter.js';
import { hasPersistentIndex } from './adapter.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK } from './outcome.js';

const NO_INDEX_NOTE =
  'adapter has no persistent index — nothing to build (no-op); retrieve scans the vault directly';

const noOp = (context: CommandContext): CommandOutcome => ({
  exitCode: EXIT_OK,
  data: {
    command: 'index',
    adapter: context.adapter,
    built: false,
    indexPath: null,
    note: NO_INDEX_NOTE,
  },
  text: `index: ${context.adapter} — ${NO_INDEX_NOTE}`,
});

const build = (context: CommandContext): CommandOutcome => {
  buildFts5Index({ atomsDir: context.atomsDir, indexPath: context.indexPath });
  return {
    exitCode: EXIT_OK,
    data: {
      command: 'index',
      adapter: context.adapter,
      built: true,
      indexPath: context.indexPath,
      note: `rebuilt wholesale from ${context.atomsDir}`,
    },
    text: `index: ${context.adapter} — built at ${context.indexPath}`,
  };
};

export const runIndexCommand = async (context: CommandContext): Promise<CommandOutcome> =>
  await Promise.resolve(hasPersistentIndex(context.adapter) ? build(context) : noOp(context));
