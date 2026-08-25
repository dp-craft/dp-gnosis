/**
 * Footnote DEFINITIONS in an atom body (`[^label]: prose`).
 *
 * F-1 deliberately dropped the OKF join semantic: the label is a human reading
 * aid, NOT a key that links a body span to a source record. Nothing downstream
 * resolves it, so this module only reports what the prose says.
 *
 * Extraction is read-only. `serializeAtom` treats the body as an opaque
 * verbatim string, which is what guarantees a definition — including a fenced
 * block or a multi-line continuation — survives a round-trip unmangled.
 */

/** One footnote definition found in a body. */
export interface Footnote {
  readonly label: string;
  readonly text: string;
}

/** ``` or ~~~ opening/closing a code fence (up to three leading spaces). */
const FENCE_RE = /^ {0,3}(?:```|~~~)/;
/** `[^label]: text` at the start of a line. */
const DEFINITION_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
/** A four-space or tab indented continuation of the definition above it. */
const CONTINUATION_RE = /^(?: {4}|\t)\s*(\S.*)$/;
const EOL_RE = /\r?\n/;

interface FootnoteState {
  readonly notes: readonly Footnote[];
  readonly inFence: boolean;
  readonly open: boolean;
}

const EMPTY_STATE: FootnoteState = { notes: [], inFence: false, open: false };

const appendLine = (state: FootnoteState, text: string): FootnoteState => {
  const last = state.notes.at(-1);
  return last === undefined
    ? state
    : {
        ...state,
        notes: [...state.notes.slice(0, -1), { label: last.label, text: `${last.text}\n${text}` }],
      };
};

const maybeContinue = (state: FootnoteState, line: string): FootnoteState => {
  const match = CONTINUATION_RE.exec(line);
  const text = match?.[1];
  return state.open && text !== undefined ? appendLine(state, text) : { ...state, open: false };
};

const startNote = (
  state: FootnoteState,
  label: string | undefined,
  text: string | undefined
): FootnoteState =>
  label === undefined || text === undefined
    ? state
    : { ...state, open: true, notes: [...state.notes, { label, text }] };

const classifyLine = (state: FootnoteState, line: string): FootnoteState => {
  const match = DEFINITION_RE.exec(line);
  return match === null ? maybeContinue(state, line) : startNote(state, match[1], match[2]);
};

const outsideFence = (state: FootnoteState, line: string): FootnoteState =>
  state.inFence ? state : classifyLine(state, line);

const stepLine = (state: FootnoteState, line: string): FootnoteState =>
  FENCE_RE.test(line)
    ? { ...state, inFence: !state.inFence, open: false }
    : outsideFence(state, line);

/** Every footnote definition in `body`, in document order. Pure. */
export const extractFootnotes = (body: string): readonly Footnote[] =>
  body.split(EOL_RE).reduce(stepLine, EMPTY_STATE).notes;
