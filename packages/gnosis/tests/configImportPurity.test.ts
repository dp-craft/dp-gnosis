/**
 * `config.ts` opens with "PURE: nothing here reads the filesystem ... at import
 * time". That claim was FALSE transitively until 2026-08-31: `paths.ts` carried
 * `INGEST_PROFILE_PATH = ingestProfilePath()`, a module-level constant whose
 * initialiser ran `existsSync(userProfilePath())`, so importing `config.ts`
 * — which every engine module imports — touched the disk before a single
 * function was called.
 *
 * The guard is DYNAMIC rather than a grep over `paths.ts`: the offending call
 * sat one module away from the file whose docblock makes the claim, so a
 * static scan of `config.ts` would have seen nothing, and a static scan of
 * `paths.ts` would have to re-implement "is this expression evaluated at module
 * scope". Mocking `node:fs` and importing the module graph fresh asks the
 * question directly, transitively, and of whatever the graph grows into.
 */
import type * as NodeFs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe('config.ts import-time purity', () => {
  it('reads no file while its module graph loads', async () => {
    vi.resetModules();
    vi.mocked(existsSync).mockClear();
    vi.mocked(readFileSync).mockClear();

    await import('../src/config.js');

    expect(vi.mocked(existsSync).mock.calls).toEqual([]);
    expect(vi.mocked(readFileSync).mock.calls).toEqual([]);
  });
});
