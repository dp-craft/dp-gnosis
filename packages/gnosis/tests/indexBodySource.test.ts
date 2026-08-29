/**
 * `index --body-source` — what the CLI STATES about a generated-body build.
 *
 * The hole it closes is the one `--enrichment` already closed one step over: an
 * atom with no sidecar record gets an EMPTY `body` under a generated source, and
 * an index full of empty bodies answers every query with nothing while exiting
 * 0. So the count is reported in BOTH renderings, and a non-zero count warns —
 * without moving the exit code, exactly as the enrichment warning does.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import {
  atomKeyOf,
  docKeyOf,
  ENRICHMENT_PROMPT_VERSION,
  type EnrichmentRecord,
  serializeEnrichmentRecord
} from '../src/enrichment.js';

const MODEL = 'qwen35b-a3b-q5km-ctx130k-mtp-frog-coding';

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly body: string;
}

const FIXTURE: readonly AtomSpec[] = [
  { file: 'a.md', id: 'atom-a', body: 'zustand selector stability in the store' },
  { file: 'b.md', id: 'atom-b', body: 'immutable spread updates for a plain record' },
  { file: 'c.md', id: 'atom-c', body: 'a selector reads one slice of the store' },
];

let root = '';
let atomsDir = '';
let indexPath = '';
let sidecarPath = '';

const atomText = (spec: AtomSpec): string =>
  [
    '---',
    'type: knowledge',
    `id: ${spec.id}`,
    `title: title of ${spec.id}`,
    'x_domain: runner',
    'status: stable',
    'sources:',
    '  - https://example.com/src',
    '---',
    spec.body,
    '',
  ].join('\n');

const enrichmentFor = (spec: AtomSpec): EnrichmentRecord => ({
  key: atomKeyOf(spec.body),
  docKey: docKeyOf(`docs/${spec.file}`),
  variant: 'solo',
  unit: 'atom',
  id: spec.id,
  source: spec.file,
  short: `short note for ${spec.id}`,
  long: `a longer paragraph describing ${spec.id} at some length`,
  doc_description: 'a document about client state management',
  keywords: ['state', 'store'],
  entities: ['useShallow'],
  questions: ['what is a slice?'],
  promptVersion: ENRICHMENT_PROMPT_VERSION,
  model: MODEL,
});

const writeSidecar = (specs: readonly AtomSpec[]): void =>
  writeFileSync(
    sidecarPath,
    specs.map(enrichmentFor).map(serializeEnrichmentRecord).join(''),
    'utf8'
  );

const indexArgv = (extra: readonly string[]): readonly string[] => [
  'index',
  '--adapter',
  'fts5',
  '--atoms-dir',
  atomsDir,
  '--index-path',
  indexPath,
  ...extra,
];

const parseJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-index-body-source-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  sidecarPath = resolve(root, 'enrichment.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  FIXTURE.forEach(spec => writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('index --body-source', () => {
  it('reports nothing at all when the flag is absent — today\'s build', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli([...indexArgv(['--enrichment', sidecarPath, '--json'])]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['bodySource']).toBeUndefined();
    expect(data['emptyBodyAtoms']).toBeUndefined();
    expect(data['bodySourceWarning']).toBeUndefined();
  });

  it('states the source and a zero empty count when every atom has a record', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli([
      ...indexArgv(['--enrichment', sidecarPath, '--body-source', 'long', '--json']),
    ]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['bodySource']).toBe('long');
    expect(data['emptyBodyAtoms']).toBe(0);
    expect(data['bodySourceWarning']).toBeUndefined();
  });

  it('WARNS about atoms left with an empty body, exit code untouched', async () => {
    writeSidecar([FIXTURE[0] as AtomSpec]);

    const result = await runCli([
      ...indexArgv(['--enrichment', sidecarPath, '--body-source', 'long+keywords', '--json']),
    ]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['bodySource']).toBe('long+keywords');
    expect(data['emptyBodyAtoms']).toBe(2);
    expect(String(data['bodySourceWarning'])).toMatch(/2 atom\(s\)/);
  });

  // No sidecar at all, so EVERY atom is left empty — a total failure, which
  // exits PARTIAL (`indexTotalFailure.test.ts` owns that rule). The warning
  // TEXT is what this case asserts, and it is unchanged.
  it('carries the same warning in the human rendering', async () => {
    const result = await runCli([...indexArgv(['--body-source', 'long'])]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toMatch(/body-source/);
    expect(result.stdout).toMatch(/3 atom\(s\)/);
  });

  it('REFUSES a source outside the vocabulary, naming it', async () => {
    const result = await runCli([...indexArgv(['--body-source', 'summary'])]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--body-source/);
    expect(result.stderr).toMatch(/long\+keywords/);
  });

  it('REFUSES the flag on retrieve, which builds no index', async () => {
    const result = await runCli(['search', 'selector', '--body-source', 'long']);

    expect(result.exitCode).toBe(2);
  });
});
