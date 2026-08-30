/**
 * The wizard's FRAMING — a banner, a numbered section rule, and an indented
 * explanation block. Formatting only: no I/O, no prompt library, no decision.
 *
 * It exists because the interview reads as noise without it. Every explanatory
 * line the wizard printed used to land in the same column as inquirer's `✔
 * answer` log, so an answer already given and a note about the next question
 * were typographically identical, and nothing marked where one step ended and
 * the next began.
 *
 * A section's NUMBER is derived from its position in {@link SECTIONS} rather
 * than written beside its title. A hand-written `3 / 6` drifts the first time a
 * section moves or one is added — and it drifts silently, because the wizard
 * still runs and only the counter lies.
 */

/** The printable width of every rule and box the wizard draws. */
const WIDTH = 72;

/** The indent of an explanation block, and the width its text wraps to. */
const INDENT = '  ';

const TEXT_WIDTH = WIDTH - INDENT.length;

const BANNER_TITLE = 'dp-gnosis · guided setup';

/** The six parts of the interview, in the order it asks them. */
export const SECTIONS: readonly string[] = [
  'Where things go',
  'What to index',
  'How documents are labelled',
  'How text is matched',
  'Reranking',
  'Build',
];

/** The header, printed once, before anything is asked. */
export const banner = (): readonly string[] => {
  const rule = '─'.repeat(WIDTH - 2);
  return ['', `┌${rule}┐`, `│ ${BANNER_TITLE.padEnd(WIDTH - 3)}│`, `└${rule}┘`];
};

/**
 * `n / 6 · <title>` for a declared section, and the bare title for anything
 * else — a title this file does not know is better printed without a counter
 * than with a wrong one.
 */
const label = (title: string): string => {
  const at = SECTIONS.findIndex(known => known === title);
  return at < 0 ? title : `${String(at + 1)} / ${String(SECTIONS.length)} · ${title}`;
};

/** The break between two parts of the interview: a blank line, then the rule. */
export const section = (title: string): readonly string[] => {
  const text = label(title);
  return ['', `── ${text} ${'─'.repeat(Math.max(WIDTH - text.length - 4, 0))}`];
};

/** One more word onto the last line, or onto a new one when it no longer fits. */
const fold = (lines: readonly string[], word: string): readonly string[] => {
  const last = lines[lines.length - 1] ?? '';
  const joined = last.length === 0 ? word : `${last} ${word}`;
  return joined.length <= TEXT_WIDTH ? [...lines.slice(0, -1), joined] : [...lines, word];
};

const paragraph = (text: string): readonly string[] =>
  text
    .split(/\s+/)
    .filter(word => word.length > 0)
    .reduce<readonly string[]>(fold, [''])
    .map(line => `${INDENT}${line}`);

/**
 * An explanation, indented and padded with a blank line either side so it reads
 * as a block rather than as one more answered question. Each entry is a
 * paragraph, wrapped to the terminal width and separated from the next by a
 * blank line.
 */
export const note = (lines: readonly string[]): readonly string[] => [
  '',
  ...lines.flatMap((line, at) => (at === 0 ? paragraph(line) : ['', ...paragraph(line)])),
  '',
];
