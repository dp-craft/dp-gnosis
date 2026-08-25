/**
 * The FIXED probe set for the T2.1 corpus-hygiene acceptance. The file is data,
 * so this test guards the only properties a reader depends on: it parses, it
 * carries the seven verbatim-recoverable queries, its ids are unique, and no
 * query is empty. The probes are NOT run here — an acceptance run needs a built
 * index, and this suite MUST NOT touch the shared vault.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface Probe {
  readonly id: string;
  readonly query: string;
  readonly k: number;
  readonly source: string;
  readonly observes: string;
}

interface ProbeSet {
  readonly version: string;
  readonly probes: readonly Probe[];
}

const PROBES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'probes.v1.json');

const probeSet = (): ProbeSet => JSON.parse(readFileSync(PROBES_PATH, 'utf8')) as ProbeSet;

describe('golden/probes.v1.json', () => {
  it('parses and declares its version', () => {
    expect(probeSet().version).toBe('v1');
  });

  it('carries the seven queries recoverable verbatim from the consumer review', () => {
    expect(probeSet().probes).toHaveLength(7);
  });

  it('gives every probe a unique id, a non-empty query and a positive k', () => {
    const probes = probeSet().probes;
    expect(new Set(probes.map(probe => probe.id)).size).toBe(probes.length);
    expect(probes.every(probe => probe.query.trim().length > 0)).toBe(true);
    expect(probes.every(probe => Number.isInteger(probe.k) && probe.k > 0)).toBe(true);
  });

  it('names the source line every query was quoted from', () => {
    expect(probeSet().probes.every(probe => probe.source.includes('consumer-integration-review.md:'))).toBe(true);
  });
});
