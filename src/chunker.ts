/**
 * Heading-boundary markdown chunker.
 *
 * NO DEPENDENCY, deliberately — do not re-run this search. Verified: the only
 * splitter that carries a heading chain as metadata is LangChain's
 * `MarkdownHeaderTextSplitter`, which is Python-only; the JS package
 * `@langchain/textsplitters` ships a CHARACTER splitter over a fixed separator
 * list and emits no heading metadata at all. Neither can satisfy the
 * `headingChain` contract below, so this module owns the scan.
 */
import { ATOM_CHUNK_TARGET_CHARS, ATOM_MAX_CHARS } from './config.js';

/** One heading-bounded slice of a markdown document. */
export interface MarkdownChunk {
  /** Ancestor headings from H1 down to and including this chunk's own heading. */
  readonly headingChain: readonly string[];
  /** This chunk's own heading text, or `PREAMBLE_TITLE` before the first heading. */
  readonly title: string;
  /** Body text with blank edge lines removed; never longer than `ATOM_MAX_CHARS`. */
  readonly body: string;
  /** 1-based line of the chunk's heading (of its first body line, for sub-chunks). */
  readonly startLine: number;
}

/** Documented fallback title for content preceding the first heading. */
export const PREAMBLE_TITLE = '(preamble)';

const HEADING_RE = /^(#+)[ \t]+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Heading {
  readonly depth: number;
  readonly title: string;
}

interface OpenChunk {
  readonly headingChain: readonly string[];
  readonly title: string;
  readonly startLine: number;
  readonly bodyStart: number;
  readonly lines: readonly string[];
}

interface ScanState {
  readonly fence: string | null;
  readonly stack: readonly string[];
  readonly open: OpenChunk;
  readonly done: readonly OpenChunk[];
}

const isBlank = (line: string): boolean => line.trim() === '';

const parseHeading = (line: string): Heading | undefined => {
  const match = HEADING_RE.exec(line);
  return match === null
    ? undefined
    : { depth: (match[1] ?? '').length, title: (match[2] ?? '').trim() };
};

const fenceMarker = (line: string): string | undefined => FENCE_RE.exec(line)?.[1];

const closesFence = (open: string, marker: string): boolean =>
  marker[0] === open[0] && marker.length >= open.length;

/** Fence state after consuming `line`; `null` means "not inside a fence". */
const nextFence = (current: string | null, line: string): string | null => {
  const marker = fenceMarker(line);
  if (marker === undefined) return current;
  if (current === null) return marker;
  return closesFence(current, marker) ? null : current;
};

const withLine = (state: ScanState, line: string, fence: string | null): ScanState => ({
  ...state,
  fence,
  open: { ...state.open, lines: [...state.open.lines, line] },
});

const withHeading = (state: ScanState, heading: Heading, lineNo: number): ScanState => {
  const chain = [...state.stack.slice(0, heading.depth - 1), heading.title];
  return {
    fence: null,
    stack: chain,
    done: [...state.done, state.open],
    open: {
      headingChain: chain,
      title: heading.title,
      startLine: lineNo,
      bodyStart: lineNo + 1,
      lines: [],
    },
  };
};

/**
 * One step of the scan. The fence check runs FIRST and short-circuits the
 * heading check, which is what keeps a `#` inside a code block from splitting:
 * a line is inert whenever the fence was open before it OR is open after it
 * (so both the opening and the closing fence line stay body text).
 */
const scanLine = (state: ScanState, line: string, lineNo: number): ScanState => {
  const fence = nextFence(state.fence, line);
  if (fence !== null || state.fence !== null) return withLine(state, line, fence);
  const heading = parseHeading(line);
  return heading === undefined ? withLine(state, line, fence) : withHeading(state, heading, lineNo);
};

const firstContentIndex = (lines: readonly string[]): number => {
  const index = lines.findIndex(line => !isBlank(line));
  return index === -1 ? 0 : index;
};

const trimBlankEdges = (lines: readonly string[]): readonly string[] => {
  const start = firstContentIndex(lines);
  const tail = [...lines].reverse().findIndex(line => !isBlank(line));
  return tail === -1 ? [] : lines.slice(start, lines.length - tail);
};

const appendToLastBlock = (
  blocks: readonly (readonly string[])[],
  line: string
): readonly (readonly string[])[] => [
  ...blocks.slice(0, -1),
  [...(blocks.at(-1) ?? []), line],
];

/** `true` for each line that belongs to a fenced block (open, inside, close). */
const fenceFlags = (lines: readonly string[]): readonly boolean[] =>
  lines.reduce<{ readonly fence: string | null; readonly flags: readonly boolean[] }>(
    (state, line) => {
      const fence = nextFence(state.fence, line);
      return { fence, flags: [...state.flags, state.fence !== null || fence !== null] };
    },
    { fence: null, flags: [] }
  ).flags;

/**
 * Paragraph blocks. A blank line at fence depth 0 closes a block and stays
 * attached to it, so re-joining blocks with `\n` reproduces the input exactly;
 * a blank line inside a fence is ordinary content and never closes anything.
 */
const toBlocks = (lines: readonly string[]): readonly string[] => {
  const flags = fenceFlags(lines);
  return lines
    .reduce<readonly (readonly string[])[]>((blocks, line, index) => {
      const grown = appendToLastBlock(blocks, line);
      return flags[index] !== true && isBlank(line) ? [...grown, []] : grown;
    }, [[]])
    .filter(block => block.length > 0)
    .map(block => block.join('\n'));
};

const fitsTarget = (group: string, block: string): boolean =>
  group.length + 1 + block.length <= ATOM_CHUNK_TARGET_CHARS;

const packGroups = (blocks: readonly string[]): readonly string[] =>
  blocks.reduce<readonly string[]>((groups, block) => {
    const last = groups.at(-1);
    return last !== undefined && fitsTarget(last, block)
      ? [...groups.slice(0, -1), `${last}\n${block}`]
      : [...groups, block];
  }, []);

/** Last resort for a single block over the cap: fixed-width character slices. */
const charSplit = (text: string): readonly string[] =>
  text.length <= ATOM_CHUNK_TARGET_CHARS
    ? [text]
    : [
        text.slice(0, ATOM_CHUNK_TARGET_CHARS),
        ...charSplit(text.slice(ATOM_CHUNK_TARGET_CHARS)),
      ];

/**
 * A group still over the cap holds one indivisible block (an oversize fence or
 * a single very long line). The cap is the harder guarantee, so it wins here.
 */
const capGroup = (group: string): readonly string[] =>
  group.length <= ATOM_MAX_CHARS ? [group] : packGroups(group.split('\n').flatMap(charSplit));

const splitBody = (bodyLines: readonly string[]): readonly string[] => {
  const body = bodyLines.join('\n');
  if (body.length <= ATOM_MAX_CHARS) return [body];
  return packGroups(toBlocks(bodyLines)).flatMap(capGroup);
};

/** Line offset of part `index` within the joined body (approximate after a charSplit). */
const lineOffset = (parts: readonly string[], index: number): number =>
  parts.slice(0, index).reduce((total, part) => total + part.split('\n').length, 0);

const emitChunks = (raw: OpenChunk): readonly MarkdownChunk[] => {
  const bodyLines = trimBlankEdges(raw.lines);
  const bodyStart = raw.bodyStart + firstContentIndex(raw.lines);
  const parts = splitBody(bodyLines);
  return parts.map((part, index) => ({
    headingChain: raw.headingChain,
    title: raw.title,
    body: trimBlankEdges(part.split('\n')).join('\n'),
    startLine: index === 0 ? raw.startLine : bodyStart + lineOffset(parts, index),
  }));
};

/** Drops only the synthetic preamble when nothing precedes the first heading. */
const isMeaningful = (raw: OpenChunk): boolean =>
  raw.headingChain.length > 0 || raw.lines.some(line => !isBlank(line));

const initialState: ScanState = {
  fence: null,
  stack: [],
  open: { headingChain: [], title: PREAMBLE_TITLE, startLine: 1, bodyStart: 1, lines: [] },
  done: [],
};

/**
 * Split `text` at heading boundaries, sub-splitting any section whose body
 * exceeds `ATOM_MAX_CHARS`. Pure and deterministic: identical input always
 * yields byte-identical output.
 */
export const chunkMarkdown = (text: string): readonly MarkdownChunk[] => {
  const final = text
    .split('\n')
    .reduce((state, line, index) => scanLine(state, line, index + 1), initialState);
  return [...final.done, final.open].filter(isMeaningful).flatMap(emitChunks);
};
