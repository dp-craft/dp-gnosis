/**
 * The MCP surface: one tool over stdio, and ONE code path behind it.
 *
 * What is proved here is what a client depends on and cannot see from the
 * types: that the handshake answers in a version the client actually offered,
 * that a notification gets NO reply (a reply to a notification desynchronises
 * every subsequent id), that each failure mode carries its own JSON-RPC code —
 * and, the load-bearing one, that the tool's text is BYTE-IDENTICAL to the
 * `pack` field of a direct `answer --json`. Three renderings of a pack drift;
 * one does not, so equality here is `toBe` on the whole string, never
 * "contains".
 *
 * The stdio case exists because framing is the other silent failure: a request
 * split across two chunks must still be one request, and a single stray
 * non-JSON line corrupts the stream for the rest of the session.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { CliResult } from '../src/cli/cli.js';
import { runCli } from '../src/cli/cli.js';
import type { AnswerInput, AnswerRunner } from '../src/mcp/protocol.js';
import {
  answerArgv,
  DEFAULT_PROTOCOL_VERSION,
  handleLine,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_NAME
} from '../src/mcp/protocol.js';
import { serveStdio } from '../src/mcp/server.js';
import { activeProfile } from '../src/vocabulary.js';

type Json = Record<string, unknown>;

const cli = (exitCode: number, payload: Json): CliResult => ({
  exitCode,
  stdout: `${JSON.stringify({ ...payload, exitCode })}\n`,
  stderr: '',
});

const runner = (result: CliResult): AnswerRunner => async () => await Promise.resolve(result);

const reply = async (message: Json, run: AnswerRunner): Promise<Json | undefined> =>
  (await handleLine(JSON.stringify(message), run)) as Json | undefined;

const NO_RUN: AnswerRunner = async () => await Promise.resolve(cli(0, { pack: 'unused' }));

const resultOf = (response: Json | undefined): Json => (response?.['result'] ?? {}) as Json;
const errorOf = (response: Json | undefined): Json => (response?.['error'] ?? {}) as Json;

const firstText = (response: Json | undefined): string => {
  const content = resultOf(response)['content'] as readonly Json[] | undefined;
  return String(content?.[0]?.['text'] ?? '');
};

const call = (args: Json): Json => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: TOOL_NAME, arguments: args },
});

describe('initialize — answer in a version the client offered', () => {
  it('echoes the requested version when this server supports it', async () => {
    const response = await reply(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      NO_RUN
    );

    expect(resultOf(response)['protocolVersion']).toBe('2024-11-05');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
    expect(resultOf(response)['serverInfo']).toMatchObject({ name: 'dp-gnosis' });
    expect(resultOf(response)['capabilities']).toEqual({ tools: {} });
  });

  it('falls back to the default version for one it does not support', async () => {
    const response = await reply(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      NO_RUN
    );

    expect(resultOf(response)['protocolVersion']).toBe(DEFAULT_PROTOCOL_VERSION);
  });
});

describe('the JSON-RPC contract', () => {
  it('answers a notification with nothing at all', async () => {
    const response = await reply({ jsonrpc: '2.0', method: 'notifications/initialized' }, NO_RUN);

    expect(response).toBeUndefined();
  });

  it('lists exactly the one tool, with question required', async () => {
    const response = await reply({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, NO_RUN);
    const tools = resultOf(response)['tools'] as readonly Json[];
    const schema = tools[0]?.['inputSchema'] as Json;

    expect(tools.map(tool => tool['name'])).toEqual([TOOL_NAME]);
    expect(schema['required']).toEqual(['question']);
    expect(Object.keys(schema['properties'] as Json).sort()).toEqual(['domain', 'k', 'question']);
  });

  it('refuses an unknown tool with -32602, naming the one that exists', async () => {
    const response = await reply(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gnosis_retrieve' } },
      NO_RUN
    );

    expect(errorOf(response)['code']).toBe(-32602);
    expect(String(errorOf(response)['message'])).toContain(TOOL_NAME);
  });

  it('refuses an unknown method with -32601', async () => {
    const response = await reply({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, NO_RUN);

    expect(errorOf(response)['code']).toBe(-32601);
  });

  it('refuses an unparseable line with -32700 and a null id', async () => {
    const response = (await handleLine('{ not json', NO_RUN)) as Json | undefined;

    expect(errorOf(response)['code']).toBe(-32700);
    expect(response?.['id']).toBeNull();
  });
});

describe('the exit code is the contract, mirrored not flattened', () => {
  it('returns the pack for a PARTIAL run and does NOT set isError', async () => {
    const response = await reply(
      call({ question: 'q' }),
      runner(cli(3, { pack: 'PACK BODY', note: 'a rerank was refused' }))
    );

    expect(resultOf(response)['isError']).toBeUndefined();
    expect(firstText(response)).toContain('PACK BODY');
    expect(firstText(response)).toContain('a rerank was refused');
  });

  it('sets isError for a usage failure, carrying the error not an empty answer', async () => {
    const response = await reply(
      call({ question: 'q', domain: 'nope' }),
      runner(cli(2, { error: 'unknown --domain value "nope"' }))
    );

    expect(resultOf(response)['isError']).toBe(true);
    expect(firstText(response)).toContain('unknown --domain value');
  });

  // AC delta: the argv now carries --rerank unconditionally. The MCP surface
  // used to serve first-pass BM25 (vault nDCG@10 0.4894 vs champion 0.5791;
  // vault-hu 0.4868 vs 0.7699) while the runner nav path reranked — two
  // consumer surfaces answering the same question at different quality.
  it('omits -k entirely when the caller states no k, leaving the default to the CLI', () => {
    expect(answerArgv({ question: 'why' })).toEqual(['ask', 'why', '--json', '--rerank']);
    expect(answerArgv({ question: 'why', k: 3, domain: 'runner' })).toEqual([
      'ask',
      'why',
      '-k',
      '3',
      '--json',
      '--rerank',
      '--domain',
      'runner',
    ]);
  });
});

/**
 * A JSON re-parse cannot be made type-safe by DECLARING a type over it — the
 * bytes arrive at runtime. What is proved here is that the narrowing is a real
 * runtime check and that its refusal is LOUD: it names the key it wanted. The
 * `6fa79b54` defect class is a mirrored/misread key rendering as empty output,
 * so "not empty" is asserted beside "names the key".
 */
describe('the re-parsed payload is NARROWED, and refuses loudly', () => {
  it('names the missing key when the payload carries no pack at all', async () => {
    const response = await reply(call({ question: 'q' }), runner(cli(0, { count: 0 })));

    expect(resultOf(response)['isError']).toBe(true);
    expect(firstText(response)).toContain('pack');
    expect(firstText(response).length).toBeGreaterThan(0);
  });

  it('names the missing key when stdout is not JSON at all', async () => {
    const response = await reply(
      call({ question: 'q' }),
      runner({ exitCode: 0, stdout: 'npm run banner\n', stderr: '' })
    );

    expect(resultOf(response)['isError']).toBe(true);
    expect(firstText(response)).toContain('pack');
    expect(firstText(response)).toContain('npm run banner');
  });

  it('refuses an empty stdout with a message, never with an empty answer', async () => {
    const response = await reply(
      call({ question: 'q' }),
      runner({ exitCode: 0, stdout: '', stderr: '' })
    );

    expect(resultOf(response)['isError']).toBe(true);
    expect(firstText(response)).toContain('pack');
  });

  it('refuses a payload whose note is not a string instead of dropping it', async () => {
    const response = await reply(
      call({ question: 'q' }),
      runner(cli(3, { pack: 'PACK BODY', note: 42 }))
    );

    expect(resultOf(response)['isError']).toBe(true);
    expect(firstText(response)).toContain('note');
  });
});

const DOC = (term: string): string =>
  `# ${term} handbook\n\nprose about ${term} written at enough length that this section stands on its own as an atom of the corpus rather than folding into a neighbour, carrying real sentences about the ${term} subject matter\n`;

/** One instance of its own: own repo root, own corpus roots, own atoms dir, own index. */
const tinyCorpus = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-mcp-'));
  await mkdir(join(repoRoot, 'doc'), { recursive: true });
  await writeFile(join(repoRoot, 'doc', 'MCPDOC.md'), DOC('mcpknowledge'), 'utf8');
  await writeFile(join(repoRoot, 'doc', 'OTHER.md'), DOC('otherknowledge'), 'utf8');
  const profilePath = join(repoRoot, 'mcp.profile.json');
  await writeFile(
    profilePath,
    JSON.stringify({
      ...activeProfile(),
      name: 'mcp',
      repoRoot,
      corpusRoots: ['doc'],
      atomsDir: join(repoRoot, 'atoms'),
      indexPath: join(repoRoot, 'index.db'),
    }),
    'utf8'
  );
  await runCli(['ingest', '--profile', profilePath]);
  await runCli(['index', '--adapter', 'fts5', '--profile', profilePath]);
  return profilePath;
};

describe('ONE code path — the tool text IS the CLI pack', () => {
  // A closed port: this suite MUST NOT depend on a served cross-encoder (a cold
  // llama-swap load has measured 1 m 59 s). The refusal is what both surfaces
  // then share, so the byte-identity claim is about the argv, not the network.
  const CLOSED_RERANK_URL = 'http://127.0.0.1:9';

  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_RERANK_URL', CLOSED_RERANK_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns byte-for-byte the pack field of a direct answer --json', async () => {
    const profilePath = await tinyCorpus();
    const scoped: AnswerRunner = async (input: AnswerInput) =>
      await runCli([...answerArgv(input), '--profile', profilePath]);

    const response = await reply(call({ question: 'mcpknowledge handbook', k: 3 }), scoped);
    const direct = await runCli([
      'ask',
      'mcpknowledge handbook',
      '-k',
      '3',
      '--json',
      '--rerank',
      '--profile',
      profilePath,
    ]);
    const payload = JSON.parse(direct.stdout) as Json;
    const pack = payload['pack'];
    const note = payload['note'];

    // AC delta: both surfaces now pass --rerank, and this test pins the reranker
    // to a closed port so the refusal is deterministic and offline. A refused
    // rerank is EXIT_PARTIAL (3), not a failure — the first-pass pack is still
    // rendered, identically on both surfaces, and the note names the refusal
    // (which is what proves the MCP argv asked for the rerank at all).
    expect(direct.exitCode).toBe(3);
    expect(typeof pack).toBe('string');
    expect(String(pack)).toContain('mcpknowledge');
    expect(String(note)).toContain('rerank');
    // Byte-identity under the PARTIAL contract (protocol.ts packText): the pack
    // verbatim, then the note. Nothing is re-rendered here — and the narrowing
    // that now stands between the two MUST NOT turn a real pack into a refusal,
    // so the absence of isError is asserted beside the bytes.
    expect(firstText(response)).toBe(`${String(pack)}\n\n${String(note)}`);
    expect(resultOf(response)['isError']).toBeUndefined();
  });
});

const collect = (stream: PassThrough): { readonly lines: () => readonly string[] } => {
  const chunks: string[] = [];
  stream.on('data', chunk => chunks.push(String(chunk)));
  return { lines: () => chunks.join('').split('\n').filter(line => line.length > 0) };
};

describe('the stdio loop — framing survives a split chunk', () => {
  it('reassembles a request cut in half and writes only JSON lines', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = collect(output);
    serveStdio({ input, output }, NO_RUN);

    input.write('{"jsonrpc":"2.0","id":9,"meth');
    input.write('od":"tools/list"}\n\n');
    await new Promise(resolve => setTimeout(resolve, 50));

    const lines = written.lines();
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '') as Json)['id']).toBe(9);
  });
});

const MCP_SOURCES = ['protocol.ts', 'server.ts', 'main.ts'] as const;

const importsOf = (file: string): readonly string[] => {
  const source = readFileSync(fileURLToPath(new URL(`../src/mcp/${file}`, import.meta.url)), 'utf8');
  return [...source.matchAll(/from\s+'([^']+)'/g)].flatMap(match =>
    match[1] === undefined ? [] : [match[1]]
  );
};

describe('zero dependency — the guard', () => {
  it('imports only node builtins and relative paths from src/mcp', () => {
    const foreign = MCP_SOURCES.flatMap(file =>
      importsOf(file)
        .filter(spec => !spec.startsWith('node:') && !spec.startsWith('.'))
        .map(spec => `${file}: ${spec}`)
    );

    expect(foreign).toEqual([]);
  });

  it('leaves every dependency block of package.json unchanged in shape', () => {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Json;

    expect(Object.keys(manifest['dependencies'] as Json)).toEqual([
      'better-sqlite3',
      'minisearch',
      'stemmer',
    ]);
    expect(Object.keys(manifest['devDependencies'] as Json)).toEqual([
      '@lancedb/lancedb',
      '@types/better-sqlite3',
      'apache-arrow',
    ]);
    // optionalDependencies was removed entirely: npm installs optionalDependencies by
    // default, so @lancedb/lancedb (313 MB) was being downloaded by every consumer of a
    // tool that advertises no embeddings. The dense/hybrid research routes now sit in
    // devDependencies, which npm never installs for a consumer or a global install.
    expect(manifest['optionalDependencies']).toBeUndefined();
  });
});

/**
 * A4 — grounding, not answer material. Byte-identity above is a RELATIVE claim:
 * it holds just as well if both surfaces render bare ids. This is the absolute
 * one — the text this surface hands a client carries, for every atom the same
 * run delivered in `atoms[]`, that atom's own body under its own `[^id]`.
 *
 * The atoms come from the direct `--json` run rather than from a fixture, so
 * the claim is about what the tool actually delivered, not about what the test
 * hoped it would.
 */
interface DeliveredAtom {
  readonly id: string;
  readonly body: string;
  readonly snippet: string;
}

describe('the MCP text grounds every atom the run delivered', () => {
  const CLOSED_RERANK_URL = 'http://127.0.0.1:9';

  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_RERANK_URL', CLOSED_RERANK_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('carries each delivered atom body under its citation, never a bare id', async () => {
    const profilePath = await tinyCorpus();
    const scoped: AnswerRunner = async (input: AnswerInput) =>
      await runCli([...answerArgv(input), '--profile', profilePath]);

    const response = await reply(call({ question: 'mcpknowledge handbook', k: 3 }), scoped);
    const direct = await runCli([
      'ask',
      'mcpknowledge handbook',
      '-k',
      '3',
      '--json',
      '--rerank',
      '--profile',
      profilePath,
    ]);
    const atoms = (JSON.parse(direct.stdout) as Json)['atoms'] as readonly DeliveredAtom[];
    const text = firstText(response);

    expect(atoms.length).toBeGreaterThan(0);
    expect(atoms.filter(atom => atom.body === '' && atom.snippet === '').map(atom => atom.id))
      .toEqual([]);
    expect(atoms.filter(atom => !text.includes(`[^${atom.id}]`)).map(atom => atom.id)).toEqual([]);
    expect(atoms.filter(atom => !text.includes(atom.body)).map(atom => atom.id)).toEqual([]);
  });
});
