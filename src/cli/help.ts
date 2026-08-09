/**
 * The `--help` text. It documents the exit codes because the CLI is driven by
 * an agent through a bash tool, and the exit code is the only signal that
 * survives without parsing output.
 */
import { ADAPTER_NAMES, DEFAULT_ADAPTER } from './adapter.js';
import { flagList } from './args.js';

export const HELP_TEXT: string = [
  'dp-gnosis — retrieval over a curated markdown atom vault',
  '',
  'Usage: dp-gnosis <command> [args] [flags]',
  '',
  'Commands:',
  '  ingest             chunk the configured corpus roots into atom files',
  '  index              build the selected adapter index (no-op where none exists)',
  '  retrieve <query>   rank atoms for a query',
  '  bench              measure every adapter over the golden set; writes a report to docs/test/',
  '',
  `Flags: ${flagList()}`,
  `Adapters: ${ADAPTER_NAMES.join(' | ')} (default ${DEFAULT_ADAPTER}); the adapter changes ranking and speed only`,
  '  minisearch and lancedb are optional dependencies — an absent one is reported, never hidden',
  '',
  'Exit codes:',
  '  exit 0  success',
  '  exit 2  bad input or usage; the message names the correction',
  '  exit 3  partial result — some work succeeded and some was refused (e.g. ingest skips,',
  '          bench ran with an adapter skipped, or index found the adapter\'s optional',
  '          dependency absent so nothing was built)',
  '',
  'JSON keys with --json (plus exitCode on every object):',
  '  ingest    command, written, skipped[{source,title,reasons}]',
  '  index     command, adapter, built, indexPath, note',
  '  retrieve  command, adapter, query, k, mode, indexState, count, atoms[{id,title,domain,body,score,sourcePath}]',
  '  bench     command, markdownPath, jsonPath, adapters[], skippedAdapters[{name,reason}], corpora[], goldenSet',
  '  failure   error',
].join('\n');
