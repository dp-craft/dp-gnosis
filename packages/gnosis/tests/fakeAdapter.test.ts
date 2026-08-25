import { createFakeAdapter } from '../src/adapters/fakeAdapter.js';
import type { RetrievedAtom } from '../src/port.js';

const atom = (id: string, domain: RetrievedAtom['domain'], score: number): RetrievedAtom => ({
  id,
  title: `title-${id}`,
  domain,
  type: 'knowledge',
  body: `body-${id}`,
  score,
  sourcePath: `RUNNER-${id}.md`,
  originPaths: [`doc/RUNNER-${id}.md`],
});

const RUNNER_A = atom('a', 'runner', 0.9);
const RUNNER_B = atom('b', 'runner', 0.5);
const STANDARDS_C = atom('c', 'standards', 0.7);

describe('createFakeAdapter', () => {
  it('names itself unmistakably', () => {
    expect(createFakeAdapter([]).name).toBe('fake');
  });

  it('returns the configured atoms in the configured order', async () => {
    const result = await createFakeAdapter([RUNNER_B, RUNNER_A]).retrieve('q', { k: 10 });

    expect(result.atoms).toEqual([RUNNER_B, RUNNER_A]);
  });

  it('returns an identical result for two completely different queries', async () => {
    const port = createFakeAdapter([RUNNER_A, RUNNER_B]);

    const first = await port.retrieve('zustand selector stability', { k: 10 });
    const second = await port.retrieve('sqlite fts5 bm25 ranking', { k: 10 });

    expect(first).toEqual(second);
  });

  it('truncates to k when more atoms are configured', async () => {
    const result = await createFakeAdapter([RUNNER_A, RUNNER_B, STANDARDS_C]).retrieve('q', {
      k: 2,
    });

    expect(result.atoms).toEqual([RUNNER_A, RUNNER_B]);
  });

  it('returns fewer than k without padding', async () => {
    const result = await createFakeAdapter([RUNNER_A]).retrieve('q', { k: 5 });

    expect(result.atoms).toEqual([RUNNER_A]);
  });

  it('excludes foreign-domain atoms when a domain filter is set', async () => {
    const result = await createFakeAdapter([RUNNER_A, STANDARDS_C, RUNNER_B]).retrieve('q', {
      k: 10,
      domains: ['standards'],
    });

    expect(result.atoms).toEqual([STANDARDS_C]);
  });

  it('applies the domain filter before truncating to k', async () => {
    const result = await createFakeAdapter([STANDARDS_C, RUNNER_A, RUNNER_B]).retrieve('q', {
      k: 2,
      domains: ['runner'],
    });

    expect(result.atoms).toEqual([RUNNER_A, RUNNER_B]);
  });

  it('echoes the configured indexState back', async () => {
    const result = await createFakeAdapter([], 'stale').retrieve('q', { k: 1 });

    expect(result.indexState).toBe('stale');
  });

  it('defaults indexState to ready when not supplied', async () => {
    const result = await createFakeAdapter([]).retrieve('q', { k: 1 });

    expect(result.indexState).toBe('ready');
  });
});
