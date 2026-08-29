import { createHash } from 'node:crypto';
import { globSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Atom } from './atom.js';
import { serializeAtom } from './atom.js';
import type { MarkdownChunk } from './chunker.js';
import { chunkMarkdown, frontMatterTitle, headingLine, headingPath } from './chunker.js';
import { bodyMaxChars, corpusRootStatements, resolveCorpusRoots } from './config.js';
import type { CorpusManifestInput, ManifestAtom } from './corpusManifest.js';
import { buildCorpusManifest, CORPUS_MANIFEST_FILE, serializeCorpusManifest } from './corpusManifest.js';
import { expandUserPath } from './env.js';
import type { IngestProfile } from './ingestProfile.js';
import { domainForPath, typeForPath } from './ingestProfile.js';
import { atomsDir, REPO_ROOT } from './paths.js';
import { loadSummarySidecar } from './summarySidecar.js';
import { readExistingIds, validateAtom } from './validate.js';
import { activeProfile } from './vocabulary.js';

/**
 * WAVE-1 INGEST — a knowingly TEMPORARY write path.
 *
 * This module reads local markdown and writes atoms STRAIGHT INTO
 * `benchmark-data/vault/atoms/`. The admission gate, the `proposals/` staging boundary and
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
 * non-empty `git diff` over `benchmark-data/vault/atoms/` after re-ingesting means the
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
   * Roots to walk — relative to `repoRoot`, or absolute / `~`-rooted to reach a
   * tree outside it. Defaults to the configured corpus scope, which is the ONLY
   * thing that decides what ingest reads — a caller cannot reach a document
   * outside it by naming a path.
   */
  readonly corpusRoots?: readonly string[] | undefined;
  /** Atom output directory. Defaults to the real vault. */
  readonly outputDir?: string;
  /**
   * Root the recorded `sources` path is made relative to. Injectable so a test
   * can build a fixture tree under a temp dir without writing into the vault.
   */
  readonly repoRoot?: string;
  /**
   * The vocabulary and labelling policy the run applies. Defaults to the
   * shipped profile, which is what the repo's own corpus is ingested with.
   */
  readonly profile?: IngestProfile;
  /**
   * Ids a golden set judges. Read by the exact-body dedupe ONLY, to decide
   * which copy of a mirrored document survives. Absent — the default, and what
   * every caller that does not measure retrieval passes — leaves the dedupe
   * gold-blind, so no existing run changes shape by adding the field.
   *
   * An id is matched against the atom id AND against the source basename,
   * because the two consumers name a gold document differently: the vault's
   * golden sets name the ATOM FILENAME (= the atom id), while the benchmark
   * scores a retrieved atom through its source basename
   * (`dp-gnosis-bench/src/score.ts`), which is the id of the materialized
   * document it re-ingests.
   */
  readonly goldIds?: readonly string[];
}

/** One refused chunk or source, with the reasons naming its correction. */
export interface IngestSkip {
  readonly source: string;
  readonly title: string;
  readonly reasons: readonly string[];
}

/** What a run wrote, what it refused and what it removed — the caller's corpus-report input. */
export interface IngestSummary {
  readonly written: number;
  readonly skipped: readonly IngestSkip[];
  /** Atom files left by an earlier run that this one no longer produces. */
  readonly pruned: number;
  /**
   * How many of `skipped` were refused as an exact-body duplicate. A SUBSET of
   * the skip count, reported separately because it is the one refusal class
   * that says nothing about the source document's quality — a mirrored body is
   * the corpus being deduplicated, not a document needing a correction.
   */
  readonly duplicates: number;
}

/** One in-scope source document, read once. Exported so the sidecar extractor walks the SAME scope. */
export interface LoadedSource {
  readonly sourcePath: string;
  readonly text: string;
  /** A profile-declared domain; `undefined` when no declared root claims the source. */
  readonly domain: string | undefined;
}

interface Candidate {
  readonly sourcePath: string;
  readonly index: number;
  readonly chunk: MarkdownChunk;
  readonly domain: string;
  /** The profile-declared type, resolved once per source. */
  readonly type: string;
  /** The document this chunk came from, named once per source. */
  readonly docTitle: string;
  /** The document's declared summary, resolved once per source; absent when it declared none. */
  readonly summary: string | undefined;
  /** How many chunks this source document produced, so `index` reads as `i of n`. */
  readonly originCount: number;
  /** ` (i/n)` when the section emitted several chunks, else empty. */
  readonly part: string;
  /** The cap this run chunks and writes against; the profile's, else the shipped one. */
  readonly maxChars: number | undefined;
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
    .map(name => resolve(repoRoot, name))
    .sort();

/**
 * WHERE A CORPUS ROOT LIVES. A root is expanded (`~/x` → the home directory)
 * and then read one of two ways: an ABSOLUTE root is used as it stands, and a
 * RELATIVE one is joined to `repoRoot` exactly as it always was. That is what
 * lets ONE index span project doc trees that share no parent, without moving a
 * single shipped profile — every shipped root is relative.
 */
const rootLocation = (repoRoot: string, root: string): string => {
  const expanded = expandUserPath(root);
  return isAbsolute(expanded) ? expanded : join(repoRoot, expanded);
};

/** A missing root is not distinguished from an empty one — both are zero matches. */
const listRoot = async (repoRoot: string, root: string): Promise<readonly string[]> =>
  root.includes(GLOB_MARKER)
    ? listGlob(repoRoot, expandUserPath(root))
    : await listMarkdown(rootLocation(repoRoot, root)).catch(() => []);

/**
 * A configured root that matches nothing is a CONFIGURATION ERROR, not an empty
 * corpus: a typo'd root would otherwise index zero documents in silence and the
 * only symptom would be queries that return nothing.
 */
const resolveRoot = async (repoRoot: string, root: string): Promise<readonly string[]> => {
  const files = await listRoot(repoRoot, root);
  if (files.length > 0) return files;
  throw new Error(
    `corpus root "${root}" matched no markdown files under ${rootLocation(repoRoot, root)} — fix or remove it ${corpusRootStatements()}`
  );
};

const expandCorpus = async (
  repoRoot: string,
  corpusRoots: readonly string[]
): Promise<readonly string[]> => {
  const nested = await Promise.all(corpusRoots.map(root => resolveRoot(repoRoot, root)));
  return [...new Set(nested.flat())];
};

/**
 * PATH EXCLUSION — a source under a declared `excludePaths` prefix is dropped
 * BEFORE it is read, so it is never chunked, never validated and never counted.
 * That placement is the rule, not an optimisation: a generated tree is not a
 * document that failed a check, so surfacing it in `skipped[]` would drown the
 * refusals a reader has to act on under 22 597 entries nothing can be done
 * about. A forward-slash `startsWith` match against the source IDENTITY (see
 * {@link sourceIdentity}), exactly like `domainRules`: a repo-relative prefix
 * excludes an in-repo subtree, and an absolute or `~`-rooted one excludes a
 * subtree of an absolute corpus root.
 */
const isExcluded = (profile: IngestProfile, sourcePath: string): boolean =>
  (profile.excludePaths ?? []).some(prefix => sourcePath.startsWith(prefix));

/**
 * HOW A SOURCE IS NAMED, and therefore how every prefix rule matches it.
 *
 * A source UNDER `repoRoot` keeps its repo-relative path, byte for byte as
 * before — that is what leaves every shipped profile, every recorded atom and
 * every `domainRules` prefix untouched. A source reached through an ABSOLUTE or
 * `~` corpus root lies outside `repoRoot`, has no meaningful repo-relative name
 * (`relative()` would walk out through `..`), and is named by its own absolute
 * path instead. `domainRules[].prefix`, `typeRules[].prefix` and `excludePaths`
 * match THIS string, so an out-of-repo tree is claimed by declaring its
 * absolute (or `~`-rooted) prefix — and a tree nobody declared stays refused by
 * `unmappedSkip`, loudly, because ingest MUST NOT guess a domain.
 *
 * Exported because `init` MUST write its `domainRules` prefixes in this form —
 * an absolute prefix over an in-repo root matches nothing, and every source is
 * then refused. One owner of the rule, called by both sides.
 */
export const sourceIdentity = (repoRoot: string, absolutePath: string): string => {
  const relativePath = toPosix(relative(repoRoot, absolutePath));
  return relativePath.startsWith('..') || isAbsolute(relativePath)
    ? toPosix(absolutePath)
    : relativePath;
};

const loadSource = async (
  absolutePath: string,
  repoRoot: string,
  profile: IngestProfile
): Promise<LoadedSource> => {
  const sourcePath = sourceIdentity(repoRoot, absolutePath);
  return {
    sourcePath,
    text: await readFile(absolutePath, 'utf8'),
    domain: domainForPath(profile, sourcePath),
  };
};

/**
 * Every in-scope source of the run, read once, in sorted path order. Exported
 * because the sidecar extractor MUST walk the corpus ingest walks — a second
 * hand-rolled scope is how two commands end up reading different corpora.
 */
export const loadCorpus = async (
  repoRoot: string,
  corpusRoots: readonly string[],
  profile: IngestProfile
): Promise<readonly LoadedSource[]> => {
  const files = await expandCorpus(repoRoot, corpusRoots);
  const kept = [...files].sort().filter(file => !isExcluded(profile, sourceIdentity(repoRoot, file)));
  return await Promise.all(kept.map(file => loadSource(file, repoRoot, profile)));
};

const unmappedSkip = (source: LoadedSource, profile: IngestProfile): IngestSkip => ({
  source: source.sourcePath,
  title: basename(source.sourcePath),
  reasons: [
    `source "${source.sourcePath}" is outside every declared ingest root — move it under one of ${profile.domainRules.map(rule => rule.prefix).join(' | ')}, or declare its root in the "domainRules" table of the ingest profile in use ("${profile.name}"); ingest MUST NOT guess a domain`,
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

export const documentSummary = (text: string): string | undefined => {
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

/**
 * SUMMARY RESOLUTION, and the direction is deliberate: an in-source
 * `LLM-PRIMARY` comment WINS, the sidecar fills in for a document that declares
 * none, and neither leaves `summary` absent. That makes the sidecar strictly
 * ADDITIVE — a corpus whose documents still carry their comments ingests
 * byte-identically, so every recorded baseline stands.
 */
const resolveSummary = (
  source: LoadedSource,
  summaries: ReadonlyMap<string, string>
): string | undefined => documentSummary(source.text) ?? summaries.get(source.sourcePath);

/** What one source document contributes to every candidate it yields, resolved once. */
interface DocumentContext {
  readonly domain: string;
  readonly docTitle: string;
  readonly summary: string | undefined;
  readonly chunks: readonly MarkdownChunk[];
}

const toCandidate =
  (source: LoadedSource, profile: IngestProfile, doc: DocumentContext) =>
    (chunk: MarkdownChunk, index: number): Candidate => ({
      sourcePath: source.sourcePath,
      index,
      originCount: doc.chunks.length,
      chunk,
      domain: doc.domain,
      type: typeForPath(profile, source.sourcePath),
      docTitle: doc.docTitle,
      summary: doc.summary,
      part: partSuffix(doc.chunks, chunk, index),
      maxChars: profile.atomMaxChars,
    });

const toCandidates = (
  source: LoadedSource,
  profile: IngestProfile,
  summaries: ReadonlyMap<string, string>
): readonly Candidate[] => {
  const domain = source.domain;
  if (domain === undefined) return [];
  const chunks = chunkMarkdown(source.text, profile.atomMaxChars);
  const doc: DocumentContext = {
    domain,
    docTitle: documentTitle(source, chunks),
    summary: resolveSummary(source, summaries),
    chunks,
  };
  return chunks.map(toCandidate(source, profile, doc));
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
  return prefixed.length <= bodyMaxChars(prefixed, candidate.maxChars)
    ? prefixed
    : composeBody([], body);
};

/** An empty chain writes NO key: an empty value would assert a section named "". */
const headingChainField = (candidate: Candidate): Readonly<Record<string, string>> => {
  const chain = headingPath(candidate.chunk.headingChain);
  return chain.length === 0 ? {} : { heading_chain: chain };
};

const toAtom = (candidate: Candidate, id: string, title: string): Atom => ({
  frontmatter: {
    type: candidate.type,
    id,
    title,
    x_domain: candidate.domain,
    ...(candidate.summary === undefined ? {} : { summary: candidate.summary }),
    ...headingChainField(candidate),
    origin_index: candidate.index,
    origin_count: candidate.originCount,
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

const atomText = (planned: PlannedAtom): string =>
  serializeAtom(planned.atom.frontmatter, planned.atom.body);

const writeAtom = async (outputDir: string, planned: PlannedAtom): Promise<void> => {
  await writeFile(join(outputDir, `${planned.atom.frontmatter.id}${MD_SUFFIX}`), atomText(planned), 'utf8');
};

const manifestAtom = (planned: PlannedAtom): ManifestAtom => ({
  id: planned.atom.frontmatter.id,
  type: planned.atom.frontmatter.type,
  domain: planned.atom.frontmatter.x_domain,
  content: atomText(planned),
});

/**
 * The manifest sits BESIDE the atoms directory, not inside it: the vault's
 * `atoms/` is gitignored precisely because it is regenerable, so a manifest
 * written into it could never be committed — and an uncommittable manifest
 * re-anchors nothing. One directory up (`benchmark-data/vault/corpus-manifest.json`
 * for the real vault) is tracked, is where a reader already looks for the
 * vault, and follows any profile that points `atomsDir` elsewhere.
 */
const writeManifest = async (outputDir: string, input: CorpusManifestInput): Promise<void> => {
  await writeFile(
    join(dirname(outputDir), CORPUS_MANIFEST_FILE),
    serializeCorpusManifest(buildCorpusManifest(input)),
    'utf8'
  );
};

/**
 * The OWNER MARKER: one file naming the profile that owns this atoms directory.
 *
 * Two instances that keep their atoms in one directory destroy each other
 * silently — `pruneOrphans` makes the tree hold EXACTLY the current run's write
 * set, so ingesting profile B into profile A's directory deletes every A atom
 * and answers every later A query with B's corpus. The marker turns that from a
 * convention into a checked fact. Not a `.md` file, so `pruneOrphans` and
 * `readExistingIds` both ignore it.
 */
export const ATOMS_OWNER_FILE = '.dp-gnosis-owner';

const ownerPath = (outputDir: string): string => join(outputDir, ATOMS_OWNER_FILE);

/** `undefined` = unmarked, which is the ADOPTION path for a pre-marker vault. */
const readOwner = async (outputDir: string): Promise<string | undefined> => {
  const text = await readFile(ownerPath(outputDir), 'utf8').catch(() => '');
  const owner = text.trim();
  return owner.length > 0 ? owner : undefined;
};

/**
 * Claim the output directory for this run's profile, or refuse the run. The
 * message names BOTH ids and the directory, because the correction is either
 * "point this profile elsewhere" or "run the other profile" and the reader
 * cannot choose without seeing all three.
 */
const claimOutputDir = async (outputDir: string, profile: IngestProfile): Promise<void> => {
  const owner = await readOwner(outputDir);
  if (owner === undefined) {
    await writeFile(ownerPath(outputDir), `${profile.name}\n`, 'utf8');
    return;
  }
  if (owner !== profile.name) {
    throw new Error(
      `atoms directory ${outputDir} is owned by ingest profile "${owner}", so profile "${profile.name}" MUST NOT write into it — a second profile's ingest prunes every atom the first one wrote; give "${profile.name}" its own atomsDir (and its own indexPath) or re-run as "${owner}"`
    );
  }
};

/**
 * An atom the current corpus no longer produces stays retrievable forever
 * otherwise: measured on a re-ingest, 11 345 atoms were written while 11 692
 * files sat in the tree, so 347 atoms from a superseded chunker kept answering
 * queries and polluting every retrieval measurement. The output tree is
 * therefore made to hold EXACTLY this run's write set — nothing outside
 * `outputDir` and nothing that is not a top-level `.md` file is considered.
 */
const isOrphan = (written: ReadonlySet<string>, name: string): boolean =>
  name.endsWith(MD_SUFFIX) && !written.has(name.slice(0, -MD_SUFFIX.length));

const pruneOrphans = async (
  outputDir: string,
  writable: readonly CheckedAtom[]
): Promise<number> => {
  const written = new Set(writable.map(entry => entry.atom.frontmatter.id));
  const names = await readdir(outputDir);
  const orphans = names.filter(name => isOrphan(written, name));
  await Promise.all(orphans.map(name => rm(join(outputDir, name))));
  return orphans.length;
};

/**
 * A vault AUTHORING rule: a heading-only section carries no knowledge of its
 * own, so it is refused rather than written. Measured on the live corpus, 107
 * of 43 228 atoms were empty this way — bare-heading sections and sections
 * whose whole body was an HTML comment.
 *
 * This gate tests a DIFFERENT STRING than the index reads, and that asymmetry
 * is deliberate but easy to misread. It reads `candidate.chunk.body` — the
 * section's prose WITHOUT its heading line — while every index reads
 * `atom.body`, which is `bodyWithHeading` `:356`, i.e. the heading line put
 * BACK in front of that prose. Mechanism, established from the code: the
 * chunker never puts the heading line into the chunk — `withHeading`
 * (`chunker.ts:133`) opens each chunk at `lines: []`, one line past the
 * heading — and `bodyWithHeading` re-adds it as `# <headingPath>`
 * (`chunker.ts:77`), dropping it again ONLY when the prefixed body would
 * exceed the cap. So a heading's terms ARE searchable.
 *
 * An earlier version of this comment claimed the heading "is stripped before it
 * is read" — i.e. that a title's terms are not searchable. Falsified by direct
 * measurement 2026-08-15: BEIR scifact document `4983` carries the term
 * "newborn" only in its title, nowhere in its `text`, and the fts5 index
 * returns that document for the token `newborn` (`fts5Adapter.ts:83,171`
 * insert `stemText(parsed.atom.body)` into a single-column contentless table,
 * so whatever `atom.body` holds is what is searchable).
 *
 * Consequence, recorded not fixed: a title-only SOURCE record is discarded even
 * though it would have been retrievable. On BEIR TREC-COVID that was 42 139 of
 * 171 332 records, costing 3 135 relevant judgments (12.71%) across 50 of 50
 * topics. The rule stays as written — per plan decision D6 the benchmark's need
 * is met in the bench projection (`packages/gnosis-bench/src/corpus.ts`), so a
 * benchmark corpus shape does not bend a vault authoring rule.
 */
const emptyBodyReasons = (planned: PlannedAtom): readonly string[] =>
  stripComments(planned.candidate.chunk.body).length > 0
    ? []
    : [
        `section "${planned.atom.frontmatter.title}" has an empty body once its heading line is stripped, so it would index nothing and could never be retrieved — give the section prose of its own, or remove the heading`,
      ];

/**
 * EXACT-BODY DEDUPE. Measured on the corpus roots as they stood before `docs/`
 * joined them, 497 atoms carried a body byte-identical to another atom's, in
 * 201 groups — so 296 of them could only ever occupy a rank a distinct answer
 * had earned. Consolidation, migration and mirrored appendices are how they get
 * there; none of them is a defect in the source document, which is why the
 * refusal names the atom that WAS kept instead of asking for a correction.
 *
 * The key is taken over the HEADING-STRIPPED body — `chunk.body`, the same
 * string `emptyBodyReasons` measures — and NOT over `atom.body`, which
 * `bodyWithHeading` has already prefixed with the heading line. Hashing the
 * composed string would miss exactly the common case: one body filed under two
 * different headings.
 */
const DUPLICATE_REASON_PREFIX = 'duplicate-body-of:';

/**
 * The floor the duplicate groups were measured at. Deliberately its OWN
 * binding despite reading the same 200 as `ATOM_MIN_CHARS`: that constant is
 * the chunker's fold threshold, and tuning one MUST NOT move the other. Below
 * it a byte-identical body is a boilerplate line, not a mirrored document.
 */
const DEDUPE_MIN_BODY_CHARS = 200;

const bodyKey = (planned: PlannedAtom): string | undefined => {
  const body = stripComments(planned.candidate.chunk.body);
  return body.length < DEDUPE_MIN_BODY_CHARS
    ? undefined
    : createHash('sha1').update(body).digest('hex');
};

/**
 * A gold id names either the ATOM or the SOURCE FILE, and both spellings are
 * accepted — see `IngestOptions.goldIds` for why the two consumers differ.
 */
const isJudged = (planned: PlannedAtom, gold: ReadonlySet<string>): boolean =>
  gold.has(planned.atom.frontmatter.id) ||
  gold.has(basename(planned.candidate.sourcePath, MD_SUFFIX));

/**
 * WHICH COPY SURVIVES. Judged first, then the lexicographically smallest atom
 * id — and the earlier rule, "the first by sorted SOURCE PATH", is what this
 * replaces.
 *
 * A source path LEADS WITH ITS CORPUS ROOT, so ordering by it orders by root:
 * every copy under one root outranks every copy under a later-sorting one, and
 * adding a root re-decides whole groups at once. Measured at T2.1: 8 benchmark
 * topics lost `recall@100` outright because the surviving copy moved to the
 * mirror the golden set does not judge, and the direction FLIPPED between the
 * two root sets in play. An atom id carries no root-derived component — it is
 * `basename + heading chain` with a fingerprint over the chunk's own
 * coordinates — so which root a copy lives under is worth nothing in the order,
 * and moving a document between roots cannot permute the outcome.
 *
 * `isJudged` is the clause that matters for a measured corpus: it pins the
 * survivor to the copy the golden set can credit, whatever else joins the
 * group. What neither clause can promise is invariance to a NEW group member
 * with a smaller id; unreachable gold is caught downstream by the benchmark's
 * derive refusal rather than papered over here.
 */
const byPreference =
  (gold: ReadonlySet<string>) =>
    (left: PlannedAtom, right: PlannedAtom): number => {
      if (isJudged(left, gold) !== isJudged(right, gold)) return isJudged(left, gold) ? -1 : 1;
      return left.atom.frontmatter.id.localeCompare(right.atom.frontmatter.id);
    };

/**
 * The DOCUMENT a judgment credits: the SOURCE FILE's basename, which is the id
 * `dp-gnosis-bench/src/score.ts` rolls a retrieved atom up to. Two members of one
 * byte-identical group are the same document only when this key matches, so it —
 * not the atom id — is what counts how many judged documents a group holds.
 */
const documentKey = (planned: PlannedAtom): string =>
  basename(planned.candidate.sourcePath, MD_SUFFIX);

/** A group holding this many judged DOCUMENTS cannot be reduced to one without losing gold. */
const DOUBLE_GOLD_DOCUMENTS = 2;

/** One member per judged document, keeping the most preferred copy of each. */
const judgedSurvivors = (
  group: readonly PlannedAtom[],
  gold: ReadonlySet<string>
): readonly PlannedAtom[] => {
  const judged = group.filter(entry => isJudged(entry, gold));
  return judged.filter(
    (entry, index) =>
      judged.findIndex(other => documentKey(other) === documentKey(entry)) === index
  );
};

/**
 * WHICH COPIES SURVIVE one byte-identical group, which arrives preference-sorted.
 *
 * At most ONE judged document in the group — the ordinary case, and the only one
 * a gold-blind run can produce — keeps exactly the most preferred member, which
 * is the rule this has always had.
 *
 * TWO OR MORE judged documents is the case keep-one cannot serve: whichever copy
 * loses, a document the golden set judges leaves the corpus entirely, and no arm
 * can retrieve it. Measured on `vault` at T2.1a: 10 groups held two judged
 * documents, 9 gold documents were absent from the indexed corpus and 8 topics
 * lost `recall@100` outright. So every judged document keeps a copy; the group's
 * UNJUDGED mirrors are still refused, because nothing credits them.
 */
const survivorsOf = (
  group: readonly PlannedAtom[],
  gold: ReadonlySet<string>
): readonly string[] => {
  const judged = judgedSurvivors(group, gold);
  const kept = judged.length >= DOUBLE_GOLD_DOCUMENTS ? judged : group.slice(0, 1);
  return kept.map(entry => entry.atom.frontmatter.id);
};

/** body hash → the members of that group, in preference order. Unhashed atoms form no group. */
const groupedByBody = (
  planned: readonly PlannedAtom[],
  gold: ReadonlySet<string>
): ReadonlyMap<string, readonly PlannedAtom[]> =>
  [...planned]
    .sort(byPreference(gold))
    .reduce((groups, entry) => {
      const key = bodyKey(entry);
      return key === undefined ? groups : groups.set(key, [...(groups.get(key) ?? []), entry]);
    }, new Map<string, readonly PlannedAtom[]>());

/** body hash → the ids that survive the group, most preferred first. */
const keptByBody = (
  planned: readonly PlannedAtom[],
  gold: ReadonlySet<string>
): ReadonlyMap<string, readonly string[]> =>
  new Map(
    [...groupedByBody(planned, gold)].map(([key, group]) => [key, survivorsOf(group, gold)])
  );

/** The ids that survived this atom's group; empty when it belongs to no group. */
const survivorsFor = (
  planned: PlannedAtom,
  keptByBody: ReadonlyMap<string, readonly string[]>
): readonly string[] => {
  const key = bodyKey(planned);
  return key === undefined ? [] : (keptByBody.get(key) ?? []);
};

const duplicateReasons = (
  planned: PlannedAtom,
  keptByBody: ReadonlyMap<string, readonly string[]>
): readonly string[] => {
  const kept = survivorsFor(planned, keptByBody);
  const [primary] = kept;
  return primary === undefined || kept.includes(planned.atom.frontmatter.id)
    ? []
    : [`${DUPLICATE_REASON_PREFIX}${primary}`];
};

/**
 * The paths the group's PRIMARY survivor inherits — every member the duplicate
 * rule refused, in the group's own preference order.
 *
 * The primary is the atom `duplicateReasons` already names in
 * `duplicate-body-of:<primary>`, so the two read one decision. A NON-primary
 * survivor — the double-gold case — inherits nothing: its own document is
 * credited in its own right, and claiming the group's other documents would
 * make two atoms answer for one source.
 */
const inheritedByPrimary = (
  group: readonly PlannedAtom[],
  gold: ReadonlySet<string>
): readonly (readonly [string, readonly string[]])[] => {
  const survivors = survivorsOf(group, gold);
  const [primary] = survivors;
  const kept = new Set(survivors);
  const dropped = group.filter(entry => !kept.has(entry.atom.frontmatter.id));
  return primary === undefined || dropped.length === 0
    ? []
    : [[primary, dropped.map(entry => entry.candidate.sourcePath)]];
};

/** atom id → the dropped mirrors' source paths it now speaks for. Groups are already ordered. */
const inheritedSources = (
  planned: readonly PlannedAtom[],
  gold: ReadonlySet<string>
): ReadonlyMap<string, readonly string[]> =>
  new Map([...groupedByBody(planned, gold)].flatMap(([, group]) => inheritedByPrimary(group, gold)));

/** Own path first, then the inherited ones, deduped — a source is named ONCE. */
const withInherited = (entry: CheckedAtom, inherited: readonly string[]): CheckedAtom => ({
  ...entry,
  atom: {
    ...entry.atom,
    frontmatter: {
      ...entry.atom.frontmatter,
      sources: [...new Set([...entry.atom.frontmatter.sources, ...inherited])],
    },
  },
});

/**
 * PROVENANCE MERGE — a second pass over the write set, in the shape
 * `withDenseOrigin` established. Exact-body dedupe is right for the product: two
 * copies of one body would spend two pool slots on identical text. What it must
 * NOT do is lose the dropped document, which is the only record that the text
 * lives there too. So the atom that survives names every source it represents.
 */
const withMergedSources = (
  writable: readonly CheckedAtom[],
  inherited: ReadonlyMap<string, readonly string[]>
): readonly CheckedAtom[] =>
  writable.map(entry => withInherited(entry, inherited.get(entry.atom.frontmatter.id) ?? []));

/** The duplicate share of a refusal set — a subset of it, never its total. */
const countDuplicates = (refused: readonly CheckedAtom[]): number =>
  refused.filter(entry => entry.reasons.some(reason => reason.startsWith(DUPLICATE_REASON_PREFIX)))
    .length;

/** The run's policy inputs for the checks: the labelling vocabulary, and what gold judges. */
interface CheckContext {
  readonly profile: IngestProfile;
  readonly gold: ReadonlySet<string>;
}

const checkAtoms = (
  planned: readonly PlannedAtom[],
  existing: ReadonlySet<string>,
  context: CheckContext
): readonly CheckedAtom[] => {
  const reserved = foreignIds(existing, new Set(planned.map(entry => entry.atom.frontmatter.id)));
  const kept = keptByBody(planned, context.gold);
  return planned.map(entry => ({
    ...entry,
    reasons: [
      ...validateAtom(entry.atom, reserved, context.profile),
      ...emptyBodyReasons(entry),
      ...duplicateReasons(entry, kept),
    ],
  }));
};

/**
 * Ingest local markdown into atom files. Refusals are reported, never thrown
 * and never silently defaulted; the write set is always fully valid.
 */
const profileOf = (options: IngestOptions): IngestProfile => options.profile ?? activeProfile();

/** Absent gold is an EMPTY set, which leaves the dedupe exactly as it was before the field. */
const goldOf = (options: IngestOptions): ReadonlySet<string> => new Set(options.goldIds ?? []);

/** Sources no declared root claims — reported, never written. */
const unmappedSkips = (
  loaded: readonly LoadedSource[],
  profile: IngestProfile
): readonly IngestSkip[] =>
  loaded.filter(source => source.domain === undefined).map(source => unmappedSkip(source, profile));

/**
 * DENSE ORIGIN NUMBERING — a SECOND PASS, over the atoms that survived.
 *
 * `toAtom` numbers a candidate by its chunk position, which is what the chunker
 * knows; by the time the write set is fixed, dedupe, the empty-body drop and
 * validation have removed some of those chunks. Measured on a two-document
 * fixture: `beta.md` kept ONE atom and still declared `origin_count: 2`, so a
 * consumer rendering "1 of 2" sent a reader after an atom in no corpus. A count
 * that overstates is worse than no count — it reads as INCOMPLETE evidence.
 *
 * So both fields are re-derived here against the write set: `origin_count` is
 * how many atoms the source document actually WROTE, and `origin_index` their
 * dense `0 .. count-1` position in source order (`byOrder`, preserved through
 * planning and checking). The field therefore no longer names WHICH chunk of the
 * source file an atom came from — accepted, deliberately: ordering and grouping
 * the atoms a caller HOLDS is the job it exists for.
 *
 * Skips cannot be predicted during candidate build — dedupe is cross-document
 * and decides a group only once every member is known — which is why this is a
 * pass and not a field on `Candidate`.
 */
const sourceOf = (entry: CheckedAtom): string => entry.candidate.sourcePath;

const countsBySource = (writable: readonly CheckedAtom[]): ReadonlyMap<string, number> =>
  writable.reduce(
    (counts, entry) => counts.set(sourceOf(entry), (counts.get(sourceOf(entry)) ?? 0) + 1),
    new Map<string, number>()
  );

/** The running per-document ordinal of each entry, in the write set's own order. */
const denseIndices = (writable: readonly CheckedAtom[]): readonly number[] => {
  const seen = new Map<string, number>();
  return writable.map(entry => {
    const next = seen.get(sourceOf(entry)) ?? 0;
    seen.set(sourceOf(entry), next + 1);
    return next;
  });
};

const renumbered = (entry: CheckedAtom, originIndex: number, originCount: number): CheckedAtom => ({
  ...entry,
  atom: {
    ...entry.atom,
    frontmatter: { ...entry.atom.frontmatter, origin_index: originIndex, origin_count: originCount },
  },
});

const withDenseOrigin = (writable: readonly CheckedAtom[]): readonly CheckedAtom[] => {
  const counts = countsBySource(writable);
  const indices = denseIndices(writable);
  return writable.map((entry, position) =>
    renumbered(entry, indices[position] ?? 0, counts.get(sourceOf(entry)) ?? 0)
  );
};

/** The atoms this run writes: the valid ones, origin-renumbered, provenance-merged. */
const writeSet = (
  checked: readonly CheckedAtom[],
  planned: readonly PlannedAtom[],
  gold: ReadonlySet<string>
): readonly CheckedAtom[] =>
  withMergedSources(
    withDenseOrigin(checked.filter(entry => entry.reasons.length === 0)),
    inheritedSources(planned, gold)
  );

/** Everything the run puts on disk: the atoms, the owner marker, the manifest. */
interface WritePhase {
  readonly outputDir: string;
  readonly profile: IngestProfile;
  readonly writable: readonly CheckedAtom[];
  /** Every source this run READ — the manifest's corpus→atoms half, already in hand. */
  readonly sources: readonly LoadedSource[];
  readonly skipped: number;
  readonly duplicates: number;
}

const persist = async (phase: WritePhase): Promise<number> => {
  await mkdir(phase.outputDir, { recursive: true });
  await claimOutputDir(phase.outputDir, phase.profile);
  await Promise.all(phase.writable.map(entry => writeAtom(phase.outputDir, entry)));
  const pruned = await pruneOrphans(phase.outputDir, phase.writable);
  await writeManifest(phase.outputDir, {
    profile: phase.profile.name,
    atoms: phase.writable.map(manifestAtom),
    sources: phase.sources,
    skipped: phase.skipped,
    duplicates: phase.duplicates,
  });
  return pruned;
};

/** The sidecar the profile names, read ONCE per run and resolved against the effective repo root. */
const profileSummaries = (
  repoRoot: string,
  profile: IngestProfile
): ReadonlyMap<string, string> =>
  profile.summarySidecar === undefined
    ? new Map()
    : loadSummarySidecar(join(repoRoot, profile.summarySidecar));

export const ingest = async (options: IngestOptions): Promise<IngestSummary> => {
  const outputDir = options.outputDir ?? atomsDir();
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profile = profileOf(options);
  const loaded = await loadCorpus(repoRoot, options.corpusRoots ?? resolveCorpusRoots(), profile);
  const unmapped = unmappedSkips(loaded, profile);
  const summaries = profileSummaries(repoRoot, profile);
  const candidates = [...loaded.flatMap(source => toCandidates(source, profile, summaries))].sort(byOrder);
  const planned = planAtoms(candidates);
  const gold = goldOf(options);
  const checked = checkAtoms(planned, await readExistingIds(outputDir), { profile, gold });
  const writable = writeSet(checked, planned, gold);
  const refused = checked.filter(entry => entry.reasons.length > 0);
  const skipped = [...unmapped, ...refused.map(toSkip)];
  const duplicates = countDuplicates(refused);
  const pruned = await persist({
    outputDir,
    profile,
    writable,
    sources: loaded,
    skipped: skipped.length,
    duplicates,
  });
  return { written: writable.length, skipped, pruned, duplicates };
};
