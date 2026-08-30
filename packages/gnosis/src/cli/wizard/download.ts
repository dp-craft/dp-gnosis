/**
 * The Hugging Face fetch behind the wizard's "download a GGUF" rung — resumable,
 * and VERIFIED before the file is allowed to exist under its real name.
 *
 * The verification is the point of the module, not a nicety. A truncated or
 * corrupted reranker GGUF does not fail loudly: `llama-server` loads it or the
 * rank head comes up wrong, the endpoint answers HTTP 200, and the scores parse
 * as floats — the same shape as the missing-`cls.output.weight` failure
 * `packages/gnosis/OPTIONAL.md` § Which GGUF documents, and
 * `handbook/GNOSIS-RULES.md` § The failure class verbatim: a component produced
 * nothing and the pipeline recorded it as data. So a size or digest mismatch
 * DELETES the file and refuses by name; a multi-gigabyte re-download is cheap
 * next to a campaign measured against garbage.
 *
 * Three consequences of that stance are load-bearing:
 *
 * - The bytes land in `<destination>.part` and are renamed only after they
 *   verify, so an interrupted run can never be mistaken for a model.
 * - A `Range` request the server IGNORES (200 where 206 was asked for) restarts
 *   the file from zero. Appending a full body to a partial one produces a file
 *   of plausible size and wrong content — exactly the failure above.
 * - The digest comes from the API tree listing (`lfs.oid` IS the sha256), which
 *   is why `hfGgufFiles` reads it there: the `resolve` endpoint alone can only
 *   tell you how many bytes arrived, not whether they were the right ones. When
 *   a repo serves a non-LFS file with no oid, `sha256` is `undefined` and the
 *   size check stands alone — an honest weaker guarantee, not a silent one.
 *
 * The body is consumed as the async iterable a `fetch` response body already
 * is — `Readable.fromWeb` needs the `node:stream/web` type, which the global
 * `Response.body` is not, and buying that with a cast would trade a checked
 * conversion for an unchecked one.
 *
 * The API response is untrusted JSON and is read through type guards; a cast
 * would let a shape change arrive as a runtime surprise mid-download.
 *
 * `HF_TOKEN` is honoured when set (gated repos), and `HF_ENDPOINT` overrides the
 * host — the same variable `huggingface_hub` uses for mirrors, and the seam the
 * test suite points at its own fixture server.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { readFreeDisk } from './hardware.js';

const HF_DEFAULT_ENDPOINT = 'https://huggingface.co';

const hfEndpoint = (): string => process.env['HF_ENDPOINT'] ?? HF_DEFAULT_ENDPOINT;

const authHeaders = (): Record<string, string> => {
  const token = process.env['HF_TOKEN'];
  return token === undefined || token.length === 0 ? {} : { Authorization: `Bearer ${token}` };
};

/** One file in a repo, with everything needed to verify it once it has landed. */
export interface RemoteFile {
  readonly repo: string;
  readonly file: string;
  readonly sizeBytes: number;
  readonly sha256: string | undefined;
}

export type DownloadOutcome =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly error: string };

type Check = { readonly ok: true } | { readonly ok: false; readonly error: string };

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringAt = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const numberAt = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
};

const recordAt = (record: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

interface TreeEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string | undefined;
}

/** `lfs.size` is the true size of a pointer file; plain `size` is the pointer's. */
const entrySize = (entry: Record<string, unknown>, lfs: Record<string, unknown> | undefined): number | undefined =>
  (lfs === undefined ? undefined : numberAt(lfs, 'size')) ?? numberAt(entry, 'size');

const toEntry = (value: unknown): TreeEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const path = stringAt(value, 'path');
  const lfs = recordAt(value, 'lfs');
  const size = entrySize(value, lfs);
  if (path === undefined || size === undefined) return undefined;
  return { path, size, sha256: lfs === undefined ? undefined : stringAt(lfs, 'oid') };
};

type Fetched = { readonly ok: true; readonly response: Response } | { readonly ok: false; readonly error: string };

const tryFetch = async (url: string, headers: Record<string, string>): Promise<Fetched> => {
  try {
    return { ok: true, response: await fetch(url, { headers }) };
  } catch (error: unknown) {
    return { ok: false, error: `request to ${url} failed: ${describeError(error)}` };
  }
};

const tryJson = async (response: Response): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }> => {
  try {
    const value: unknown = await response.json();
    return { ok: true, value };
  } catch (error: unknown) {
    return { ok: false, error: `the tree listing was not JSON: ${describeError(error)}` };
  }
};

const treeOf = async (repo: string): Promise<{ readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly error: string }> => {
  const url = `${hfEndpoint()}/api/models/${repo}/tree/main`;
  const got = await tryFetch(url, authHeaders());
  if (!got.ok) return got;
  if (!got.response.ok) return { ok: false, error: `${url} answered HTTP ${String(got.response.status)}` };
  const parsed = await tryJson(got.response);
  if (!parsed.ok) return parsed;
  return Array.isArray(parsed.value)
    ? { ok: true, items: parsed.value }
    : { ok: false, error: `the tree listing for ${repo} was not a JSON array` };
};

/** The `.gguf` suffix a served weight file carries. */
const GGUF = '.gguf';

/**
 * Every GGUF the repository publishes, with its size and digest.
 *
 * The wizard needs this because a MODEL is chosen by quantisation LABEL while a
 * download needs a FILE NAME, and the two are related only by the naming a
 * repository happens to use. Listing is what keeps that name out of the
 * catalogue: a file name written from memory is the volatile fact
 * `GNOSIS-RULES.md` forbids restating, and it fails as a 404 at the end of a
 * multi-gigabyte question.
 */
export const hfGgufFiles = async (repo: string): Promise<{ readonly ok: true; readonly files: readonly RemoteFile[] } | { readonly ok: false; readonly error: string }> => {
  const tree = await treeOf(repo);
  if (!tree.ok) return tree;
  const files = tree.items
    .map(toEntry)
    .filter((entry): entry is TreeEntry => entry !== undefined && entry.path.toLowerCase().endsWith(GGUF))
    .map(entry => ({ repo, file: entry.path, sizeBytes: entry.size, sha256: entry.sha256 }));
  return files.length === 0 ? { ok: false, error: `${repo} publishes no .gguf file` } : { ok: true, files };
};

/**
 * The disk this file cannot fit on, named with both numbers.
 *
 * A multi-gigabyte fetch that runs the filesystem out mid-stream ends as a
 * short `.part`, and the size check then reports it as a "size mismatch" — a
 * true statement about the wrong cause, after the whole download has been paid
 * for. Free space is knowable BEFORE the first byte, so it is read there. No
 * margin is applied: the file's own size is the fact, and a number the caller
 * cannot check would be a guess dressed as one.
 *
 * `undefined` free space is "not knowable here" (`hardware.ts`), never zero, so
 * it does not refuse — an unreadable `statfs` MUST NOT block a download that
 * would have worked.
 */
const diskCheck = async (source: RemoteFile, destination: string): Promise<Check> => {
  const free = await readFreeDisk(dirname(destination));
  if (free === undefined || free >= source.sizeBytes) return { ok: true };
  return {
    ok: false,
    error: `${source.file}: not enough free disk — it needs ${source.sizeBytes} bytes and ${dirname(destination)} has ${free} free`,
  };
};

const sizeOf = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
};

const fileDigest = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

/** The gate: right byte count, and — when an oid was published — right bytes. */
const verifyFile = async (path: string, source: RemoteFile): Promise<Check> => {
  const size = await sizeOf(path);
  if (size !== source.sizeBytes) {
    return { ok: false, error: `${source.file}: size mismatch — expected ${source.sizeBytes} bytes, got ${size}` };
  }
  if (source.sha256 === undefined) return { ok: true };
  const digest = await fileDigest(path);
  return digest === source.sha256
    ? { ok: true }
    : { ok: false, error: `${source.file}: sha256 mismatch — expected ${source.sha256}, got ${digest}` };
};

type Opened =
  | { readonly ok: true; readonly body: AsyncIterable<Uint8Array>; readonly offset: number }
  | { readonly ok: false; readonly error: string };

const rangeHeaders = (offset: number): Record<string, string> =>
  offset > 0 ? { ...authHeaders(), Range: `bytes=${offset}-` } : authHeaders();

const PARTIAL_CONTENT = 206;

/** Asks for the missing tail; a server that answers 200 gets restarted from zero. */
const openBody = async (source: RemoteFile, part: string): Promise<Opened> => {
  const offset = await sizeOf(part);
  const url = `${hfEndpoint()}/${source.repo}/resolve/main/${source.file}`;
  const got = await tryFetch(url, rangeHeaders(offset));
  if (!got.ok) return got;
  const { status, ok, body } = got.response;
  if (!ok || body === null) return { ok: false, error: `${url} answered HTTP ${status}` };
  return { ok: true, body, offset: status === PARTIAL_CONTENT ? offset : 0 };
};

const streamToPart = async (
  opened: { readonly body: AsyncIterable<Uint8Array>; readonly offset: number },
  part: string,
  report: (received: number) => void
): Promise<Check> => {
  const sink = createWriteStream(part, { flags: opened.offset > 0 ? 'a' : 'w' });
  const source = Readable.from(opened.body, { objectMode: false });
  source.on('data', () => report(opened.offset + sink.bytesWritten));
  try {
    await pipeline(source, sink);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: `download stream failed: ${describeError(error)}` };
  }
};

const discard = async (path: string): Promise<void> => rm(path, { force: true });

const promote = async (source: RemoteFile, part: string, destination: string): Promise<DownloadOutcome> => {
  const verdict = await verifyFile(part, source);
  if (!verdict.ok) {
    await discard(part);
    return verdict;
  }
  await rename(part, destination);
  return { ok: true, path: destination, bytes: source.sizeBytes };
};

/**
 * Resumes, verifies, and only then lets the file exist under `destination`.
 * `onProgress` is called with the running byte count and the expected total.
 */
export const downloadFile = async (
  source: RemoteFile,
  destination: string,
  onProgress: (received: number, total: number) => void
): Promise<DownloadOutcome> => {
  if ((await verifyFile(destination, source)).ok) {
    return { ok: true, path: destination, bytes: source.sizeBytes };
  }
  const space = await diskCheck(source, destination);
  if (!space.ok) return space;
  const part = `${destination}.part`;
  const opened = await openBody(source, part);
  if (!opened.ok) return opened;
  const streamed = await streamToPart(opened, part, received => onProgress(received, source.sizeBytes));
  if (!streamed.ok) return streamed;
  return promote(source, part, destination);
};
