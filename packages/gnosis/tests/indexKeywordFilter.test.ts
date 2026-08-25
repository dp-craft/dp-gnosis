/**
 * `index --keyword-filter` — what the CLI STATES about a filtered-keyword build.
 *
 * The fact the operator needs is the ECHO RATE ON THEIR OWN CORPUS. It is
 * corpus- and language-dependent — measured 71.3 % on `vault` and 78.7 % on
 * `nfcorpus` — so it MUST be read off the run's own report rather than carried
 * over from a number someone else measured. Hence both counts are surfaced in
 * both renderings, read back off the stamp the build wrote.
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
  readonly keywords: readonly string[];
}

/** Six keywords offered, two of them novel — a 66.7 % echo rate on THIS corpus. */
const FIXTURE: readonly AtomSpec[] = [
  {
    file: 'a.md',
    id: 'atom-a',
    body: 'zustand selector stability across many stores',
    keywords: ['selector', 'stores', 'middleware'],
  },
  {
    file: 'b.md',
    id: 'atom-b',
    body: 'immutable spread updates for a plain record',
    keywords: ['spread', 'record', 'hydration'],
  },
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
  keywords: [...spec.keywords],
  entities: ['useShallow'],
  questions: ['what is a slice?'],
  promptVersion: ENRICHMENT_PROMPT_VERSION,
  model: MODEL,
});

const writeSidecar = (): void =>
  writeFileSync(
    sidecarPath,
    FIXTURE.map(enrichmentFor).map(serializeEnrichmentRecord).join(''),
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
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-index-keyword-filter-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  sidecarPath = resolve(root, 'enrichment.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  FIXTURE.forEach(spec => writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8'));
  writeSidecar();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('index --keyword-filter', () => {
  it('reports nothing at all when the flag is absent — today\'s build', async () => {
    const result = await runCli([...indexArgv(['--enrichment', sidecarPath, '--json'])]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['keywordFilter']).toBeUndefined();
    expect(data['keywordsKept']).toBeUndefined();
    expect(data['keywordsDropped']).toBeUndefined();
  });

  it('reports nothing when the DEFAULT is named explicitly', async () => {
    const result = await runCli([
      ...indexArgv(['--enrichment', sidecarPath, '--keyword-filter', 'none', '--json']),
    ]);

    expect(result.exitCode).toBe(0);
    expect(parseJson(result.stdout)['keywordFilter']).toBeUndefined();
  });

  it('states what it KEPT and what it DROPPED on this corpus', async () => {
    const result = await runCli([
      ...indexArgv(['--enrichment', sidecarPath, '--keyword-filter', 'novel', '--json']),
    ]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['keywordFilter']).toBe('novel');
    expect(data['keywordsKept']).toBe(2);
    expect(data['keywordsDropped']).toBe(4);
  });

  it('states the echo rate measured on THIS run in the human rendering', async () => {
    const result = await runCli([
      ...indexArgv(['--enrichment', sidecarPath, '--keyword-filter', 'novel']),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/--keyword-filter novel/);
    expect(result.stdout).toMatch(/4 of 6 keyword\(s\)/);
    expect(result.stdout).toMatch(/66\.7 ?%/);
  });

  it('states a build that had NO keywords to filter without inventing a rate', async () => {
    const result = await runCli([...indexArgv(['--keyword-filter', 'novel', '--json'])]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['keywordsKept']).toBe(0);
    expect(data['keywordsDropped']).toBe(0);
    expect(result.stdout).not.toMatch(/NaN/);
  });

  it('REFUSES a filter outside the vocabulary, naming it', async () => {
    const result = await runCli([...indexArgv(['--keyword-filter', 'echo'])]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--keyword-filter/);
    expect(result.stderr).toMatch(/novel/);
  });

  it('REFUSES the flag on retrieve, which builds no index', async () => {
    const result = await runCli(['retrieve', 'selector', '--keyword-filter', 'novel']);

    expect(result.exitCode).toBe(2);
  });
});
