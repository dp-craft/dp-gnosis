/**
 * The terminal itself — the ONE place a prompt library is imported.
 *
 * Every question the wizard asks goes through {@link Prompter}, an interface,
 * and never through the library directly. Two things fall out of that.
 *
 * The whole flow becomes testable with no terminal: the suite drives it with a
 * scripted implementation that answers from a list, so the wizard's real
 * behaviour — what it writes, what it refuses, what it runs — is under test
 * rather than only its helpers.
 *
 * And the library stays swappable at one import site. A prompt toolkit is a
 * presentation choice; it MUST NOT reach into the wizard's decisions, which
 * live in `plan.ts` and are pure.
 *
 * The library is loaded by DYNAMIC import, and that is not a style choice:
 * `cli.ts` statically imports every command handler, so a static import here
 * would load a terminal-UI toolkit on `search`, on `ask`, on the MCP server —
 * on every invocation that will never ask a question. Only `wizard` pays for
 * it.
 *
 * `Ctrl-C` is handled here rather than left to a stack trace. The library
 * throws its own cancellation error, which is caught at the boundary and turned
 * into {@link CANCELLED} — a value the caller can report as "nothing was
 * written", which is true, because nothing is written before the final
 * confirmation.
 */

/** One selectable option. `description` renders under the highlighted row. */
export interface Option<T> {
  readonly value: T;
  readonly name: string;
  readonly description?: string | undefined;
}

/** Every way the wizard talks to a person. */
export interface Prompter {
  /** Prints explanatory text — never a question. */
  readonly say: (lines: readonly string[]) => void;
  readonly select: <T>(message: string, options: readonly Option<T>[], initial?: T) => Promise<T>;
  readonly multiSelect: <T>(
    message: string,
    options: readonly Option<T>[],
    checked: readonly T[]
  ) => Promise<readonly T[]>;
  readonly confirm: (message: string, initial: boolean) => Promise<boolean>;
  readonly input: (message: string, initial?: string) => Promise<string>;
  /** A single rewriting status line, for work with no questions in it. */
  readonly progress: (line: string) => void;
}

/** Thrown out of the boundary when the user interrupts. Carries no message worth printing. */
export const CANCELLED = Symbol('wizard-cancelled');

/** The error class the prompt library raises on `Ctrl-C`, matched by name so no cast is needed. */
const isCancellation = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ExitPromptError';

const rethrow = (error: unknown): never => {
  if (isCancellation(error)) throw CANCELLED;
  throw error;
};

const guard = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error: unknown) {
    return rethrow(error);
  }
};

const write = (text: string): void => {
  process.stdout.write(text);
};

/** Carriage return plus "erase to end of line" — one status line, rewritten in place. */
const ESC = 27;

const CLEAR_LINE = `\r${String.fromCharCode(ESC)}[2K`;

/**
 * The library types a choice under `exactOptionalPropertyTypes`, so a
 * `description` present-but-undefined is a type error rather than an absent
 * one. The key is therefore OMITTED rather than set to undefined.
 */
const choiceOf = <T>(option: Option<T>): { value: T; name: string; description?: string } =>
  option.description === undefined
    ? { value: option.value, name: option.name }
    : { value: option.value, name: option.name, description: option.description };

/**
 * Same rule as {@link choiceOf}, for the pre-selected value: the key is OMITTED
 * when there is no default, never set to undefined.
 */
const defaulted = <T>(initial: T | undefined): { default?: T } =>
  initial === undefined ? {} : { default: initial };

/** The real terminal, wired to the library — loaded only when a wizard actually runs. */
export const terminalPrompter = async (): Promise<Prompter> => {
  const { checkbox, confirm, input, select } = await import('@inquirer/prompts');
  return {
    say: lines => {
      write(`${lines.join('\n')}\n`);
    },
    select: async (message, options, initial) =>
      await guard(
        async () =>
          await select({ message, choices: options.map(choiceOf), ...defaulted(initial) })
      ),
    multiSelect: async (message, options, checked) =>
      await guard(
        async () =>
          await checkbox({
            message,
            choices: options.map(option => ({ ...choiceOf(option), checked: checked.includes(option.value) })),
          })
      ),
    confirm: async (message, initial) => await guard(async () => await confirm({ message, default: initial })),
    input: async (message, initial) => await guard(async () => await input({ message, ...defaulted(initial) })),
    progress: line => {
      write(`${CLEAR_LINE}${line}`);
    },
  };
};
