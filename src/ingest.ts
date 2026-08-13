import { createHash } from 'node:crypto';
import { globSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { Atom } from './atom.js';
import { serializeAtom } from './atom.js';
import type { MarkdownChunk } from './chunker.js';
import { chunkMarkdown, frontMatterTitle, headingLine, headingPath } from './chunker.js';
import type { AtomDomain } from './config.js';
import {
  bodyMaxChars,
  CORPUS_ROOTS_ENV_VAR,
  domainForSource,
  resolveCorpusRoots,
  SOURCE_ROOT_DOMAINS,
  typeForSource
} from './config.js';
import { ATOMS_DIR, REPO_ROOT } from './paths.js';
import { readExistingIds, validateAtom } from './validate.js';

/**
 * WAVE-1 INGEST — a knowingly TEMPORARY write path.
 *
 * This module reads local markdown and writes atoms STRAIGHT INTO
 * `dp-gnosis/vault/atoms/`. The admission gate, the `proposals/` staging boundary and
 * the "only validated, reviewed atoms reach the vault" invariant all arrive in
 * Wave 2, which REPLACES this module. Do not mistake it for the finished write
 * path and do not build on its file-writing behaviour.
 *
 * What IS meant to survive: the pipeline shape (chunk → frontmatter → validate
 * → serialize) and the determinism contract below.
 *
 * DETERMINISM CONTRACT. Ingest is a pure function of its inputs: the same
 * corpus always yields byte-identical atom files. That is why `sources` carries
 * the repo-relative source path — provenance is the smaller half of the reason.
 * The larger half is DRIFT DETECTION: because a re-run reproduces every byte, a
 * non-empty `git diff` over `dp-gnosis/vault/atoms/` after re-ingesting means the
 * underlying document actually changed. Without byte-stability that signal is
 * lost in incidental churn, and an atom can silently outlive the doc it came
 * from. Encounter-order-dependent ids, absolute paths and timestamps would each
 * destroy it, so none of them appear here.
 *
 * BAD-CHUNK POLICY: SKIP-AND-REPORT, never abort. One refused chunk (or one
 * unmapped source) MUST NOT withhold the rest of a corpus, and it is never
 * silent — every refusal lands in `IngestSummary.skipped` with the message
 * naming its correction, and the caller renders that in the corpus report.
 */

const MD_SUFFIX = '.md';

/** Leaves room for `-<fingerprint>` so an id's length never depends on collisions. */
const MAX_ID_CHARS = 100;
const FINGERPRINT_CHARS = 8;
const MAX_BASE_CHARS = MAX_ID_CHARS - FINGERPRINT_CHARS - 1;

const NON_SLUG_RE = /[^a-z0-9]+/g;
const EDGE_HYPHEN_RE = /^-+|-+$/g;
const FALLBACK_SLUG = 'atom';
/** A NUL cannot occur in a heading or a path, so a composite key never splits wrongly. */
const KEY_SEPARATOR = '\u0000';

/** Where the ingest run reads from and writes to; every path is injectable for tests. */
export interface IngestOptions {
  /**
   * Repo-relative roots to walk. Defaults to the configured corpus scope, which
   * is the ONLY thing that decides what ingest reads — a caller cannot reach a
   * document outside it by naming a path.
   */
  readonly corpusRoots?: readonly string[];
  /** Atom output directory. Defaults to the real vault. */
  readonly outputDir?: string;
  /**
   * Root the recorded `sources` path is made relative to. Injectable so a test
   * can build a fixture tree under a temp dir without writing into the vault.
   */
  readonly repoRoot?: string;
}

/** One refused chunk or source, with the reasons naming its correction. */
export interface IngestSkip {
  readonly source: string;
  readonly title: string;
  readonly reasons: readonly string[];
}

/** What a run wrote and what it refused — the caller's corpus-report input. */
export interface IngestSummary {
  readonly written: number;
  readonly skipped: readonly IngestSkip[];
}

interface LoadedSource {
  readonly sourcePath: string;
  readonly text: string;
  readonly domain: AtomDomain | undefined;
}

interface Candidate {
  readonly sourcePath: string;
  readonly index: number;
  readonly chunk: MarkdownChunk;
  readonly domain: AtomDomain;
  /** The document this chunk came from, named once per source. */
  readonly docTitle: string;
  /** The document's declared summary, resolved once per source; absent when it declared none. */
  readonly summary: string | undefined;
  /** ` (i/n)` when the section emitted several chunks, else empty. */
  readonly part: string;
}

interface BasedCandidate {
  readonly candidate: Candidate;
  readonly base: string;
}

interface PlannedAtom {
  readonly candidate: Candidate;
  readonly atom: Atom;
}

interface CheckedAtom extends PlannedAtom {
  readonly reasons: readonly string[];
}

const toPosix = (path: string): string => path.split(sep).join('/');

const listMarkdown = async (path: string): Promise<readonly string[]> => {
  const info = await stat(path);
  if (!info.isDirectory()) return [path];
  const names = await readdir(path, { recursive: true });
  return names
    .filter(name => name.endsWith(MD_SUFFIX))
    .map(name => join(path, name))
    .sort();
};

/** A root carrying this is a glob over repo-root-relative paths, not a directory. */
const GLOB_MARKER = '*';

const listGlob = (repoRoot: string, pattern: string): readonly string[] =>
  globSync(pattern, { cwd: repoRoot })
    .filter(name => name.endsWith(MD_SUFFIX))
    .map(name => join(repoRoot, name))
    .sort();

/** A missing root is not distinguished from an empty one — both are zero matches. */
const listRoot = async (repoRoot: string, root: string): Promise<readonly string[]> =>
  root.includes(GLOB_MARKER)
    ? listGlob(repoRoot, root)
    : await listMarkdown(join(repoRoot, root)).catch(() => []);

/**
 * A configured root that matches nothing is a CONFIGURATION ERROR, not an empty
 * corpus: a typo'd root would otherwise index zero documents in silence and the
 * only symptom would be queries that return nothing.
 */
const resolveRoot = async (repoRoot: string, root: string): Promise<readonly string[]> => {
  const files = await listRoot(repoRoot, root);
  if (files.length > 0) return files;
  throw new Error(
    `corpus root "${root}" matched no markdown files under ${repoRoot} — fix or remove it in CORPUS_ROOTS (src/config.ts) or ${CORPUS_ROOTS_ENV_VAR}`
  );
};

const expandCorpus = async (
  repoRoot: string,
  corpusRoots: readonly string[]
): Promise<readonly string[]> => {
  const nested = await Promise.all(corpusRoots.map(root => resolveRoot(repoRoot, root)));
  return [...new Set(nested.flat())];
};

const loadSource = async (absolutePath: string, repoRoot: string): Promise<LoadedSource> => {
  const sourcePath = toPosix(relative(repoRoot, absolutePath));
  return { sourcePath, text: await readFile(absolutePath, 'utf8'), domain: domainForSource(sourcePath) };
};

const ROOT_LIST = SOURCE_ROOT_DOMAINS.map(rule => rule.prefix).join(' | ');

const unmappedSkip = (source: LoadedSource): IngestSkip => ({
  source: source.sourcePath,
  title: basename(source.sourcePath),
  reasons: [
    `source "${source.sourcePath}" is outside every declared ingest root — move it under one of ${ROOT_LIST}, or declare its root in SOURCE_ROOT_DOMAINS (src/config.ts); ingest MUST NOT guess a domain`,
  ],
});

const isNamed = (part: string | undefined): boolean => part !== undefined && part.trim().length > 0;

const firstH1 = (chunks: readonly MarkdownChunk[]): string | undefined =>
  chunks.map(chunk => chunk.headingChain[0]).find(isNamed);

/** The last resort: a file name is the one name a document always has. */
const stemTitle = (sourcePath: string): string =>
  basename(sourcePath, MD_SUFFIX).split('-').join(' ');

/**
 * One name per document, the same for every chunk it yields: an atom retrieved
 * from a deep subsection has to say which document it belongs to, and its own
 * heading chain never carries that.
 */
const documentTitle = (source: LoadedSource, chunks: readonly MarkdownChunk[]): string =>
  frontMatterTitle(source.text) ?? firstH1(chunks) ?? stemTitle(source.sourcePath);

/**
 * A document's own summary: the FIRST `<!-- LLM-PRIMARY: … -->` comment,
 * wherever it sits in the text. Whitespace is collapsed because the comment may
 * wrap over several lines while a frontmatter scalar is one line by definition.
 */
const SUMMARY_COMMENT_RE = /<!--\s*LLM-PRIMARY:\s*([\s\S]*?)-->/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const WHITESPACE_RUN_RE = /\s+/g;
/** Removing a comment leaves the blank lines that framed it; three or more collapse to one break. */
const BLANK_RUN_RE = /\n{3,}/g;

const documentSummary = (text: string): string | undefined => {
  const raw = SUMMARY_COMMENT_RE.exec(text)?.[1] ?? '';
  const collapsed = raw.replace(WHITESPACE_RUN_RE, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
};

/**
 * An HTML comment is invisible to a reader but indexed as text, so it can only
 * mislead retrieval — and an atom whose whole body is one asserts nothing.
 */
const stripComments = (body: string): string =>
  body.replace(HTML_COMMENT_RE, '').replace(BLANK_RUN_RE, '\n\n').trim();

const chainKey = (chunk: MarkdownChunk): string => chunk.headingChain.join(KEY_SEPARATOR);

/**
 * ` (i/n)` for a section the chunker split, empty for one it did not. Measured
 * on the live corpus, 3 133 atoms shared a title with another atom of their own
 * section — 42 of them from one appendix — so a retrieved part could not say
 * which part it was. The heading chain is deliberately untouched: atom ids are
 * derived from it.
 */
const partSuffix = (
  chunks: readonly MarkdownChunk[],
  chunk: MarkdownChunk,
  index: number
): string => {
  const key = chainKey(chunk);
  const peers = chunks.filter(peer => chainKey(peer) === key);
  const ordinal = chunks.slice(0, index + 1).filter(peer => chainKey(peer) === key).length;
  return peers.length > 1 ? ` (${ordinal}/${peers.length})` : '';
};

const toCandidates = (source: LoadedSource): readonly Candidate[] => {
  const domain = source.domain;
  if (domain === undefined) return [];
  const chunks = chunkMarkdown(source.text);
  const docTitle = documentTitle(source, chunks);
  const summary = documentSummary(source.text);
  return chunks.map((chunk, index) => ({
    sourcePath: source.sourcePath,
    index,
    chunk,
    domain,
    docTitle,
    summary,
    part: partSuffix(chunks, chunk, index),
  }));
};

const byOrder = (left: Candidate, right: Candidate): number =>
  left.sourcePath === right.sourcePath
    ? left.index - right.index
    : left.sourcePath.localeCompare(right.sourcePath);

const slugify = (text: string): string => {
  const slug = text.toLowerCase().replace(NON_SLUG_RE, '-').replace(EDGE_HYPHEN_RE, '');
  return slug.length > 0 ? slug : FALLBACK_SLUG;
};

/** Truncates on a segment boundary so the result is still a well-formed slug. */
const truncateSlug = (slug: string, max: number): string => {
  const kept = slug
    .split('-')
    .reduce<readonly string[]>(
      (acc, segment) => ([...acc, segment].join('-').length <= max ? [...acc, segment] : acc),
      []
    );
  return kept.length > 0 ? kept.join('-') : slug.slice(0, max);
};

const baseIdOf = (candidate: Candidate): string => {
  const stem = basename(candidate.sourcePath, MD_SUFFIX);
  return truncateSlug(slugify([stem, ...candidate.chunk.headingChain].join(' ')), MAX_BASE_CHARS);
};

/**
 * Collision suffix derived from the chunk's own coordinates, NOT from its
 * position in the run: two documents whose headings slugify alike keep the same
 * ids whatever order they were handed in, and inserting a third never renumbers
 * the first two.
 */
const fingerprint = (candidate: Candidate): string =>
  createHash('sha1')
    .update(`${candidate.sourcePath}${KEY_SEPARATOR}${candidate.index}`)
    .digest('hex')
    .slice(0, FINGERPRINT_CHARS);

const duplicatesOf = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.filter(value => values.indexOf(value) !== values.lastIndexOf(value)));

const resolveId = (based: BasedCandidate, collided: ReadonlySet<string>): string =>
  collided.has(based.base) ? `${based.base}-${fingerprint(based.candidate)}` : based.base;

/** Titles carried by more than one source file — those need the heading chain. */
const ambiguousTitles = (candidates: readonly Candidate[]): ReadonlySet<string> => {
  const pairs = [
    ...new Set(candidates.map(c => `${c.chunk.title}${KEY_SEPARATOR}${c.sourcePath}`)),
  ];
  return duplicatesOf(pairs.map(pair => pair.split(KEY_SEPARATOR)[0] ?? ''));
};

/** No atom ships an unnamed title: an empty resolution falls back to the document. */
const resolveTitle = (candidate: Candidate, ambiguous: ReadonlySet<string>): string => {
  const resolved = ambiguous.has(candidate.chunk.title)
    ? headingPath(candidate.chunk.headingChain)
    : candidate.chunk.title;
  return resolved.trim().length > 0 ? resolved : candidate.docTitle;
};

/** Head lines and body joined by a blank line; an empty side contributes nothing. */
const composeBody = (head: readonly string[], body: string): string =>
  `${[head.join('\n'), body].filter(part => part.length > 0).join('\n\n')}\n`;

/**
 * The cap outranks the heading line: a body it cannot fit beside is written
 * unprefixed rather than refused for being oversize.
 *
 * Which cap that is comes from `bodyMaxChars` over the PREFIXED body, the exact
 * string the validator will later measure — a fenced diagram the chunker kept
 * whole is up to 8000 characters, so measuring it against 4000 would strip the
 * heading off the one atom shape that most needs its topic sentence.
 */
const bodyWithHeading = (candidate: Candidate): string => {
  const body = stripComments(candidate.chunk.body);
  const prefixed = composeBody([headingLine(candidate.chunk.headingChain)], body);
  return prefixed.length <= bodyMaxChars(prefixed) ? prefixed : composeBody([], body);
};

const toAtom = (candidate: Candidate, id: string, title: string): Atom => ({
  frontmatter: {
    type: typeForSource(candidate.sourcePath),
    id,
    title,
    x_domain: candidate.domain,
    ...(candidate.summary === undefined ? {} : { summary: candidate.summary }),
    status: 'stable',
    sources: [candidate.sourcePath],
  },
  body: bodyWithHeading(candidate),
});

const planAtoms = (candidates: readonly Candidate[]): readonly PlannedAtom[] => {
  const based = candidates.map(candidate => ({ candidate, base: baseIdOf(candidate) }));
  const collided = duplicatesOf(based.map(entry => entry.base));
  const ambiguous = ambiguousTitles(candidates);
  return based.map(entry => ({
    candidate: entry.candidate,
    atom: toAtom(
      entry.candidate,
      resolveId(entry, collided),
      `${resolveTitle(entry.candidate, ambiguous)}${entry.candidate.part}`
    ),
  }));
};

/**
 * Ids this run derives are ITS OWN: re-ingesting an unchanged corpus rewrites
 * them with identical bytes rather than tripping the uniqueness rule, which is
 * what makes the re-run a drift detector. Every other id already on disk stays
 * reserved and refuses a clashing write.
 */
const foreignIds = (existing: ReadonlySet<string>, runIds: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...existing].filter(id => !runIds.has(id)));

const toSkip = (checked: CheckedAtom): IngestSkip => ({
  source: checked.candidate.sourcePath,
  title: checked.atom.frontmatter.title,
  reasons: checked.reasons,
});

const writeAtom = async (outputDir: string, planned: PlannedAtom): Promise<void> => {
  const { frontmatter, body } = planned.atom;
  await writeFile(join(outputDir, `${frontmatter.id}${MD_SUFFIX}`), serializeAtom(frontmatter, body), 'utf8');
};

/**
 * An atom whose body holds nothing but its own heading line indexes nothing:
 * every index except the linear scan reads `atom.body`, and the heading line is
 * stripped before it is read, so the atom can never be retrieved by any query.
 * Measured on the live corpus, 107 of 43 228 atoms were empty this way —
 * bare-heading sections and sections whose whole body was an HTML comment.
 */
const emptyBodyReasons = (planned: PlannedAtom): readonly string[] =>
  stripComments(planned.candidate.chunk.body).length > 0
    ? []
    : [
        `section "${planned.atom.frontmatter.title}" has an empty body once its heading line is stripped, so it would index nothing and could never be retrieved — give the section prose of its own, or remove the heading`,
      ];

const checkAtoms = (
  planned: readonly PlannedAtom[],
  existing: ReadonlySet<string>
): readonly CheckedAtom[] => {
  const runIds = new Set(planned.map(entry => entry.atom.frontmatter.id));
  const reserved = foreignIds(existing, runIds);
  return planned.map(entry => ({
    ...entry,
    reasons: [...validateAtom(entry.atom, reserved), ...emptyBodyReasons(entry)],
  }));
};

/**
 * Ingest local markdown into atom files. Refusals are reported, never thrown
 * and never silently defaulted; the write set is always fully valid.
 */
export const ingest = async (options: IngestOptions): Promise<IngestSummary> => {
  const outputDir = options.outputDir ?? ATOMS_DIR;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const files = await expandCorpus(repoRoot, options.corpusRoots ?? resolveCorpusRoots());
  const loaded = await Promise.all([...files].sort().map(file => loadSource(file, repoRoot)));
  const unmapped = loaded.filter(source => source.domain === undefined).map(unmappedSkip);
  const candidates = [...loaded.flatMap(toCandidates)].sort(byOrder);
  const checked = checkAtoms(planAtoms(candidates), await readExistingIds(outputDir));
  const writable = checked.filter(entry => entry.reasons.length === 0);
  await mkdir(outputDir, { recursive: true });
  await Promise.all(writable.map(entry => writeAtom(outputDir, entry)));
  const refused = checked.filter(entry => entry.reasons.length > 0).map(toSkip);
  return { written: writable.length, skipped: [...unmapped, ...refused] };
};
