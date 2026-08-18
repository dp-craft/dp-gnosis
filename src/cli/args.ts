/**
 * Hand-rolled argv parsing. No dependency: `commander` is not a root dependency
 * and adding one needs a COMMON.md §IX round, while the surface here is three
 * subcommands and a closed flag table.
 *
 * The rule that shapes this file: an UNKNOWN flag is a hard error, never an
 * ignored token. A silently dropped `--jsn` gives an agent-driven caller a wrong
 * answer under a success code, which is the single worst failure mode a CLI
 * driven by an LLM can have. Every rejection names the valid alternatives.
 */

import { RERANK_PRESET_NAMES } from '../config.js';
import { ADAPTER_NAMES } from './adapter.js';

type FlagSpec =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'value'; readonly placeholder: string };

/** The closed flag vocabulary. A token outside it is refused, never ignored. */
export const FLAGS: Readonly<Record<string, FlagSpec>> = {
  '--adapter': { kind: 'value', placeholder: `<${ADAPTER_NAMES.join('|')}>` },
  '--atoms-dir': { kind: 'value', placeholder: '<dir>' },
  // A file for fts5/minisearch; a DIRECTORY for lancedb, which persists a tree.
  '--index-path': { kind: 'value', placeholder: '<file|dir>' },
  '--repo-root': { kind: 'value', placeholder: '<dir>' },
  // One named instance: vocabulary, labelling tables AND its own locations. Any
  // location flag above still outranks what the profile states.
  '--profile': { kind: 'value', placeholder: '<file>' },
  '--golden-set': { kind: 'value', placeholder: '<file>' },
  '-k': { kind: 'value', placeholder: '<n>' },
  // `retrieve` only — every other command refuses it through the same
  // unknown-flag path, because a format it cannot honour MUST NOT look accepted.
  '--format': { kind: 'value', placeholder: '<text|json|xml>' },
  // `retrieve` only, refused elsewhere through the same unknown-flag path.
  '--type': { kind: 'value', placeholder: '<type[,type]>' },
  // `retrieve` only: the injection budget in estimated tokens (UTF-8 bytes).
  '--max-tokens': { kind: 'value', placeholder: '<n>' },
  // `retrieve` only, OPT-IN: RRF-fuse a reranker pass over the first pass.
  '--rerank': { kind: 'boolean' },
  // The three below tune that pass and are meaningless without it, so each one
  // REFUSES on its own: a run labelled with a model or a fusion that never ran
  // is the failure naming them exists to prevent.
  '--rerank-model': { kind: 'value', placeholder: '<id>' },
  '--rerank-profile': { kind: 'value', placeholder: `<${RERANK_PRESET_NAMES.join('|')}>` },
  '--rerank-weight': { kind: 'value', placeholder: '<w>' },
  // `retrieve` only, OPT-IN: rewrite the query into keywords before the first pass.
  '--rephrase': { kind: 'boolean' },
  '--json': { kind: 'boolean' },
  '--help': { kind: 'boolean' },
  '-h': { kind: 'boolean' },
};

/** Rendered flag vocabulary, reused by `--help` and by every rejection message. */
export const flagList = (): string =>
  Object.entries(FLAGS)
    .map(([name, spec]) => (spec.kind === 'value' ? `${name} ${spec.placeholder}` : name))
    .join(', ');

/** Flag values as parsed: `true` for a boolean flag, the raw string otherwise. */
export type FlagValues = Readonly<Record<string, string | true>>;

/** One parsed command line: leading subcommand, its positionals, and the flags. */
export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: FlagValues;
}

export type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly error: string };

interface ParseState {
  readonly flags: FlagValues;
  readonly positionals: readonly string[];
  /** Name of a value flag awaiting its value on the next token. */
  readonly pending: string | undefined;
  readonly error: string | undefined;
}

const EMPTY_STATE: ParseState = {
  flags: {},
  positionals: [],
  pending: undefined,
  error: undefined,
};

/** The single wording for "this flag is not accepted here". */
export const unknownFlagMessage = (token: string): string =>
  `unknown flag "${token}" — remove it or replace it with one of: ${flagList()}`;

const placeholderOf = (name: string): string => {
  const spec = FLAGS[name];
  return spec !== undefined && spec.kind === 'value' ? spec.placeholder : '<value>';
};

const missingValueMessage = (name: string): string =>
  `flag "${name}" requires a value — pass it as \`${name} ${placeholderOf(name)}\``;

const withValue = (state: ParseState, name: string, value: string): ParseState => ({
  ...state,
  flags: { ...state.flags, [name]: value },
  pending: undefined,
});

const readFlag = (state: ParseState, token: string): ParseState => {
  const spec = FLAGS[token];
  if (spec === undefined) return { ...state, error: unknownFlagMessage(token) };
  return spec.kind === 'boolean'
    ? { ...state, flags: { ...state.flags, [token]: true } }
    : { ...state, pending: token };
};

const step = (state: ParseState, token: string): ParseState => {
  if (state.error !== undefined) return state;
  if (state.pending !== undefined) return withValue(state, state.pending, token);
  return token.startsWith('-')
    ? readFlag(state, token)
    : { ...state, positionals: [...state.positionals, token] };
};

const toArgs = (state: ParseState): ParsedArgs => ({
  command: state.positionals[0],
  positionals: state.positionals.slice(1),
  flags: state.flags,
});

const finalError = (state: ParseState): string | undefined =>
  state.error ?? (state.pending === undefined ? undefined : missingValueMessage(state.pending));

/** Parse an argv slice (without `node` / script path) into a command + flags. */
export const parseArgs = (argv: readonly string[]): ParseResult => {
  const state = argv.reduce(step, EMPTY_STATE);
  const error = finalError(state);
  return error === undefined ? { ok: true, args: toArgs(state) } : { ok: false, error };
};

/** Read a value flag; a boolean flag or an absent flag both read as `undefined`. */
export const stringFlag = (flags: FlagValues, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
};
