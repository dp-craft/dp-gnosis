/**
 * The resolved invocation a subcommand runs against. Every path is resolved
 * ONCE here — a subcommand never falls back to a default itself, so the vault
 * and index locations cannot drift between commands.
 */
import type { IngestProfile } from '../ingestProfile.js';
import type { AdapterName } from './adapter.js';
import type { FlagValues } from './args.js';
import type { CommandOutcome } from './outcome.js';

export interface CommandContext {
  /** Positional arguments AFTER the subcommand name. */
  readonly positionals: readonly string[];
  readonly flags: FlagValues;
  readonly adapter: AdapterName;
  readonly atomsDir: string;
  readonly indexPath: string;
  readonly repoRoot: string;
  /** The corpus scope this invocation walks — env override, else the profile's. */
  readonly corpusRoots: readonly string[];
  /** The named instance this invocation runs as; the shipped one unless `--profile`. */
  readonly profile: IngestProfile;
}

/** Every subcommand has this signature, so adding one is a single dispatch entry. */
export type CommandHandler = (context: CommandContext) => Promise<CommandOutcome>;
