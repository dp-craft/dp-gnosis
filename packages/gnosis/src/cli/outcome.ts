/**
 * The value every subcommand returns, and the exit-code vocabulary it uses.
 *
 * A subcommand produces DATA and TEXT but never touches the process: rendering
 * (`--json` vs human) and the stdout/stderr split live in `cli.ts`, so a command
 * stays a pure function of its context and is testable by direct call.
 *
 * Exit codes are a contract, not a convention — the CLI is driven by an agent
 * through a bash tool, and an agent that cannot distinguish "worked", "you
 * called it wrong" and "some of it worked" will act on a wrong answer.
 */

/** Everything the run asked for happened. */
export const EXIT_OK = 0;
/** Bad input or usage. The message MUST name the correction, not just the fault. */
export const EXIT_USAGE = 2;
/** A PARTIAL result: real output was produced AND something was refused. */
export const EXIT_PARTIAL = 3;

/** What a subcommand hands back to the renderer. */
export interface CommandOutcome {
  readonly exitCode: number;
  /** The `--json` payload. Rendered verbatim plus an `exitCode` field. */
  readonly data: Readonly<Record<string, unknown>>;
  /** The human-readable rendering of the same result. */
  readonly text: string;
  /**
   * The `--format xml` rendering, when the command has one. Absent for every
   * command that does not accept `--format`, and for a usage failure — those
   * render as text, since an argv the CLI refused cannot select a format.
   */
  readonly xml?: string;
}

/**
 * A usage failure. The caller supplies a message that states the CORRECTION;
 * this only fixes the exit code and mirrors the message into both renderings.
 */
export const usageError = (message: string): CommandOutcome => ({
  exitCode: EXIT_USAGE,
  data: { error: message },
  text: message,
});
