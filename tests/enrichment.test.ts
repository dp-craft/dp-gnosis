import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  atomKeyOf,
  docKeyOf,
  ENRICHMENT_PROMPT_VERSION,
  type EnrichmentRecord,
  isEnrichmentFresh,
  loadEnrichmentSidecar,
  parseEnrichmentLine,
  serializeEnrichmentRecord
} from '../src/enrichment.js';

const MODEL = 'qwen35b-a3b-q5km-ctx130k-mtp-frog-coding';

let root = '';
let sidecarPath = '';

const record = (overrides: Partial<EnrichmentRecord> = {}): EnrichmentRecord => ({
  key: atomKeyOf('zustand selector stability'),
  docKey: docKeyOf('docs/state.md'),
  variant: 'solo',
  unit: 'atom',
  id: 'atom-a',
  source: 'state/atom-a.md',
  short: 'selector stability',
  long: 'why a zustand selector must return a stable reference',
  doc_description: 'notes on client state',
  keywords: ['zustand', 'selector'],
  entities: ['useShallow', 'src/stores'],
  questions: ['what breaks when a selector returns a new object?'],
  promptVersion: ENRICHMENT_PROMPT_VERSION,
  model: MODEL,
  ...overrides,
});

const writeSidecar = (lines: readonly string[]): void => {
  writeFileSync(sidecarPath, lines.join(''), 'utf8');
};

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-enrichment-'));
  sidecarPath = resolve(root, 'enrichment.jsonl');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('atomKeyOf / docKeyOf', () => {
  it('is stable across calls and distinguishes one byte of difference', () => {
    expect(atomKeyOf('zustand selector stability')).toBe(
      atomKeyOf('zustand selector stability')
    );
    expect(atomKeyOf('zustand selector stability')).not.toBe(
      atomKeyOf('zustand selector stabilitY')
    );
  });

  it('hashes a body and a path into the same 64-hex-character space', () => {
    expect(atomKeyOf('body')).toMatch(/^[0-9a-f]{64}$/);
    expect(docKeyOf('docs/state.md')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys a path independently of the body that came from it', () => {
    expect(docKeyOf('docs/state.md')).toBe(docKeyOf('docs/state.md'));
    expect(docKeyOf('docs/state.md')).not.toBe(docKeyOf('docs/other.md'));
  });
});

describe('serializeEnrichmentRecord / parseEnrichmentLine', () => {
  it('round-trips a record without losing a field', () => {
    const original = record();

    expect(parseEnrichmentLine(serializeEnrichmentRecord(original))).toEqual(original);
  });

  it('writes ONE line with a trailing newline', () => {
    const line = serializeEnrichmentRecord(record());

    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
  });

  // Byte-stability is the append-only log's whole contract: a differently
  // ASSEMBLED record with identical content MUST serialize to identical bytes,
  // or every diff over the file is reordering noise.
  it('emits identical bytes for the same content assembled in a different key order', () => {
    const straight = record();
    const shuffled: EnrichmentRecord = {
      model: straight.model,
      questions: straight.questions,
      id: straight.id,
      short: straight.short,
      entities: straight.entities,
      docKey: straight.docKey,
      promptVersion: straight.promptVersion,
      unit: straight.unit,
      long: straight.long,
      keywords: straight.keywords,
      source: straight.source,
      variant: straight.variant,
      doc_description: straight.doc_description,
      key: straight.key,
    };

    expect(serializeEnrichmentRecord(shuffled)).toBe(serializeEnrichmentRecord(straight));
  });

  it('emits keys in sorted order', () => {
    const keys = Object.keys(JSON.parse(serializeEnrichmentRecord(record())) as object);

    expect(keys).toEqual([...keys].sort());
  });

  it('returns undefined — never throws — for a malformed line', () => {
    expect(parseEnrichmentLine('{"id":"atom-a"')).toBeUndefined();
    expect(parseEnrichmentLine('not json at all')).toBeUndefined();
    expect(parseEnrichmentLine('[1,2,3]')).toBeUndefined();
    expect(parseEnrichmentLine('{"id":"atom-a","unit":"atom"}')).toBeUndefined();
  });

  it('rejects a record whose list field is not a list of strings', () => {
    const line = serializeEnrichmentRecord(record()).replace('"keywords":["zustand","selector"]', '"keywords":"zustand"');

    expect(parseEnrichmentLine(line)).toBeUndefined();
  });
});

describe('loadEnrichmentSidecar', () => {
  it('returns an EMPTY map for an absent file rather than throwing', () => {
    expect(loadEnrichmentSidecar(resolve(root, 'never-written.jsonl')).size).toBe(0);
  });

  it('keys records by atom id', () => {
    writeSidecar([
      serializeEnrichmentRecord(record()),
      serializeEnrichmentRecord(record({ id: 'atom-b' })),
    ]);

    expect([...loadEnrichmentSidecar(sidecarPath).keys()].sort()).toEqual(['atom-a', 'atom-b']);
  });

  // The append-only resume rule: a re-run appends, so the TAIL is the answer.
  it('lets a LATER record for an id win over an earlier one', () => {
    writeSidecar([
      serializeEnrichmentRecord(record({ short: 'first pass' })),
      serializeEnrichmentRecord(record({ short: 'second pass' })),
    ]);

    expect(loadEnrichmentSidecar(sidecarPath).get('atom-a')?.short).toBe('second pass');
  });

  // The interrupted-append artefact: a truncated tail line MUST NOT brick a build.
  it('SKIPS a malformed line and keeps every well-formed one', () => {
    writeSidecar([
      serializeEnrichmentRecord(record()),
      '{"id":"atom-truncated","key":"ab\n',
      serializeEnrichmentRecord(record({ id: 'atom-b' })),
    ]);

    const loaded = loadEnrichmentSidecar(sidecarPath);

    expect([...loaded.keys()].sort()).toEqual(['atom-a', 'atom-b']);
  });

  it('reports the skipped count on stderr instead of dropping it silently', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    writeSidecar([serializeEnrichmentRecord(record()), 'garbage\n', 'more garbage\n']);

    loadEnrichmentSidecar(sidecarPath);
    spy.mockRestore();

    expect(written.join('')).toContain('SKIPPED 2 malformed line(s)');
  });

  it('treats a blank trailing line as the file\'s newline, not a defect', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    writeSidecar([serializeEnrichmentRecord(record())]);

    expect(loadEnrichmentSidecar(sidecarPath).size).toBe(1);
    spy.mockRestore();
    expect(written).toEqual([]);
  });
});

describe('isEnrichmentFresh', () => {
  const fresh = record();
  const bodyKey = atomKeyOf('zustand selector stability');

  it('is true when body, prompt version and model all match', () => {
    expect(isEnrichmentFresh(fresh, bodyKey, ENRICHMENT_PROMPT_VERSION, MODEL)).toBe(true);
  });

  it('is FALSE when the prompt version moved', () => {
    expect(isEnrichmentFresh(fresh, bodyKey, ENRICHMENT_PROMPT_VERSION + 1, MODEL)).toBe(false);
  });

  it('is FALSE when the model changed', () => {
    expect(isEnrichmentFresh(fresh, bodyKey, ENRICHMENT_PROMPT_VERSION, 'some-other-model')).toBe(
      false
    );
  });

  it('is FALSE when the atom body changed', () => {
    expect(
      isEnrichmentFresh(fresh, atomKeyOf('zustand selector stability!'), ENRICHMENT_PROMPT_VERSION, MODEL)
    ).toBe(false);
  });
});
