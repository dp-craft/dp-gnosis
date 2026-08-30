import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHardware } from '../src/cli/wizard/hardware.js';

describe('readHardware', () => {
  it('returns facts for a path that does not exist yet, without throwing', async () => {
    const missing = join(tmpdir(), 'gnosis-wizard-absent', 'not', 'created', 'yet');
    const facts = await readHardware(missing);

    expect(facts.totalRamBytes).toBeGreaterThan(0);
    // The walk-up reaches an existing ancestor, so this is a number here; on a
    // platform whose statfs refuses it is `undefined` — never a throw, never 0.
    expect(facts.freeDiskBytes === undefined || facts.freeDiskBytes > 0).toBe(true);
  });

  it('reports free disk for an existing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnosis-wizard-hw-'));
    try {
      const facts = await readHardware(dir);
      expect(facts.freeDiskBytes === undefined || facts.freeDiskBytes > 0).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the GPU as undefined or as a name AND a size — never one without the other', async () => {
    const facts = await readHardware(tmpdir());
    expect(facts.gpuName === undefined).toBe(facts.vramBytes === undefined);
    if (facts.vramBytes !== undefined) expect(facts.vramBytes).toBeGreaterThan(0);
  });
});
