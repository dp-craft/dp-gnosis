import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { Atom } from './atom.js';
import { serializeAtom } from './atom.js';
import type { MarkdownChunk } from './chunker.js';
import { chunkMarkdown } from './chunker.js';
import type { AtomDomain } from './config.js';
import { domainForSource, SOURCE_ROOT_DOMAINS } from './config.js';
import { ATOMS_DIR, REPO_ROOT } from './paths.js';
import { readExistingIds, validateAtom } from './validate.js';

/**
 * WAVE-1 INGEST — a knowingly TEMPORARY write path.
 *
 * This module reads local markdown and writes atoms STRAIGHT INTO
 * `gnosis/atoms/`. The admission gate, the `proposals/` staging boundary and
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
 * non-empty `git diff` over `gnosis/atoms/` after re-ingesting means the
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
const TITLE_SEPARATOR = ' > ';
/** A NUL cannot occur in a heading or a path, so a composite key never splits wrongly. */
const KEY_SEPARATOR = '\u0000';

/** Where the ingest run reads from and writes to; every path is injectable for tests. */
export interface IngestOptions {
  /** Markdown files and/or directories to ingest. */
  readonly sources: readonly string[];
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

const expandSources = async (sources: readonly string[]): Promise<readonly string[]> => {
  const nested = await Promise.all(sources.map(listMarkdown));
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

const toCandidates = (source: LoadedSource): readonly Candidate[] => {
  const domain = source.domain;
  if (domain === undefined) return [];
  return chunkMarkdown(source.text).map((chunk, index) => ({
    sourcePath: source.sourcePath,
    index,
    chunk,
    domain,
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

const resolveTitle = (candidate: Candidate, ambiguous: ReadonlySet<string>): string =>
  ambiguous.has(candidate.chunk.title)
    ? candidate.chunk.headingChain.join(TITLE_SEPARATOR)
    : candidate.chunk.title;

const toAtom = (candidate: Candidate, id: string, title: string): Atom => ({
  frontmatter: {
    type: 'knowledge',
    id,
    title,
    x_domain: candidate.domain,
    status: 'stable',
    sources: [candidate.sourcePath],
  },
  body: `${candidate.chunk.body}\n`,
});

const planAtoms = (candidates: readonly Candidate[]): readonly PlannedAtom[] => {
  const based = candidates.map(candidate => ({ candidate, base: baseIdOf(candidate) }));
  const collided = duplicatesOf(based.map(entry => entry.base));
  const ambiguous = ambiguousTitles(candidates);
  return based.map(entry => ({
    candidate: entry.candidate,
    atom: toAtom(entry.candidate, resolveId(entry, collided), resolveTitle(entry.candidate, ambiguous)),
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

const checkAtoms = (
  planned: readonly PlannedAtom[],
  existing: ReadonlySet<string>
): readonly CheckedAtom[] => {
  const runIds = new Set(planned.map(entry => entry.atom.frontmatter.id));
  const reserved = foreignIds(existing, runIds);
  return planned.map(entry => ({ ...entry, reasons: validateAtom(entry.atom, reserved) }));
};

/**
 * Ingest local markdown into atom files. Refusals are reported, never thrown
 * and never silently defaulted; the write set is always fully valid.
 */
export const ingest = async (options: IngestOptions): Promise<IngestSummary> => {
  const outputDir = options.outputDir ?? ATOMS_DIR;
  const files = await expandSources(options.sources);
  const loaded = await Promise.all(
    [...files].sort().map(file => loadSource(file, options.repoRoot ?? REPO_ROOT))
  );
  const unmapped = loaded.filter(source => source.domain === undefined).map(unmappedSkip);
  const candidates = [...loaded.flatMap(toCandidates)].sort(byOrder);
  const checked = checkAtoms(planAtoms(candidates), await readExistingIds(outputDir));
  const writable = checked.filter(entry => entry.reasons.length === 0);
  await mkdir(outputDir, { recursive: true });
  await Promise.all(writable.map(entry => writeAtom(outputDir, entry)));
  const refused = checked.filter(entry => entry.reasons.length > 0).map(toSkip);
  return { written: writable.length, skipped: [...unmapped, ...refused] };
};
