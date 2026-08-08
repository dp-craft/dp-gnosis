/**
 * The F-1 atom frontmatter: a CLOSED, FLAT subset of YAML, parsed and emitted
 * by hand.
 *
 * Why no YAML dependency:
 * (a) Round-trip fidelity. `parseAtom` → `serializeAtom` MUST be BYTE-IDENTICAL
 *     so an unrelated edit never rewrites a whole atom file. Every general YAML
 *     library normalizes quoting, key order and list style, which silently
 *     changes bytes the author did not touch.
 * (b) Dependency governance. A new runtime dependency needs a COMMON.md §IX
 *     round (research → ADR → approval); this module has no such approval.
 *
 * Consequence: anything outside the closed subset is REFUSED with a message
 * naming the required form — never guessed at, never re-shaped. The subset is:
 * a `---` opening line, `key: value` scalars with exactly one space after the
 * colon and no padding, one `sources:` block whose entries are `  - <string>`,
 * and a `---` closing line terminated by a newline.
 *
 * Not validated here (T-04 owns it): id uniqueness, the body size cap, and the
 * `x_domain` vocabulary.
 */

/** The closed status vocabulary. */
export const ATOM_STATUSES = ['draft', 'stable', 'deprecated'] as const;

/** A member of the closed status vocabulary. */
export type AtomStatus = (typeof ATOM_STATUSES)[number];

/** The F-1 flat frontmatter block of one atom. */
export interface AtomFrontmatter {
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly x_domain: string;
  readonly status: AtomStatus;
  readonly stale_after?: string;
  readonly sources: readonly string[];
  readonly verified_by?: string;
  readonly verified_at?: string;
}

/** One parsed atom: its frontmatter plus its verbatim, opaque body. */
export interface Atom {
  readonly frontmatter: AtomFrontmatter;
  readonly body: string;
}

/**
 * The outcome of a parse. A discriminated result rather than a throw: one
 * corrupt file in the corpus must be SKIPPABLE, not fatal to the whole scan.
 */
export type ParseAtomResult =
  | { readonly ok: true; readonly atom: Atom }
  | { readonly ok: false; readonly error: string };

const DELIMITER = '---';
const SOURCES_KEY = 'sources:';
const SOURCE_ITEM_PREFIX = '  - ';
const REQUIRED_SCALARS = ['type', 'id', 'title', 'x_domain', 'status'] as const;
const OPTIONAL_SCALARS = ['stale_after', 'verified_by', 'verified_at'] as const;
const KNOWN_SCALARS: readonly string[] = [...REQUIRED_SCALARS, ...OPTIONAL_SCALARS];
const DATE_SCALARS = ['stale_after', 'verified_at'] as const;

/** `---\n` … `---\n`; the closing delimiter MUST be newline-terminated. */
const DOCUMENT_RE = /^---\r?\n((?:[^\n]*\n)*?)---\r?\n/;
/** `key: value`, single separating space, no leading or trailing padding. */
const SCALAR_LINE_RE = /^([a-z_][a-z0-9_]*): (\S|\S.*\S)$/;
/** A source entry that is really a mapping (`- url: …`) — the OKF v0.2 shape. */
const MAPPING_ITEM_RE = /^[A-Za-z_][A-Za-z0-9_-]*:(?: |$)/;
const TIDY_SCALAR_RE = /^(\S|\S.*\S)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRAILING_CR_RE = /\r$/;

const NESTED_SOURCES_ERROR =
  'nested "sources" mapping is not supported — F-1 requires a flat list, one plain string per line, e.g. "  - https://example.com/page"';
const DELIMITER_ERROR =
  'atom MUST open with a "---" line and close with a newline-terminated "---" line';

const isStatus = (value: string | undefined): value is AtomStatus =>
  ATOM_STATUSES.some(status => status === value);

interface FrontmatterDocument {
  readonly lines: readonly string[];
  readonly body: string;
}

const stripCr = (line: string): string => line.replace(TRAILING_CR_RE, '');

const splitDocument = (text: string): FrontmatterDocument | undefined => {
  const match = DOCUMENT_RE.exec(text);
  const block = match?.[1];
  return match === null || block === undefined
    ? undefined
    : { lines: block.split('\n').slice(0, -1).map(stripCr), body: text.slice(match[0].length) };
};

type ScalarPair = readonly [string, string];

interface FoldState {
  readonly scalars: readonly ScalarPair[];
  readonly sources: readonly string[];
  readonly inSources: boolean;
  readonly sourcesSeen: boolean;
  readonly error: string | undefined;
}

const EMPTY_STATE: FoldState = {
  scalars: [],
  sources: [],
  inSources: false,
  sourcesSeen: false,
  error: undefined,
};

const failState = (state: FoldState, error: string): FoldState => ({ ...state, error });

const startSources = (state: FoldState): FoldState =>
  state.sourcesSeen
    ? failState(state, 'duplicate field "sources"')
    : { ...state, inSources: true, sourcesSeen: true };

const appendSource = (state: FoldState, item: string): FoldState =>
  TIDY_SCALAR_RE.test(item)
    ? { ...state, sources: [...state.sources, item] }
    : failState(state, `unsupported source entry: "${SOURCE_ITEM_PREFIX}${item}"`);

const addSource = (state: FoldState, line: string): FoldState => {
  const item = line.slice(SOURCE_ITEM_PREFIX.length);
  return MAPPING_ITEM_RE.test(item)
    ? failState(state, NESTED_SOURCES_ERROR)
    : appendSource(state, item);
};

const addScalar = (state: FoldState, pair: ScalarPair): FoldState =>
  state.scalars.some(([key]) => key === pair[0])
    ? failState(state, `duplicate field "${pair[0]}"`)
    : { ...state, inSources: false, scalars: [...state.scalars, pair] };

/** The `key: value` pair of a well-formed scalar line, else `undefined`. */
const scalarPair = (line: string): ScalarPair | undefined => {
  const [, key, value] = SCALAR_LINE_RE.exec(line) ?? [];
  return key === undefined || value === undefined ? undefined : [key, value];
};

/** A pair is usable only when its key belongs to the closed scalar vocabulary. */
const isKnownPair = (pair: ScalarPair | undefined): pair is ScalarPair =>
  pair !== undefined && KNOWN_SCALARS.includes(pair[0]);

const takeScalar = (state: FoldState, line: string): FoldState => {
  const pair = scalarPair(line);
  return isKnownPair(pair)
    ? addScalar(state, pair)
    : failState(state, `unsupported frontmatter line: "${line}"`);
};

const takeIndented = (state: FoldState, line: string): FoldState =>
  state.inSources
    ? failState(state, NESTED_SOURCES_ERROR)
    : failState(state, `unsupported frontmatter line: "${line}"`);

const classifyScalarish = (state: FoldState, line: string): FoldState =>
  line.startsWith(' ') || line.startsWith('\t')
    ? takeIndented(state, line)
    : takeScalar(state, line);

const classifyItem = (state: FoldState, line: string): FoldState =>
  state.inSources && line.startsWith(SOURCE_ITEM_PREFIX)
    ? addSource(state, line)
    : classifyScalarish(state, line);

const takeLine = (state: FoldState, line: string): FoldState =>
  line === SOURCES_KEY ? startSources(state) : classifyItem(state, line);

/** First refusal wins: once a line failed, later lines are not re-interpreted. */
const stepLine = (state: FoldState, line: string): FoldState =>
  state.error === undefined ? takeLine(state, line) : state;

const toMap = (scalars: readonly ScalarPair[]): ReadonlyMap<string, string> =>
  new Map(scalars.map(([key, value]) => [key, value]));

const requiredError = (map: ReadonlyMap<string, string>): string | undefined => {
  const missing = REQUIRED_SCALARS.find(key => !map.has(key));
  return missing === undefined ? undefined : `missing required field "${missing}"`;
};

const isBadDate = (map: ReadonlyMap<string, string>, key: string): boolean => {
  const value = map.get(key);
  return value !== undefined && !DATE_RE.test(value);
};

const dateError = (map: ReadonlyMap<string, string>): string | undefined => {
  const bad = DATE_SCALARS.find(key => isBadDate(map, key));
  return bad === undefined ? undefined : `field "${bad}" MUST be an absolute YYYY-MM-DD date`;
};

const sourcesError = (sources: readonly string[]): string | undefined =>
  sources.length > 0
    ? undefined
    : 'missing required field "sources" — at least one flat source string is required';

const validationError = (
  map: ReadonlyMap<string, string>,
  sources: readonly string[]
): string | undefined => requiredError(map) ?? dateError(map) ?? sourcesError(sources);

const required = (map: ReadonlyMap<string, string>, key: string): string => map.get(key) ?? '';

const composeFrontmatter = (
  map: ReadonlyMap<string, string>,
  status: AtomStatus,
  sources: readonly string[]
): AtomFrontmatter => {
  const staleAfter = map.get('stale_after');
  const verifiedBy = map.get('verified_by');
  const verifiedAt = map.get('verified_at');
  return {
    type: required(map, 'type'),
    id: required(map, 'id'),
    title: required(map, 'title'),
    x_domain: required(map, 'x_domain'),
    status,
    ...(staleAfter === undefined ? {} : { stale_after: staleAfter }),
    sources,
    ...(verifiedBy === undefined ? {} : { verified_by: verifiedBy }),
    ...(verifiedAt === undefined ? {} : { verified_at: verifiedAt }),
  };
};

const withStatus = (
  map: ReadonlyMap<string, string>,
  sources: readonly string[],
  body: string
): ParseAtomResult => {
  const status = map.get('status');
  return isStatus(status)
    ? { ok: true, atom: { frontmatter: composeFrontmatter(map, status, sources), body } }
    : {
        ok: false,
        error: `field "status" MUST be one of ${ATOM_STATUSES.join(' | ')} — got "${status ?? ''}"`,
      };
};

const toResult = (state: FoldState, body: string): ParseAtomResult => {
  const map = toMap(state.scalars);
  const error = state.error ?? validationError(map, state.sources);
  return error === undefined ? withStatus(map, state.sources, body) : { ok: false, error };
};

/**
 * Parse one atom file. Refuses — never throws and never guesses — on anything
 * outside the closed subset described at the top of this module.
 */
export const parseAtom = (text: string): ParseAtomResult => {
  const document = splitDocument(text);
  return document === undefined
    ? { ok: false, error: DELIMITER_ERROR }
    : toResult(document.lines.reduce(stepLine, EMPTY_STATE), document.body);
};

const optionalLine = (key: string, value: string | undefined): readonly string[] =>
  value === undefined ? [] : [`${key}: ${value}`];

const frontmatterLines = (frontmatter: AtomFrontmatter): readonly string[] => [
  `type: ${frontmatter.type}`,
  `id: ${frontmatter.id}`,
  `title: ${frontmatter.title}`,
  `x_domain: ${frontmatter.x_domain}`,
  `status: ${frontmatter.status}`,
  ...optionalLine('stale_after', frontmatter.stale_after),
  SOURCES_KEY,
  ...frontmatter.sources.map(source => `${SOURCE_ITEM_PREFIX}${source}`),
  ...optionalLine('verified_by', frontmatter.verified_by),
  ...optionalLine('verified_at', frontmatter.verified_at),
];

/**
 * The document EOL is recovered from the BODY, which is the only verbatim part
 * of a parsed atom. A document whose frontmatter and body disagree on line
 * endings is outside the closed subset and does not round-trip byte-identically.
 */
const detectEol = (body: string): string => (body.includes('\r\n') ? '\r\n' : '\n');

/**
 * Emit an atom file. Field order is fixed and canonical, and the body is
 * written back BYTE-VERBATIM — footnote definitions, fenced blocks and `---`
 * lines inside it are opaque to this module.
 */
export const serializeAtom = (frontmatter: AtomFrontmatter, body: string): string => {
  const eol = detectEol(body);
  const block = [DELIMITER, ...frontmatterLines(frontmatter), DELIMITER];
  return `${block.join(eol)}${eol}${body}`;
};
