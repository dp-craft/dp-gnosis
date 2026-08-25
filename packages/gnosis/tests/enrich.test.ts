/**
 * `src/enrich.ts` — the generation walk, the prompt contract, and the
 * deterministic `entities` column.
 *
 * No server and no HTTP: the provider is a FAKE that records every request, so
 * the properties under test are the ones the runner owns — sequencing, skipping
 * what is fresh, appending whole records, and stopping without writing a partial
 * one. A live model would measure the model, not this file.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AtomFrontmatter } from '../src/atom.js';
import { serializeAtom } from '../src/atom.js';
import type { ChatOutcome, ChatProvider, ChatRequest } from '../src/chat.js';
import { ENRICH_SEED, ENRICH_SEED_RETRIES } from '../src/config.js';
import {
  enrichAtoms,
  ENRICHMENT_SCHEMA,
  ENRICHMENT_SYSTEM_PROMPT,
  extractEntities,
  NO_SECTIONS,
  PROGRESS_EVERY,
  progressLine
} from '../src/enrich.js';
import {
  atomKeyOf,
  ENRICHMENT_PROMPT_VERSION,
  loadEnrichmentSidecar,
  serializeEnrichmentRecord
} from '../src/enrichment.js';

const MODEL = 'fake-generator';

const FIELDS = {
  short: 'A short line.',
  long: 'A longer situating passage. It names the section.',
  doc_description: 'The whole document, in one sentence.',
  keywords: ['alpha', 'bravo'],
  questions: ['What is alpha?', 'Why bravo?'],
};

const frontmatter = (id: string, extra: Partial<AtomFrontmatter> = {}): AtomFrontmatter => ({
  type: 'knowledge',
  id,
  title: `Title ${id}`,
  x_domain: 'testing',
  status: 'stable',
  sources: [`doc/${id}.md`],
  ...extra,
});

interface Fixture {
  readonly atomsDir: string;
  readonly sidecarPath: string;
}

const writeAtom = async (
  atomsDir: string,
  id: string,
  body: string,
  extra: Partial<AtomFrontmatter> = {}
): Promise<void> => {
  await writeFile(join(atomsDir, `${id}.md`), serializeAtom(frontmatter(id, extra), body), 'utf8');
};

const makeFixture = async (ids: readonly string[]): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-enrich-'));
  await Promise.all(ids.map(async id => await writeAtom(root, id, `body of ${id}\n`)));
  return { atomsDir: root, sidecarPath: join(root, 'sidecar', 'enrichment.jsonl') };
};

/** Records every request and answers with whatever the case scripted. */
interface FakeProvider extends ChatProvider {
  readonly requests: readonly ChatRequest[];
  /** Ids in flight at once — proves the walk never runs two calls concurrently. */
  readonly maxConcurrent: () => number;
}

const fakeProvider = (answer: (req: ChatRequest) => ChatOutcome): FakeProvider => {
  const requests: ChatRequest[] = [];
  const peak = { inFlight: 0, max: 0 };
  return {
    id: MODEL,
    requests,
    maxConcurrent: (): number => peak.max,
    complete: async (req: ChatRequest): Promise<ChatOutcome> => {
      requests.push(req);
      peak.inFlight += 1;
      peak.max = Math.max(peak.max, peak.inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      peak.inFlight -= 1;
      return answer(req);
    },
  };
};

const answersWith = (value: unknown) => (): ChatOutcome => ({ ok: true, value });

const readSidecar = async (path: string): Promise<readonly string[]> =>
  (await readFile(path, 'utf8')).split('\n').filter(line => line.length > 0);

describe('extractEntities — deterministic, verbatim, order-preserving', () => {
  it.each([
    ['forEachLocale is called', 'forEachLocale'],
    ['see db/idb.ts for the schema', 'db/idb.ts'],
    ['the origin_index field', 'origin_index'],
    ['read package.json first', 'package.json'],
    ['pass --rerank to enable it', '--rerank'],
    ['upgraded to v0.33.0 today', 'v0.33.0'],
    ['see https://example.org/spec now', 'https://example.org/spec'],
    ['it decoded at 35.9tok per second', '35.9tok'],
    ['the RRF fusion rule', 'RRF'],
  ])('finds the literal in %s', (body, expected) => {
    expect(extractEntities(body)).toContain(expected);
  });

  it('preserves case and inner punctuation exactly', () => {
    expect(extractEntities('buildFts5Index reads src/cli/args.ts')).toEqual([
      'buildFts5Index',
      'src/cli/args.ts',
    ]);
  });

  it('dedupes while keeping first-appearance order', () => {
    expect(extractEntities('RRF then BM25 then RRF again')).toEqual(['RRF', 'BM25']);
  });

  it('strips sentence and markdown punctuation around a term', () => {
    expect(extractEntities('(`db/idb.ts`), **forEachLocale**.')).toEqual([
      'db/idb.ts',
      'forEachLocale',
    ]);
  });

  it('keeps ordinary prose out of the column', () => {
    expect(extractEntities('the system reads the document and answers')).toEqual([]);
  });

  it('is a pure function of the body — same input, same array', () => {
    const body = 'forEachLocale in src/i18n/index.ts at v1.2.0';
    expect(extractEntities(body)).toEqual(extractEntities(body));
  });
});

describe('the prompt contract — five model fields, entities excluded', () => {
  it('never asks the model for entities; the regex owns that column', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).not.toContain('- entities:');
  });

  it('requires the five fields it does ask for, and forbids a sixth', () => {
    expect(ENRICHMENT_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ['short', 'long', 'doc_description', 'keywords', 'questions'],
    });
  });

  it('keeps the 12-to-15 question band the coverage constraint rests on', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('questions: 12 to 15 natural questions');
  });

  it('states the no-paraphrase rule, the method\'s published failure mode', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('NO PARAPHRASE');
  });

  it('states the coverage rule the SECTIONS input exists to serve', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('COVERAGE');
  });
});

describe('the user message is PATH / TITLE / SECTIONS / FRAGMENT, exactly', () => {
  it('names the SOURCE document, the title, the heading chain and the body', async () => {
    const fixture = await makeFixture([]);
    await writeAtom(fixture.atomsDir, 'a', 'the body text\n', {
      heading_chain: 'Rerank > Fusion',
    });
    const provider = fakeProvider(answersWith(FIELDS));
    await enrichAtoms({ ...fixture, provider });
    expect(provider.requests[0]?.user).toBe(
      'PATH: doc/a.md\nTITLE: Title a\nSECTIONS: Rerank > Fusion\n\nFRAGMENT:\nthe body text\n'
    );
  });

  it('states (none) when the atom carries no heading chain', async () => {
    const fixture = await makeFixture(['solo']);
    const provider = fakeProvider(answersWith(FIELDS));
    await enrichAtoms({ ...fixture, provider });
    expect(provider.requests[0]?.user).toContain(`SECTIONS: ${NO_SECTIONS}`);
  });
});

describe('the walk appends whole records, one call at a time', () => {
  it('writes one JSONL line per atom, carrying the deterministic entities', async () => {
    const fixture = await makeFixture([]);
    await writeAtom(fixture.atomsDir, 'a', 'body naming forEachLocale here\n');
    const provider = fakeProvider(answersWith(FIELDS));
    const report = await enrichAtoms({ ...fixture, provider });
    expect(report).toMatchObject({ atoms: 1, enriched: 1, skipped: 0, failure: undefined });
    const sidecar = loadEnrichmentSidecar(fixture.sidecarPath);
    expect(sidecar.get('a')).toMatchObject({
      ...FIELDS,
      entities: ['forEachLocale'],
      id: 'a',
      source: 'a.md',
      unit: 'atom',
      variant: 'solo',
      model: MODEL,
      promptVersion: ENRICHMENT_PROMPT_VERSION,
    });
  });

  it('is SEQUENTIAL — never two generations in flight, as measured', async () => {
    const fixture = await makeFixture(['a', 'b', 'c', 'd']);
    const provider = fakeProvider(answersWith(FIELDS));
    await enrichAtoms({ ...fixture, provider });
    expect(provider.maxConcurrent()).toBe(1);
  });

  it('walks in relative-path order, so a resumed run continues where it stopped', async () => {
    const fixture = await makeFixture(['c', 'a', 'b']);
    const provider = fakeProvider(answersWith(FIELDS));
    await enrichAtoms({ ...fixture, provider });
    expect(provider.requests.map(req => req.user.split('\n')[1])).toEqual([
      'TITLE: Title a',
      'TITLE: Title b',
      'TITLE: Title c',
    ]);
  });
});

describe('freshness — an unchanged atom costs no call', () => {
  it('skips an atom whose record is fresh for this body, prompt version and model', async () => {
    const fixture = await makeFixture(['a', 'b']);
    const first = fakeProvider(answersWith(FIELDS));
    await enrichAtoms({ ...fixture, provider: first });
    const second = fakeProvider(answersWith(FIELDS));
    const report = await enrichAtoms({ ...fixture, provider: second });
    expect(report).toMatchObject({ atoms: 2, enriched: 0, skipped: 2 });
    expect(second.requests).toEqual([]);
  });

  it('regenerates an atom whose BODY changed, and appends rather than rewrites', async () => {
    const fixture = await makeFixture(['a']);
    await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) });
    await writeAtom(fixture.atomsDir, 'a', 'a different body\n');
    const report = await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) });
    expect(report).toMatchObject({ enriched: 1, skipped: 0 });
    expect((await readSidecar(fixture.sidecarPath)).length).toBe(2);
  });

  it('regenerates when the MODEL changed — one model\'s output is never another\'s', async () => {
    const fixture = await makeFixture(['a']);
    await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) });
    const other: ChatProvider = {
      id: 'another-generator',
      complete: async (): Promise<ChatOutcome> => await Promise.resolve({ ok: true, value: FIELDS }),
    };
    expect(await enrichAtoms({ ...fixture, provider: other })).toMatchObject({ enriched: 1 });
  });

  it('reads the LATER record for an id, so a resumed run sees its own writes', async () => {
    const fixture = await makeFixture(['a']);
    await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) });
    const record = loadEnrichmentSidecar(fixture.sidecarPath).get('a');
    expect(record?.key).toBe(atomKeyOf('body of a\n'));
  });

  it('treats a malformed line as absent rather than bricking the run', async () => {
    const fixture = await makeFixture(['a']);
    await writeFile(join(fixture.atomsDir, 'noise.txt'), 'x', 'utf8');
    await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) });
    await writeFile(
      fixture.sidecarPath,
      `{ not json at all\n${(await readSidecar(fixture.sidecarPath))[0] ?? ''}\n`,
      'utf8'
    );
    expect(await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) })).toMatchObject(
      { enriched: 0, skipped: 1 }
    );
  });
});

describe('--limit bounds a pilot batch without losing the rest', () => {
  it('enriches at most n stale atoms and reports the rest as deferred', async () => {
    const fixture = await makeFixture(['a', 'b', 'c', 'd']);
    const provider = fakeProvider(answersWith(FIELDS));
    const report = await enrichAtoms({ ...fixture, provider, limit: 2 });
    expect(report).toMatchObject({ atoms: 4, enriched: 2, skipped: 0, deferred: 2 });
    expect(provider.requests.length).toBe(2);
  });

  it('picks up the deferred atoms on the next run', async () => {
    const fixture = await makeFixture(['a', 'b', 'c', 'd']);
    await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)), limit: 2 });
    expect(
      await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) })
    ).toMatchObject({ enriched: 2, skipped: 2, deferred: 0 });
  });
});

describe('a refusal STOPS the run, and never writes a partial record', () => {
  it('stops on a refused call, carrying its message', async () => {
    const fixture = await makeFixture(['a', 'b', 'c']);
    const provider = fakeProvider(
      (): ChatOutcome => ({ ok: false, error: 'model not served', kind: 'transport' })
    );
    const report = await enrichAtoms({ ...fixture, provider });
    expect(report).toMatchObject({ enriched: 0, failure: 'model not served' });
    expect(provider.requests.length).toBe(1);
  });

  it('stops on an answer that does not match the schema, naming the atom', async () => {
    const fixture = await makeFixture(['a']);
    const provider = fakeProvider(answersWith({ short: 'only one field' }));
    const report = await enrichAtoms({ ...fixture, provider });
    expect(report.failure).toContain('"a"');
    expect(report.failure).toContain('did not match the ');
  });

  it('writes nothing at all when the FIRST atom is refused', async () => {
    const fixture = await makeFixture(['a']);
    await enrichAtoms({
      ...fixture,
      provider: fakeProvider((): ChatOutcome => ({ ok: false, error: 'down', kind: 'transport' })),
    });
    expect(loadEnrichmentSidecar(fixture.sidecarPath).size).toBe(0);
  });

  it('keeps the records that landed BEFORE the refusal, so the run resumes', async () => {
    const fixture = await makeFixture(['a', 'b']);
    const provider = fakeProvider(
      (req: ChatRequest): ChatOutcome =>
        req.user.includes('Title a')
          ? { ok: true, value: FIELDS }
          : { ok: false, error: 'down', kind: 'transport' }
    );
    const report = await enrichAtoms({ ...fixture, provider });
    expect(report).toMatchObject({ enriched: 1, failure: 'down' });
    expect(loadEnrichmentSidecar(fixture.sidecarPath).size).toBe(1);
  });

  it('rejects a keywords array carrying a non-string, which strict mode forbids', async () => {
    const fixture = await makeFixture(['a']);
    const provider = fakeProvider(answersWith({ ...FIELDS, keywords: ['ok', 7] }));
    expect((await enrichAtoms({ ...fixture, provider })).failure).toBeDefined();
  });
});

describe('progress — an 11-hour run says where it is', () => {
  it('reports done, total, elapsed and projected remaining', () => {
    expect(progressLine(25, 100, 50_000)).toBe(
      'enrich: 25/100 atoms · elapsed 50s · remaining ~150s'
    );
  });

  it(`emits one line every ${PROGRESS_EVERY} atoms, and none before the first`, async () => {
    const ids = [...Array(PROGRESS_EVERY + 1).keys()].map(index => `a${String(index).padStart(3, '0')}`);
    const fixture = await makeFixture(ids);
    const lines: string[] = [];
    await enrichAtoms({
      ...fixture,
      provider: fakeProvider(answersWith(FIELDS)),
      onProgress: line => lines.push(line),
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`${PROGRESS_EVERY}/${PROGRESS_EVERY + 1} atoms`);
  });

  it('writes nothing when no reporter was supplied', async () => {
    const fixture = await makeFixture(['a']);
    expect(await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) })).toMatchObject(
      { enriched: 1 }
    );
  });
});

describe('the sidecar line is the serializer\'s, byte for byte', () => {
  it('appends exactly what serializeEnrichmentRecord produces', async () => {
    const fixture = await makeFixture(['a']);
    await enrichAtoms({ ...fixture, provider: fakeProvider(answersWith(FIELDS)) });
    const record = loadEnrichmentSidecar(fixture.sidecarPath).get('a');
    expect(await readFile(fixture.sidecarPath, 'utf8')).toBe(
      record === undefined ? '' : serializeEnrichmentRecord(record)
    );
  });
});

/**
 * C9 — the seed-bump ladder. The measured defect: one atom decoded UNBOUNDEDLY
 * at the shipped seed (`finish_reason: "length"` at 1200, 1600, 2048 and 4000
 * tokens) while the SAME atom at seed 12, 13 and 14 decoded in 455–495 tokens.
 * Generation being deterministic, the run could never get past it.
 */
const seedsOf = (provider: FakeProvider): readonly (number | undefined)[] =>
  provider.requests.map(req => req.seed);

/** Fails to decode at the stated seeds, answers normally at every other one. */
const decodeFailsAt =
  (...failing: readonly number[]) =>
    (req: ChatRequest): ChatOutcome =>
      failing.includes(req.seed ?? ENRICH_SEED)
        ? { ok: false, error: 'response_format was not honoured', kind: 'decode' }
        : { ok: true, value: FIELDS };

describe('C9 — a decode failure retries the SAME atom at a bumped seed', () => {
  it('retries at seed+1 and enriches, reporting the atom as retried', async () => {
    const fixture = await makeFixture(['a']);
    const provider = fakeProvider(decodeFailsAt(ENRICH_SEED));
    const report = await enrichAtoms({ ...fixture, provider });
    expect(report).toMatchObject({ enriched: 1, retried: 1, retriedIds: ['a'], failure: undefined });
    expect(seedsOf(provider)).toEqual([ENRICH_SEED, ENRICH_SEED + 1]);
  });

  it('climbs the whole ladder — 11 then 12, 13, 14 — and never randomises it', async () => {
    const fixture = await makeFixture(['a']);
    const provider = fakeProvider(decodeFailsAt(ENRICH_SEED, ENRICH_SEED + 1, ENRICH_SEED + 2));
    const report = await enrichAtoms({ ...fixture, provider });
    expect(report).toMatchObject({ enriched: 1, retried: 1 });
    expect(seedsOf(provider)).toEqual([11, 12, 13, 14]);
    expect(ENRICH_SEED_RETRIES).toBe(3);
  });

  it('retries a SCHEMA-invalid answer too — it is the same decode class', async () => {
    const fixture = await makeFixture(['a']);
    const provider = fakeProvider((req: ChatRequest): ChatOutcome =>
      req.seed === ENRICH_SEED ? { ok: true, value: { short: 'only one field' } } : { ok: true, value: FIELDS }
    );
    const report = await enrichAtoms({ ...fixture, provider });
    expect(report).toMatchObject({ enriched: 1, retried: 1 });
    expect(provider.requests.length).toBe(2);
  });

  it('REFUSES a transport failure immediately — an outage MUST NOT be retried 4x', async () => {
    const fixture = await makeFixture(['a']);
    const provider = fakeProvider(
      (): ChatOutcome => ({ ok: false, error: 'server down: ECONNREFUSED', kind: 'transport' })
    );
    const report = await enrichAtoms({ ...fixture, provider });
    expect(provider.requests.length).toBe(1);
    expect(report).toMatchObject({ enriched: 0, retried: 0, failure: 'server down: ECONNREFUSED' });
  });

  it('exhausts the ladder, then refuses with the existing message plus the seeds tried', async () => {
    const fixture = await makeFixture(['a']);
    const provider = fakeProvider(() => ({ ok: false, error: 'response_format was not honoured', kind: 'decode' }));
    const report = await enrichAtoms({ ...fixture, provider });
    expect(provider.requests.length).toBe(ENRICH_SEED_RETRIES + 1);
    expect(report.failure).toContain('response_format was not honoured');
    expect(report.failure).toContain('4 seeds');
    expect(report.failure).toContain('11, 12, 13, 14');
    expect(loadEnrichmentSidecar(fixture.sidecarPath).size).toBe(0);
  });

  it('leaves an atom that decodes at the BASE seed byte-identical — one call, no note', async () => {
    const fixture = await makeFixture(['a', 'b']);
    const provider = fakeProvider(answersWith(FIELDS));
    const report = await enrichAtoms({ ...fixture, provider });
    expect(seedsOf(provider)).toEqual([ENRICH_SEED, ENRICH_SEED]);
    expect(report).toMatchObject({ enriched: 2, retried: 0, retriedIds: [] });
  });
});
