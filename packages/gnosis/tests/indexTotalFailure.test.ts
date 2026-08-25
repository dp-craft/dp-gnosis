/**
 * `index` — a build that produced NONE of what was asked for EXITS 3.
 *
 * Exit 3 is this repo's "real output was produced AND something was refused"
 * (README § Exit codes). Both cases below produce a real, queryable index and
 * refuse the treatment the caller named, which is exactly that shape:
 *
 * - `--enrichment` named and NOTHING merged — every enrichment column empty, so
 *   the index ranks exactly as an unenriched one.
 * - a generated `--body-source` that left EVERY indexed atom with an empty body
 *   — no body term can reach any atom at all.
 *
 * A PARTIAL failure stays exit 0 with its warning: some records merged, or some
 * atoms have a body. Escalating a partial would make the code unreadable as a
 * signal, and the warnings already exist to make a partial visible.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import {
  BODY_SOURCE_EMPTY_REASON,
  ENRICHMENT_EMPTY_REASON
} from '../src/cli/indexCommand.js';
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
];

/** Matches no atom on disk, so naming it merges NOTHING. */
const STRANGER: AtomSpec = { file: 'z.md', id: 'atom-absent', body: 'a body no atom holds' };

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
  '--json',
  ...extra,
];

const parseJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-index-total-failure-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  sidecarPath = resolve(root, 'enrichment.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  FIXTURE.forEach(spec => writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8'));
});

describe('a sidecar that merged NOTHING is a total failure', () => {
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exits 3 under a stable machine reason, keeping its warning text', async () => {
    writeSidecar([STRANGER]);

    const result = await runCli([...indexArgv(['--enrichment', sidecarPath])]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(data['reason']).toBe(ENRICHMENT_EMPTY_REASON);
    expect(data['built']).toBe(true);
    expect(data['enrichmentRecords']).toBe(0);
    expect(String(data['enrichmentWarning'])).toContain(sidecarPath);
  });

  it('STAYS exit 0 when SOME record merged — a partial is not a total failure', async () => {
    writeSidecar([FIXTURE[0] as AtomSpec, STRANGER]);

    const result = await runCli([...indexArgv(['--enrichment', sidecarPath])]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['enrichmentRecords']).toBe(1);
    expect(data['reason']).toBeUndefined();
  });
});

describe('a generated body that left EVERY atom empty is a total failure', () => {
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exits 3 under its own machine reason when no atom got a body', async () => {
    const result = await runCli([...indexArgv(['--body-source', 'long'])]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(data['reason']).toBe(BODY_SOURCE_EMPTY_REASON);
    expect(data['emptyBodyAtoms']).toBe(FIXTURE.length);
    expect(String(data['bodySourceWarning'])).toMatch(/EMPTY body/);
  });

  it('STAYS exit 0 when SOME atom got a body', async () => {
    writeSidecar([FIXTURE[0] as AtomSpec]);

    const result = await runCli([
      ...indexArgv(['--enrichment', sidecarPath, '--body-source', 'long']),
    ]);
    const data = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(data['emptyBodyAtoms']).toBe(1);
    expect(data['reason']).toBeUndefined();
  });

  it('names the ENRICHMENT cause first when both fired — one reason, the root one', async () => {
    writeSidecar([STRANGER]);

    const result = await runCli([
      ...indexArgv(['--enrichment', sidecarPath, '--body-source', 'long']),
    ]);

    expect(result.exitCode).toBe(3);
    expect(parseJson(result.stdout)['reason']).toBe(ENRICHMENT_EMPTY_REASON);
  });
});
