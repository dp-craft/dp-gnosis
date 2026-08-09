/**
 * Output format selection: `--format <text|json|xml>`, with `--json` kept as the
 * pre-existing alias for `--format json`.
 *
 * `--json` MUST keep working byte-for-byte: it is what `bench`, the tests and
 * the documented agent prompt call. So it is an ALIAS, not a legacy branch —
 * and a CONTRADICTION between the two (`--json --format xml`) is refused rather
 * than silently resolved, because either resolution hands a caller output it did
 * not ask for under a success code.
 */
import type { FlagValues } from './args.js';
import { stringFlag } from './args.js';

export type OutputFormat = 'text' | 'json' | 'xml';

export const FORMAT_FLAG = '--format';
export const JSON_FLAG = '--json';

/** The closed value vocabulary; named in every rejection message. */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'xml'];

export type FormatResult =
  | { readonly ok: true; readonly format: OutputFormat }
  | { readonly ok: false; readonly error: string };

const formatList = (): string => OUTPUT_FORMATS.join(', ');

const valueError = (raw: string): string =>
  `unknown ${FORMAT_FLAG} value "${raw}" — use one of: ${formatList()}`;

const conflictError = (raw: string): string =>
  `${JSON_FLAG} and ${FORMAT_FLAG} ${raw} contradict each other — ${JSON_FLAG} means \`${FORMAT_FLAG} json\`; pass only one`;

const isFormat = (raw: string): raw is OutputFormat =>
  OUTPUT_FORMATS.includes(raw as OutputFormat);

const defaultFormat = (json: boolean): OutputFormat => (json ? 'json' : 'text');

const withJson = (raw: OutputFormat | undefined, json: boolean): FormatResult => {
  if (raw === undefined) return { ok: true, format: defaultFormat(json) };
  return json && raw !== 'json'
    ? { ok: false, error: conflictError(raw) }
    : { ok: true, format: raw };
};

/** Resolve the format from the flags, or name the correction. */
export const resolveFormat = (flags: FlagValues): FormatResult => {
  const raw = stringFlag(flags, FORMAT_FLAG);
  if (raw !== undefined && !isFormat(raw)) return { ok: false, error: valueError(raw) };
  return withJson(raw, flags[JSON_FLAG] === true);
};
