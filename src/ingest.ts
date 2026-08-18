import { createHash } from 'node:crypto';
import { globSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { Atom } from './atom.js';
import { serializeAtom } from './atom.js';
import type { MarkdownChunk } from './chunker.js';
import { chunkMarkdown, frontMatterTitle, headingLine, headingPath } from './chunker.js';
import { bodyMaxChars, CORPUS_ROOTS_ENV_VAR, DEFAULT_INGEST_PROFILE, resolveCorpusRoots } from './config.js';
import type { CorpusManifestInput, ManifestAtom } from './corpusManifest.js';
import { buildCorpusManifest, CORPUS_MANIFEST_FILE, serializeCorpusManifest } from './corpusManifest.js';
import type { IngestProfile } from './ingestProfile.js';
import { domainForPath, typeForPath } from './ingestProfile.js';
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

interface LoadedSource {
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

/**
 * PATH EXCLUSION — a source under a declared `excludePaths` prefix is dropped
 * BEFORE it is read, so it is never chunked, never validated and never counted.
 * That placement is the rule, not an optimisation: a generated tree is not a
 * document that failed a check, so surfacing it in `skipped[]` would drown the
 * refusals a reader has to act on under 22 597 entries nothing can be done
 * about. Same prefix semantics as `domainRules` — a repo-relative,
 * forward-slash `startsWith` match.
 */
const isExcluded = (profile: IngestProfile, sourcePath: string): boolean =>
  (profile.excludePaths ?? []).some(prefix => sourcePath.startsWith(prefix));

const loadSource = async (
  absolutePath: string,
  repoRoot: string,
  profile: IngestProfile
): Promise<LoadedSource> => {
  const sourcePath = toPosix(relative(repoRoot, absolutePath));
  return {
    sourcePath,
    text: await readFile(absolutePath, 'utf8'),
    domain: domainForPath(profile, sourcePath),
  };
};

/** Every in-scope source of the run, read once, in sorted path order. */
const loadCorpus = async (
  repoRoot: string,
  corpusRoots: readonly string[],
  profile: IngestProfile
): Promise<readonly LoadedSource[]> => {
  const files = await expandCorpus(repoRoot, corpusRoots);
  const kept = [...files].sort().filter(file => !isExcluded(profile, toPosix(relative(repoRoot, file))));
  return await Promise.all(kept.map(file => loadSource(file, repoRoot, profile)));
};

const unmappedSkip = (source: LoadedSource, profile: IngestProfile): IngestSkip => ({
  source: source.sourcePath,
  title: basename(source.sourcePath),
  reasons: [
    `source "${source.sourcePath}" is outside every declared ingest root — move it under one of ${profile.domainRules.map(rule => rule.prefix).join(' | ')}, or declare its root in the "domainRules" table of the ingest profile (profiles/default.profile.json); ingest MUST NOT guess a domain`,
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

const toCandidates = (source: LoadedSource, profile: IngestProfile): readonly Candidate[] => {
  const domain = source.domain;
  if (domain === undefined) return [];
  const chunks = chunkMarkdown(source.text, profile.atomMaxChars);
  const docTitle = documentTitle(source, chunks);
  const summary = documentSummary(source.text);
  return chunks.map((chunk, index) => ({
    sourcePath: source.sourcePath,
    index,
    chunk,
    domain,
    type: typeForPath(profile, source.sourcePath),
    docTitle,
    summary,
    part: partSuffix(chunks, chunk, index),
    maxChars: profile.atomMaxChars,
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
  return prefixed.length <= bodyMaxChars(prefixed, candidate.maxChars)
    ? prefixed
    : composeBody([], body);
};

const toAtom = (candidate: Candidate, id: string, title: string): Atom => ({
  frontmatter: {
    type: candidate.type,
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
 * re-anchors nothing. One directory up (`dp-gnosis/vault/corpus-manifest.json`
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
 * is met in the bench projection (`tools/dp-gnosis-bench/src/corpus.ts`), so a
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
 * body hash → the id of the FIRST atom carrying it. `planned` arrives sorted by
 * source path, and a `Map` built from a list keeps the LAST write per key, so
 * the pairs are reversed to make the first one win — which is what keeps the
 * kept copy stable across runs.
 */
const firstByBody = (planned: readonly PlannedAtom[]): ReadonlyMap<string, string> => {
  const pairs = planned.flatMap((entry): readonly (readonly [string, string])[] => {
    const key = bodyKey(entry);
    return key === undefined ? [] : [[key, entry.atom.frontmatter.id]];
  });
  return new Map([...pairs].reverse());
};

const duplicateReasons = (
  planned: PlannedAtom,
  keptByBody: ReadonlyMap<string, string>
): readonly string[] => {
  const key = bodyKey(planned);
  const kept = key === undefined ? undefined : keptByBody.get(key);
  return kept === undefined || kept === planned.atom.frontmatter.id
    ? []
    : [`${DUPLICATE_REASON_PREFIX}${kept}`];
};

/** The duplicate share of a refusal set — a subset of it, never its total. */
const countDuplicates = (refused: readonly CheckedAtom[]): number =>
  refused.filter(entry => entry.reasons.some(reason => reason.startsWith(DUPLICATE_REASON_PREFIX)))
    .length;

const checkAtoms = (
  planned: readonly PlannedAtom[],
  existing: ReadonlySet<string>,
  profile: IngestProfile
): readonly CheckedAtom[] => {
  const reserved = foreignIds(existing, new Set(planned.map(entry => entry.atom.frontmatter.id)));
  const keptByBody = firstByBody(planned);
  return planned.map(entry => ({
    ...entry,
    reasons: [
      ...validateAtom(entry.atom, reserved, profile),
      ...emptyBodyReasons(entry),
      ...duplicateReasons(entry, keptByBody),
    ],
  }));
};

/**
 * Ingest local markdown into atom files. Refusals are reported, never thrown
 * and never silently defaulted; the write set is always fully valid.
 */
const profileOf = (options: IngestOptions): IngestProfile => options.profile ?? DEFAULT_INGEST_PROFILE;

/** Everything the run puts on disk: the atoms, the owner marker, the manifest. */
interface WritePhase {
  readonly outputDir: string;
  readonly profile: IngestProfile;
  readonly writable: readonly CheckedAtom[];
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
    skipped: phase.skipped,
    duplicates: phase.duplicates,
  });
  return pruned;
};

export const ingest = async (options: IngestOptions): Promise<IngestSummary> => {
  const outputDir = options.outputDir ?? ATOMS_DIR;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profile = profileOf(options);
  const loaded = await loadCorpus(repoRoot, options.corpusRoots ?? resolveCorpusRoots(), profile);
  const unmapped = loaded
    .filter(source => source.domain === undefined)
    .map(source => unmappedSkip(source, profile));
  const candidates = [...loaded.flatMap(source => toCandidates(source, profile))].sort(byOrder);
  const checked = checkAtoms(planAtoms(candidates), await readExistingIds(outputDir), profile);
  const writable = checked.filter(entry => entry.reasons.length === 0);
  const refused = checked.filter(entry => entry.reasons.length > 0);
  const skipped = [...unmapped, ...refused.map(toSkip)];
  const duplicates = countDuplicates(refused);
  const pruned = await persist({ outputDir, profile, writable, skipped: skipped.length, duplicates });
  return { written: writable.length, skipped, pruned, duplicates };
};
