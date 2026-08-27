import { readdir } from 'node:fs/promises';

import { type Atom, parseAtom, serializeAtom } from './atom.js';
import { ATOM_FENCE_MAX_CHARS, bodyMaxChars } from './config.js';
import type { IngestProfile } from './ingestProfile.js';
import { atomsDir } from './paths.js';
import { activeProfile } from './vocabulary.js';

/**
 * WRITE-TIME refusal. This module decides what may be WRITTEN into the atom
 * tree; `retrievability.ts` decides, separately, what may be RETURNED from it.
 * Keeping the two apart means loosening a retrieval rule can never widen what
 * lands on disk, and vice versa.
 *
 * `validateAtom` is pure over already-parsed data plus the set of ids already
 * on disk — no filesystem access — so every rule is testable without a vault.
 * `readExistingIds` is the thin, separate disk helper that supplies that set.
 */

const MD_SUFFIX = '.md';

/**
 * Filesystem-safe slug: lowercase alphanumeric segments joined by single
 * hyphens. The atom's file path is DERIVED from the id (`<ATOMS_DIR>/<id>.md`),
 * so a `/`, a `..`, or a space in the id is a path-traversal write, not a
 * cosmetic problem. Uppercase is refused too: on a case-insensitive filesystem
 * `Foo` and `foo` collide into one file while reading as two distinct ids.
 */
const ID_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isDefined = (value: string | undefined): value is string => value !== undefined;

const idFormatError = (id: string): string | undefined =>
  ID_SLUG_RE.test(id)
    ? undefined
    : `field "id" is not a filesystem-safe slug: "${id}" — rewrite it as lowercase letters, digits and single hyphens only (no "/", "..", spaces or uppercase), e.g. "runner-gate-contract"`;

/**
 * An id is UNIQUE and IMMUTABLE once written: five subsystems key on it —
 * ranking tie-break, telemetry, the golden relevance set, the rendered citation
 * block and the conformance suite. A duplicate (or a rename, which presents as
 * a write under a fresh id plus a dangling reference) corrupts all of them.
 */
const idUniquenessError = (id: string, existingIds: ReadonlySet<string>): string | undefined =>
  existingIds.has(id)
    ? `atom id "${id}" already exists — choose a different, unused id; an id is immutable once written and MUST NOT be reused or renamed`
    : undefined;

/**
 * Retrieval injects top-k 3–5 atoms into a 2–3k token budget, so one oversized
 * atom would consume the entire budget on its own. Which cap applies — the
 * standard one or the fenced-block ceiling — is decided by `bodyMaxChars` in
 * `config.ts`, and neither number is restated here.
 *
 * The message names the applied cap AND why it applied: the two limits differ
 * by a factor of two, so "over the cap" alone leaves the author unable to tell
 * a body that is too long from one that lost its escape hatch.
 */
const capBasis = (limit: number): string =>
  limit === ATOM_FENCE_MAX_CHARS
    ? 'its body opens a markdown fence, so the fenced-block ceiling applies'
    : 'its body opens no markdown fence, so the standard cap applies';

const sizeError = (body: string, maxChars: number | undefined): string | undefined => {
  const limit = bodyMaxChars(body, maxChars);
  return body.length <= limit
    ? undefined
    : `atom body is ${body.length} characters, over the ${limit}-character cap (${capBasis(limit)}) — split it into several smaller atoms, each within the cap`;
};

/**
 * A free-form domain fragments on typos and makes the atom silently invisible
 * to every domain-filtered query, so the vocabulary is closed.
 */
const domainError = (domain: string, vocabulary: readonly string[]): string | undefined =>
  vocabulary.some(known => known === domain)
    ? undefined
    : `field "x_domain" is "${domain}", outside the closed vocabulary — replace it with one of ${vocabulary.join(' | ')}`;

/**
 * The same argument as `domainError`, on the other axis: a free-form type makes
 * the atom silently invisible to every type-filtered query, so the vocabulary is
 * closed and a typo is refused at the write rather than discovered at retrieval.
 */
const typeError = (type: string, vocabulary: readonly string[]): string | undefined =>
  vocabulary.some(known => known === type)
    ? undefined
    : `field "type" is "${type}", outside the closed vocabulary — replace it with one of ${vocabulary.join(' | ')}`;

/**
 * The round trip is only guaranteed in the READ direction: `serializeAtom` will
 * happily emit a line the parser then refuses — an empty required scalar emits
 * `"title: "`, which `SCALAR_LINE_RE` rejects, and one bad line makes the WHOLE
 * file unparseable, so every consumer silently skips the atom. Measured: 144 of
 * 529 atoms in one corpus were written unreadable this way. Asking the parser
 * rather than re-checking five fields by hand means this rule cannot drift away
 * from what the parser actually accepts.
 */
const roundTripError = (atom: Atom): string | undefined => {
  const result = parseAtom(serializeAtom(atom.frontmatter, atom.body));
  return result.ok
    ? undefined
    : `atom "${atom.frontmatter.id}" serializes to a file its own parser refuses (${result.error}) — one bad line makes the whole atom unreadable and every consumer skips it, so give each frontmatter field a non-empty, single-line value`;
};

/**
 * Every reason the atom MUST NOT be written, each naming the correction its
 * author has to make. An empty list means the write is allowed.
 */
export const validateAtom = (
  atom: Atom,
  existingIds: ReadonlySet<string>,
  profile: IngestProfile = activeProfile()
): readonly string[] =>
  [
    idFormatError(atom.frontmatter.id),
    idUniquenessError(atom.frontmatter.id, existingIds),
    sizeError(atom.body, profile.atomMaxChars),
    domainError(atom.frontmatter.x_domain, profile.domains),
    typeError(atom.frontmatter.type, profile.types),
    roundTripError(atom),
  ].filter(isDefined);

const toId = (filename: string): string => filename.slice(0, -MD_SUFFIX.length);

/**
 * The ids already on disk, derived from filenames alone — the path IS the id,
 * so no file needs to be opened. An absent directory is an empty tree (a fresh
 * vault), not an error.
 */
export const readExistingIds = async (dir: string = atomsDir()): Promise<ReadonlySet<string>> => {
  const names = await readdir(dir).catch((): readonly string[] => []);
  return new Set(names.filter(name => name.endsWith(MD_SUFFIX)).map(toId));
};
