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

/**
 * The silent hole this covers: `enrich` costs GPU hours, `index --enrichment` is
 * the forgotten half, and a build that never saw the sidecar is byte-for-byte a
 * build that saw one matching nothing — same empty columns, same exit 0, same
 * baseline results. `index` therefore STATES what it merged, read back off the
 * stamp the build wrote, and warns when the answer is zero.
 */

const MODEL = 'qwen35b-a3b-q5km-ctx130k-mtp-frog-coding';

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly body: string;
}

const FIXTURE: readonly AtomSpec[] = [
  { file: 'a.md', id: 'atom-a', body: 'zustand selector selector stability in the store' },
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
  writeFileSync(sidecarPath, specs.map(enrichmentFor).map(serializeEnrichmentRecord).join(''), 'utf8');

const indexArgv = (enrichment?: string): readonly string[] => [
  'index',
  '--adapter',
  'fts5',
  '--atoms-dir',
  atomsDir,
  '--index-path',
  indexPath,
  '--json',
  ...(enrichment === undefined ? [] : ['--enrichment', enrichment]),
];

const parseJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-index-enrich-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  sidecarPath = resolve(root, 'enrichment.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  FIXTURE.forEach(spec => writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('index reports what the enrichment sidecar merged', () => {
  it('states the merged record count in both renderings', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli([...indexArgv(sidecarPath)]);

    expect(result.exitCode).toBe(0);
    expect(parseJson(result.stdout)['enrichmentRecords']).toBe(FIXTURE.length);
  });

  it('states the merged record count in the human rendering too', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli(['index', '--adapter', 'fts5', '--atoms-dir', atomsDir,
      '--index-path', indexPath, '--enrichment', sidecarPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${FIXTURE.length} enrichment record(s)`);
  });

  // Nothing merged at all is a TOTAL failure and exits PARTIAL — the warning
  // fields are what this case asserts, and they are unchanged. A partial merge
  // still keeps exit 0 (`indexTotalFailure.test.ts` owns both halves).
  it('WARNS when the sidecar was named and nothing merged, and exits PARTIAL', async () => {
    writeSidecar([{ file: 'z.md', id: 'atom-never-indexed', body: 'a body no atom on disk holds' }]);

    const result = await runCli([...indexArgv(sidecarPath)]);

    expect(result.exitCode).toBe(3);
    const data = parseJson(result.stdout);
    expect(data['enrichmentRecords']).toBe(0);
    expect(String(data['enrichmentWarning'])).toContain(sidecarPath);
  });

  it('leaves an unenriched build exactly as it was — no enrichment fields at all', async () => {
    const result = await runCli([...indexArgv()]);

    expect(result.exitCode).toBe(0);
    const data = parseJson(result.stdout);
    expect(data['enrichmentRecords']).toBeUndefined();
    expect(data['enrichmentWarning']).toBeUndefined();
  });

  it('keeps the domain-census warning key untouched, so neither warning hides the other', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli([...indexArgv(sidecarPath)]);

    expect(parseJson(result.stdout)['warning']).toBeUndefined();
  });
});

/**
 * `index --enrichment-columns` — what the CLI STATES about a build that carried
 * only some of the six enrichment columns.
 *
 * The default reports NOTHING, deliberately: a full build is the index every
 * recorded number was measured on, and a field stating the default would make
 * every rebuilt index look like a named arm.
 */
/** No `--json`: a usage refusal is stated on stderr, which is what these assert. */
const refusalArgv = (): readonly string[] =>
  indexArgv(sidecarPath).filter(argument => argument !== '--json');

describe('index --enrichment-columns', () => {
  it('reports nothing at all when the flag is absent — today\'s build', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli([...indexArgv(sidecarPath)]);

    expect(result.exitCode).toBe(0);
    expect(parseJson(result.stdout)['enrichmentColumns']).toBeUndefined();
  });

  it('reports nothing when the DEFAULT is named explicitly', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli([...indexArgv(sidecarPath), '--enrichment-columns', 'all']);

    expect(result.exitCode).toBe(0);
    expect(parseJson(result.stdout)['enrichmentColumns']).toBeUndefined();
  });

  it('states the canonical selection when a subset was named', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli([
      ...indexArgv(sidecarPath),
      '--enrichment-columns',
      'questions,keywords',
    ]);

    expect(result.exitCode).toBe(0);
    expect(parseJson(result.stdout)['enrichmentColumns']).toBe('keywords,questions');
  });

  it('states the selection in the human rendering too', async () => {
    writeSidecar(FIXTURE);

    const result = await runCli(['index', '--adapter', 'fts5', '--atoms-dir', atomsDir,
      '--index-path', indexPath, '--enrichment', sidecarPath, '--enrichment-columns', 'none']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/--enrichment-columns none/);
  });

  it('REFUSES `body`, pointing at the flag that DOES own that column', async () => {
    const result = await runCli([...refusalArgv(), '--enrichment-columns', 'body']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--enrichment-columns/);
    expect(result.stderr).toMatch(/--body-source/);
  });

  it('REFUSES a name outside the vocabulary, listing what is valid', async () => {
    const result = await runCli([...refusalArgv(), '--enrichment-columns', 'summaries']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/summaries/);
    expect(result.stderr).toMatch(/doc_desc/);
  });

  it('REFUSES an empty csv entry rather than guessing which column was meant', async () => {
    const result = await runCli([...refusalArgv(), '--enrichment-columns', 'questions,']);

    expect(result.exitCode).toBe(2);
  });

  it('REFUSES the flag on retrieve, which builds no index', async () => {
    const result = await runCli(['search', 'selector', '--enrichment-columns', 'questions']);

    expect(result.exitCode).toBe(2);
  });
});
