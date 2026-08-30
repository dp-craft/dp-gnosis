import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadFile, type RemoteFile } from '../src/cli/wizard/download.js';

// A real fixture server on an ephemeral port, not a mocked `fetch`: resume is a
// property of the HTTP conversation (the Range header, the 206-vs-200 answer),
// and a mock would assert the code's own assumptions back at it.

const REPO = 'acme/models';
const FILE = 'model.gguf';
const PAYLOAD = randomBytes(8_000);
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

const state = {
  honourRange: true,
  lastRange: undefined as string | undefined,
  resolveHits: 0,
  treeBody: undefined as string | undefined,
};

const serveTree = (res: ServerResponse): void => {
  const body =
    state.treeBody ??
    JSON.stringify([
      'not-an-object',
      { path: 'README.md', size: 12 },
      { path: FILE, size: 135, lfs: { size: PAYLOAD.length, oid: SHA } },
    ]);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
};

const serveBytes = (req: IncomingMessage, res: ServerResponse): void => {
  state.resolveHits += 1;
  const range = req.headers.range;
  state.lastRange = range;
  const from = Number(/^bytes=(\d+)-/u.exec(range ?? '')?.[1] ?? '0');
  if (!state.honourRange || range === undefined || from === 0) {
    res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
    res.end(PAYLOAD);
    return;
  }
  const slice = PAYLOAD.subarray(from);
  res.writeHead(206, {
    'content-length': String(slice.length),
    'content-range': `bytes ${from}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
  });
  res.end(slice);
};

let server: Server;
let dir: string;

const dest = (): string => join(dir, FILE);
const noop = (): void => {};

const remote = (over: Partial<RemoteFile> = {}): RemoteFile => ({
  repo: REPO,
  file: FILE,
  sizeBytes: PAYLOAD.length,
  sha256: SHA,
  ...over,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.endsWith('/tree/main')) return serveTree(res);
    if (url.endsWith(`/resolve/main/${FILE}`)) return serveBytes(req, res);
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env['HF_ENDPOINT'] = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env['HF_ENDPOINT'];
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gnosis-wizard-dl-'));
  state.honourRange = true;
  state.lastRange = undefined;
  state.resolveHits = 0;
  state.treeBody = undefined;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('downloadFile', () => {
  it('downloads, verifies and renames into place', async () => {
    const seen: number[] = [];
    const result = await downloadFile(remote(), dest(), received => seen.push(received));

    expect(result).toEqual({ ok: true, path: dest(), bytes: PAYLOAD.length });
    expect(readFileSync(dest()).equals(PAYLOAD)).toBe(true);
    expect(existsSync(`${dest()}.part`)).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('resumes a partial file with a Range request', async () => {
    writeFileSync(`${dest()}.part`, PAYLOAD.subarray(0, 1_000));

    const result = await downloadFile(remote(), dest(), noop);

    expect(state.lastRange).toBe('bytes=1000-');
    expect(result.ok).toBe(true);
    expect(readFileSync(dest()).equals(PAYLOAD)).toBe(true);
  });

  it('restarts from zero when the server ignores the Range and answers 200', async () => {
    state.honourRange = false;
    writeFileSync(`${dest()}.part`, PAYLOAD.subarray(0, 1_000));

    const result = await downloadFile(remote(), dest(), noop);

    expect(result.ok).toBe(true);
    expect(readFileSync(dest()).length).toBe(PAYLOAD.length);
    expect(readFileSync(dest()).equals(PAYLOAD)).toBe(true);
  });

  it('deletes the file and refuses when the digest does not match', async () => {
    const result = await downloadFile(remote({ sha256: 'f'.repeat(64) }), dest(), noop);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('sha256 mismatch');
    expect(existsSync(dest())).toBe(false);
    expect(existsSync(`${dest()}.part`)).toBe(false);
  });

  it('refuses when the byte count does not match', async () => {
    const result = await downloadFile(remote({ sizeBytes: PAYLOAD.length + 10, sha256: undefined }), dest(), noop);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('size mismatch');
    expect(existsSync(dest())).toBe(false);
  });

  // Given a file larger than any disk, When it is downloaded, Then the refusal
  // arrives BEFORE the first byte: a fetch that fills the filesystem ends as a
  // short `.part` and reports "size mismatch", which is a true statement about
  // the wrong cause after the whole transfer has been paid for.
  it('should refuse before the first byte when free disk is below the file size, naming both numbers', async () => {
    const impossible = Number.MAX_SAFE_INTEGER;

    const result = await downloadFile(remote({ sizeBytes: impossible, sha256: undefined }), dest(), noop);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not enough free disk');
      expect(result.error).toContain(String(impossible));
      expect(result.error).toMatch(/has \d+ free/u);
    }
    expect(state.resolveHits).toBe(0);
    expect(existsSync(`${dest()}.part`)).toBe(false);
  });

  it('does not re-download a destination that already verifies', async () => {
    writeFileSync(dest(), PAYLOAD);

    const result = await downloadFile(remote(), dest(), noop);

    expect(result).toEqual({ ok: true, path: dest(), bytes: PAYLOAD.length });
    expect(state.resolveHits).toBe(0);
  });
});
