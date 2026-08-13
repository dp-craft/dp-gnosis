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
import {
  ATOM_CHUNK_TARGET_CHARS,
  ATOM_FENCE_MAX_CHARS,
  ATOM_MAX_CHARS,
  ATOM_MIN_CHARS
} from './config.js';

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

/** The one separator a heading chain is ever joined with, for a title or for a body line. */
const HEADING_SEPARATOR = ' > ';
const BODY_HEADING_PREFIX = '# ';

const isNamedSegment = (title: string): boolean => title.trim().length > 0;

/**
 * A chunk's heading chain as ONE `a > b` string — the single form every reader
 * joins it in. `ingest` resolves an atom's frontmatter title from it, prefixes
 * the atom body with it, and this module sizes a split part against it; three
 * hand-rolled joins would be three chances for the title and the body line to
 * name the same section differently.
 *
 * A segment with no text contributes nothing, so a document whose `## ` carries
 * no heading never yields a blank separator run.
 */
export const headingPath = (chain: readonly string[]): string =>
  chain.filter(isNamedSegment).join(HEADING_SEPARATOR);

/**
 * The chunk's OWN heading chain restated as one markdown line — and nothing else.
 *
 * Why the body and not only the frontmatter: every index and reranker reads
 * `atom.body` alone, so a body that never names its own section cannot be
 * scored on meaning — measured on the live corpus, 12 254 of 13 858 atoms did
 * not contain their own heading anywhere in the text, and adding the chain
 * measured +0.0876 MRR.
 *
 * Why ONLY the chain: document-level text (the document title, the document
 * summary) is IDENTICAL across every atom of that document, so it adds no
 * discriminative signal within it while lengthening every body — BM25 penalises
 * the length and the reranker loses extraction window. Measured on the best
 * configuration, carrying it in the body cost nDCG@10 −0.0286 and MRR −0.0591,
 * same sign in every cell and both models. It lives in the frontmatter instead.
 *
 * Why ONE line rather than a heading per level: an atom is retrieved
 * standalone, so the chain is its topic sentence, not a document outline. One
 * line reads the same way to a person and to a model, costs the body cap the
 * least, and has exactly one form — no per-depth variation to reproduce.
 *
 * An empty chain (the synthetic preamble, or a heading with no text) yields no
 * line at all: the document is named in the frontmatter, which is where naming
 * it stops costing body length.
 */
export const headingLine = (chain: readonly string[]): string => {
  const path = headingPath(chain);
  return path.length > 0 ? `${BODY_HEADING_PREFIX}${path}` : '';
};

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

/** A repeated frame around the content lines of one oversize block. */
interface SplitFrame {
  /** Lines repeated at the start of every part (table header, fence opener). */
  readonly prefix: readonly string[];
  /** Lines appended to every part (fence closer). */
  readonly suffix: readonly string[];
  /** The content lines distributed across the parts. */
  readonly lines: readonly string[];
}

/**
 * Content floor a framed part must keep. A frame is a REPEATED cost: a header
 * wide enough to crowd the rows out would multiply the corpus instead of
 * making it readable, so such a block is split without one.
 */
const MIN_FRAMED_CONTENT_CHARS = ATOM_CHUNK_TARGET_CHARS / 2;

const TABLE_DELIMITER_RE = /^\s*\|[\s:|-]*-[\s:|-]*$/;

const isTableBlock = (lines: readonly string[]): boolean =>
  (lines[0] ?? '').trimStart().startsWith('|') && TABLE_DELIMITER_RE.test(lines[1] ?? '');

/** Index of the line closing `marker`, or -1 when the block runs to its end unterminated. */
const closingIndex = (lines: readonly string[], marker: string): number =>
  lines.findIndex((line, index) => index > 0 && closesFence(marker, fenceMarker(line) ?? ''));

const fenceFrame = (lines: readonly string[], marker: string): SplitFrame => {
  const close = closingIndex(lines, marker);
  return {
    prefix: [lines[0] ?? ''],
    suffix: [marker],
    lines: close === -1 ? lines.slice(1) : lines.slice(1, close),
  };
};

const plainFrame = (lines: readonly string[]): SplitFrame => ({ prefix: [], suffix: [], lines });

const blockFrame = (lines: readonly string[]): SplitFrame => {
  const marker = fenceMarker(lines[0] ?? '');
  if (marker !== undefined) return fenceFrame(lines, marker);
  return isTableBlock(lines)
    ? { prefix: lines.slice(0, 2), suffix: [], lines: lines.slice(2) }
    : plainFrame(lines);
};

const frameOverhead = (frame: SplitFrame): number =>
  [...frame.prefix, ...frame.suffix].reduce((total, line) => total + line.length + 1, 0);

const affordableFrame = (frame: SplitFrame, lines: readonly string[]): SplitFrame =>
  ATOM_CHUNK_TARGET_CHARS - frameOverhead(frame) >= MIN_FRAMED_CONTENT_CHARS
    ? frame
    : plainFrame(lines);

/** Last resort for a single line over the budget: fixed-width character slices. */
const charSplit = (line: string, budget: number): readonly string[] =>
  line.length <= budget ? [line] : [line.slice(0, budget), ...charSplit(line.slice(budget), budget)];

const packLines = (
  lines: readonly string[],
  budget: number
): readonly (readonly string[])[] =>
  lines.reduce<readonly (readonly string[])[]>((parts, line) => {
    const last = parts.at(-1);
    return last !== undefined && last.join('\n').length + 1 + line.length <= budget
      ? [...parts.slice(0, -1), [...last, line]]
      : [...parts, [line]];
  }, []);

/** `\n\n` under the heading line, plus the trailing `\n` of the composed atom body. */
const BODY_FRAME_CHARS = 3;
const BODY_TRAILING_CHARS = 1;

/**
 * Characters a split part MUST leave for the heading line `ingest` prepends.
 * The reserve is the ACTUAL line (measured p50 57 / p99 222 / max 511 chars),
 * not a worst-case constant, because the cap it is subtracted from is what the
 * part gets to spend: sizing against 511 everywhere would waste 454 characters
 * on the median chunk.
 */
const headingReserve = (chain: readonly string[]): number => {
  const line = headingLine(chain);
  return line.length === 0 ? BODY_TRAILING_CHARS : line.length + BODY_FRAME_CHARS;
};

/**
 * The real ceiling on a part is `ATOM_MAX_CHARS`, not the packing target:
 * measured over the corpus, split atoms landed at p50 2960 / p90 3320 / max
 * 3983, leaving roughly 26% of the cap unspent on every split part and cutting
 * a block into more parts than it needs. Spending the cap less the frame and
 * the heading reserve is what makes each part fit its heading line too, so
 * `ingest` never has to drop that line off a SPLIT atom (measured: 108 atoms
 * over 3000 characters carried none for exactly that reason).
 *
 * A heading long enough to crowd the content out falls back to the old target
 * budget rather than a starved one — such a line is dropped at write time
 * anyway, and a non-positive budget has no split to describe.
 */
const splitBudget = (frame: SplitFrame, reserve: number): number =>
  Math.max(ATOM_MAX_CHARS - reserve, ATOM_CHUNK_TARGET_CHARS) - frameOverhead(frame);

/**
 * Split one oversize block on LINE boundaries, repeating whatever makes a part
 * readable on its own: a table's header and delimiter rows, a fence's opening
 * line plus a closing marker on each part. That repetition is charged against
 * the budget, so a finished part still lands under `ATOM_MAX_CHARS`, and it is
 * why the parts no longer re-join into the exact input.
 */
const structureSplit = (block: string, reserve: number): readonly string[] => {
  const lines = block.split('\n');
  const frame = affordableFrame(blockFrame(lines), lines);
  const budget = splitBudget(frame, reserve);
  const content = frame.lines.flatMap(line => charSplit(line, budget));
  return packLines(content, budget).map(part =>
    [...frame.prefix, ...part, ...frame.suffix].join('\n')
  );
};

/** `true` when the block's FIRST line opens a fence, so the whole block is one figure. */
const opensWithFence = (block: string): boolean =>
  fenceMarker(block.split('\n')[0] ?? '') !== undefined;

/**
 * A fenced block has no readable interior boundary, so `structureSplit` cuts it
 * mid-figure: measured on the benchmark corpus, one ASCII box diagram became 16
 * parts that each began and ended mid-drawing, and 9 such cut sites produced 61
 * unreadable atoms. Below `ATOM_FENCE_MAX_CHARS` such a block is emitted whole;
 * above it, splitting is the last resort left.
 */
const keepsFenceWhole = (group: string): boolean =>
  group.length <= ATOM_FENCE_MAX_CHARS && opensWithFence(group);

/**
 * A group still over the cap holds one indivisible block — packing never joins
 * past the target, so nothing merged can land here. The cap is the harder
 * guarantee, so the block is split structurally rather than left whole — unless
 * it is a fenced block small enough for the escape hatch above.
 */
const capGroup = (group: string, reserve: number): readonly string[] =>
  group.length <= ATOM_MAX_CHARS || keepsFenceWhole(group)
    ? [group]
    : structureSplit(group, reserve);

const splitBody = (
  bodyLines: readonly string[],
  chain: readonly string[]
): readonly string[] => {
  const body = bodyLines.join('\n');
  if (body.length <= ATOM_MAX_CHARS) return [body];
  const reserve = headingReserve(chain);
  return packGroups(toBlocks(bodyLines)).flatMap(group => capGroup(group, reserve));
};

/** Line offset of part `index` within the joined body (approximate after a structureSplit). */
const lineOffset = (parts: readonly string[], index: number): number =>
  parts.slice(0, index).reduce((total, part) => total + part.split('\n').length, 0);

const emitChunks = (raw: OpenChunk): readonly MarkdownChunk[] => {
  const bodyLines = trimBlankEdges(raw.lines);
  const bodyStart = raw.bodyStart + firstContentIndex(raw.lines);
  const parts = splitBody(bodyLines, raw.headingChain);
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

/** Bodies rejoined with a blank line; an empty side contributes nothing. */
const joinBodies = (first: string, second: string): string =>
  [first, second].filter(body => body.length > 0).join('\n\n');

/**
 * `true` when one heading chain is a prefix of the other (equal chains
 * included) — a real ancestor/descendant pair, or two sub-chunks of one
 * section. `absorbBefore` hands the result the TARGET's title and heading
 * chain, so absorbing across branches files text under a heading that is not
 * its own. Measured on this corpus: of 325 under-floor sections only 37
 * (11.4%) were followed by a descendant; the other 288 were siblings, uncles,
 * or a document's last section.
 */
const sameBranch = (left: readonly string[], right: readonly string[]): boolean =>
  left.every((title, index) => title === right[index]) ||
  right.every((title, index) => title === left[index]);

/** `ATOM_MAX_CHARS` outranks the floor, so an over-cap join is left unmerged. */
const canAbsorb = (source: MarkdownChunk, target: MarkdownChunk): boolean =>
  source.body.length < ATOM_MIN_CHARS &&
  sameBranch(source.headingChain, target.headingChain) &&
  joinBodies(source.body, target.body).length <= ATOM_MAX_CHARS;

/** `source` lands ahead of `target`, whose heading and title own the result. */
const absorbBefore = (source: MarkdownChunk, target: MarkdownChunk): MarkdownChunk => ({
  ...target,
  body: joinBodies(source.body, target.body),
  startLine: Math.min(source.startLine, target.startLine),
});

/**
 * Right-to-left fold: an under-floor body is the lead-in to the subsections
 * that follow it, so it merges FORWARD, and a merge that leaves the target
 * still under the floor is itself absorbed by the next step.
 */
const mergeForward = (chunks: readonly MarkdownChunk[]): readonly MarkdownChunk[] =>
  chunks.reduceRight<readonly MarkdownChunk[]>((rest, chunk) => {
    const next = rest[0];
    return next !== undefined && canAbsorb(chunk, next)
      ? [absorbBefore(chunk, next), ...rest.slice(1)]
      : [chunk, ...rest];
  }, []);

/**
 * The absorbed tail's own heading, restated as a markdown line ahead of its
 * body. A backward merge hands the result the TARGET's title and chain, so
 * without this the tail's heading text survives nowhere — and every index
 * except the linear scan reads `atom.body` alone, which makes it unfindable.
 * Measured over 3 995 corpus documents and 40 743 distinct headings, 428
 * headings (1.05%) across 90 documents (2.3%) reached no chunk's chain this
 * way, disproportionately the short API-name headings (`getDefaultStore`,
 * `npm`, `pnpm`) that carry the highest IDF.
 *
 * A heading the target's chain already ends with is its own heading restated,
 * so it is left off: `absorbBefore`, the forward merge, is lossless for the
 * same reason.
 */
const tailBody = (last: MarkdownChunk, prev: MarkdownChunk): string => {
  const restate =
    isNamedSegment(last.title) && prev.headingChain.at(-1) !== last.title;
  const marker = '#'.repeat(Math.max(last.headingChain.length, 1));
  return restate ? `${marker} ${last.title}\n\n${last.body}` : last.body;
};

/** The merged chunk, or `undefined` when the restated heading pushes it over the cap. */
const tailMerged = (prev: MarkdownChunk, last: MarkdownChunk): MarkdownChunk | undefined => {
  const body = joinBodies(prev.body, tailBody(last, prev));
  return canAbsorb(last, prev) && body.length <= ATOM_MAX_CHARS ? { ...prev, body } : undefined;
};

/** The last chunk has nothing ahead of it, so an under-floor tail merges back. */
const mergeTail = (chunks: readonly MarkdownChunk[]): readonly MarkdownChunk[] => {
  const last = chunks.at(-1);
  const head = chunks.slice(0, -1);
  const prev = head.at(-1);
  const merged = prev === undefined || last === undefined ? undefined : tailMerged(prev, last);
  return merged === undefined ? chunks : [...head.slice(0, -1), merged];
};

const FRONT_MATTER_DELIMITER = '---';

const HTML_COMMENT_OPEN_RE = /^\s*<!--/;
const HTML_COMMENT_CLOSE = '-->';

/** Index of the line closing a comment opened at `start`, or the last line when it never closes. */
const commentEnd = (lines: readonly string[], start: number): number => {
  const close = lines.findIndex(
    (line, index) => index >= start && line.includes(HTML_COMMENT_CLOSE)
  );
  return close === -1 ? lines.length : close;
};

/**
 * First line index that is neither blank nor part of a leading HTML comment.
 *
 * Measured: 278 atoms (0.64%) of the benchmark corpus carried a leaked YAML
 * header, every one of them from a downloaded doc whose first line is a
 * `<!-- source: https://... -->` provenance comment. Line 1 is therefore the
 * wrong anchor — the front matter still opens the document, just not its first
 * line. A comment that never closes consumes the rest of the file, which leaves
 * nothing to strip.
 */
const afterLeadingNoise = (lines: readonly string[], index: number): number => {
  const line = lines[index];
  if (line === undefined) return index;
  if (isBlank(line)) return afterLeadingNoise(lines, index + 1);
  return HTML_COMMENT_OPEN_RE.test(line)
    ? afterLeadingNoise(lines, commentEnd(lines, index) + 1)
    : index;
};

const FRONT_MATTER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*:/;

/**
 * The GUARD that keeps a horizontal rule from being eaten. Skipping ahead to
 * find the opener means a document reading `<!-- ... -->` then `---` then prose
 * then `---` now presents a delimited block that is not front matter at all;
 * 35 such rules exist in the corpus. A real block always declares at least one
 * `key:` field, so that is what qualifies it.
 */
const hasKeyLine = (block: readonly string[]): boolean =>
  block.some(line => FRONT_MATTER_KEY_RE.test(line));

/** The delimiter lines of a document's own front matter, or `undefined` when it has none. */
interface FrontMatterSpan {
  readonly open: number;
  readonly close: number;
}

/**
 * Locate a source document's own YAML front-matter before any scanning.
 *
 * Measured on the live corpus: 838 of 1 037 source docs open with a
 * front-matter block, and 745 of 12 621 atoms carried that raw
 * `---\ntitle: ...\n---` header as body text. The block qualifies only when the
 * first non-noise line is exactly `---`, a later line closes it, AND the
 * delimited lines carry a `key:` field — an unterminated opener is a horizontal
 * rule, and so is a closed one holding no fields.
 */
const frontMatterSpan = (lines: readonly string[]): FrontMatterSpan | undefined => {
  const open = afterLeadingNoise(lines, 0);
  const close = lines.indexOf(FRONT_MATTER_DELIMITER, open + 1);
  return lines[open] === FRONT_MATTER_DELIMITER &&
    close !== -1 &&
    hasKeyLine(lines.slice(open + 1, close))
    ? { open, close }
    : undefined;
};

const stripFrontMatter = (lines: readonly string[]): readonly string[] => {
  const span = frontMatterSpan(lines);
  return span === undefined ? lines : lines.slice(span.close + 1);
};

const TITLE_FIELD_RE = /^title:(.*)$/;
const SURROUNDING_QUOTES_RE = /^(["'])(.*)\1$/;

/**
 * The `title:` field of a document's OWN front-matter, or `undefined` when the
 * block carries none. Read from the same leading block `stripFrontMatter`
 * removes, so a `title:` line in the prose can never be mistaken for it.
 */
export const frontMatterTitle = (text: string): string | undefined => {
  const lines = text.split('\n');
  const span = frontMatterSpan(lines);
  const field = lines
    .slice((span?.open ?? 0) + 1, span?.close ?? 0)
    .map(line => TITLE_FIELD_RE.exec(line)?.[1])
    .find(value => value !== undefined);
  const title = (field ?? '').trim().replace(SURROUNDING_QUOTES_RE, '$2').trim();
  return title.length > 0 ? title : undefined;
};

/**
 * Split `text` at heading boundaries, sub-splitting any section whose body
 * exceeds `ATOM_MAX_CHARS` and folding away any body under `ATOM_MIN_CHARS`.
 * Pure and deterministic: identical input always yields byte-identical output.
 */
export const chunkMarkdown = (text: string): readonly MarkdownChunk[] => {
  const final = stripFrontMatter(text.split('\n'))
    .reduce((state, line, index) => scanLine(state, line, index + 1), initialState);
  const chunks = [...final.done, final.open].filter(isMeaningful).flatMap(emitChunks);
  return mergeTail(mergeForward(chunks));
};
