/**
 * Installing the in-process engine — the one thing the wizard may do about an
 * absent `node-llama-cpp`.
 *
 * The property under test is that an install is never BELIEVED. `npm install`
 * exits 0 having written a package whose native binding then fails to load on
 * this platform, and recording that as "installed" would be this repository's
 * failure class exactly: a component produced nothing and the pipeline wrote it
 * down as success. So every outcome is asserted through what
 * {@link installLocalReranker} REPORTS, not through what npm returned.
 *
 * Nothing here runs npm. The runner is a parameter for the same reason
 * `EngineLoader` is one — the real install fetches hundreds of megabytes, so a
 * suite that used it could exercise exactly one of these four outcomes, on
 * whichever machine it happened to run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { InstallOutcome, InstallRunner, LocalRerankerInstall } from '../src/localReranker.js';
import {
  installLocalReranker,
  LOCAL_RERANKER_INSTALL_COMMAND,
  LOCAL_RERANKER_PACKAGE,
  localRerankerDirectory,
} from '../src/localReranker.js';

/** An engine that loads: the ONE shape `localRerankerAvailability` checks for. */
const engineLoads = async (): Promise<unknown> => ({ getLlama: async (): Promise<unknown> => ({ loadModel: async (): Promise<unknown> => ({}) }) });

/** The consumer's state, and the state an install that wrote nothing usable leaves behind. */
const engineMissing = async (): Promise<unknown> => {
  throw new Error(`Cannot find module '${LOCAL_RERANKER_PACKAGE}'`);
};

const succeeds: InstallRunner = async () => ({ code: 0, stdout: '', stderr: '' });

/** A runner that records where it was asked to run, so the cwd is asserted rather than assumed. */
const recording = (outcome: InstallOutcome): { readonly run: InstallRunner; readonly seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    run: async cwd => {
      seen.push(cwd);
      return outcome;
    },
  };
};

const reasonOf = (result: LocalRerankerInstall): string => {
  if (result.installed) throw new Error('expected a refusal, got an install reported as done');
  return result.reason;
};

describe('localRerankerDirectory', () => {
  /**
   * The engine has to land where THIS package imports from, which is a fact
   * about this file's own location — one level above `src/` in a checkout, one
   * above `dist/` in an install. `process.cwd()` would install into whatever
   * tree the user was standing in, where the import would still fail.
   */
  it('names a real package directory, not the caller shell\'s', () => {
    expect(existsSync(join(localRerankerDirectory(), 'package.json'))).toBe(true);
  });
});

describe('installLocalReranker', () => {
  it('runs the install in the directory the engine is imported from', async () => {
    const runner = recording({ code: 0, stdout: '', stderr: '' });

    await installLocalReranker({ run: runner.run, load: engineLoads });

    expect(runner.seen).toEqual([localRerankerDirectory()]);
  });

  it('reports installed once the engine loads again', async () => {
    const result = await installLocalReranker({ run: succeeds, load: engineLoads });

    expect(result.installed).toBe(true);
  });

  /**
   * The load-bearing one. npm exited 0, so nothing in the install itself says
   * anything is wrong — only the re-probe does, and it is the whole reason this
   * function exists rather than the wizard calling npm and assuming.
   */
  it('reports STILL unavailable when the install exits 0 but the engine does not load', async () => {
    const result = await installLocalReranker({ run: succeeds, load: engineMissing });

    expect(result.installed).toBe(false);
    expect(reasonOf(result)).toContain('exited 0');
    expect(reasonOf(result)).toContain(LOCAL_RERANKER_PACKAGE);
  });

  /**
   * Exit 0 and no engine is the path with NOTHING else to go on: npm reported
   * success, so its own log is the only account of what it actually did. A
   * refusal that drops it hands the user a dead end — which is the failure
   * class this file exists over, one message further along.
   */
  it('carries what npm printed on BOTH streams when it exited 0 and the engine is still missing', async () => {
    const runner = recording({
      code: 0,
      stdout: 'up to date, audited 1 package in 400ms',
      stderr: 'npm warn config omit dev is set',
    });

    const result = await installLocalReranker({ run: runner.run, load: engineMissing });

    expect(result.installed).toBe(false);
    expect(reasonOf(result)).toContain('up to date, audited 1 package in 400ms');
    expect(reasonOf(result)).toContain('npm warn config omit dev is set');
  });

  // npm CAN exit 0 having said nothing at all. Saying so is the honest report;
  // a refusal that trails off after "exited 0, but" reads as truncated output.
  it('says npm printed nothing when it exited 0 silently and the engine is still missing', async () => {
    const result = await installLocalReranker({ run: succeeds, load: engineMissing });

    expect(reasonOf(result)).toContain('printed nothing');
  });

  // A failed install is reported WITH what npm said on stderr. Swallowing it
  // leaves the user with a refusal that names no cause they can act on.
  it('reports a non-zero exit with its stderr, and never as installed', async () => {
    const runner = recording({ code: 127, stdout: '', stderr: 'npm ERR! ENOTFOUND registry.npmjs.org' });

    const result = await installLocalReranker({ run: runner.run, load: engineLoads });

    expect(result.installed).toBe(false);
    expect(reasonOf(result)).toContain('127');
    expect(reasonOf(result)).toContain('ENOTFOUND registry.npmjs.org');
  });

  /**
   * An install into a directory that cannot be written is a refusal, not an
   * attempt: npm would fail deep inside a fetch it already paid for, and the
   * honest answer — the engine stays unavailable here — is known beforehand.
   */
  it('refuses without running anything when the target directory is not writable', async () => {
    const runner = recording({ code: 0, stdout: '', stderr: '' });
    const directory = '/dp-gnosis-no-such-directory/packages/gnosis';

    const result = await installLocalReranker({ run: runner.run, load: engineLoads, directory });

    expect(runner.seen).toEqual([]);
    expect(reasonOf(result)).toContain(directory);
  });

  /**
   * Both flags are load-bearing, and each one prevents a MEASURED failure of
   * the bare `npm install node-llama-cpp` (Node 24 / npm, fake global-install
   * layout, 2026-08-30):
   *
   * - without `--save-prod`, the engine is resolved against this package's
   *   devDependencies entry, so any dev-omitting npm config installs NOTHING
   *   and still exits 0 — the wizard's exit-0-but-missing path, caused by the
   *   install command itself;
   * - without `--omit=dev`, npm reifies the whole devDependency tree, so a
   *   wizard that promised a llama.cpp binary fetched `@lancedb/lancedb` too:
   *   1.9 GB rather than 736 MB.
   */
  it('installs the engine as a prod dependency and omits the dev tree', async () => {
    expect(LOCAL_RERANKER_INSTALL_COMMAND).toContain('--save-prod');
    expect(LOCAL_RERANKER_INSTALL_COMMAND).toContain('--omit=dev');
    expect(LOCAL_RERANKER_INSTALL_COMMAND).toBe('npm install node-llama-cpp --save-prod --omit=dev');
  });

  it('names the command it ran, so the refusal is reproducible by hand', async () => {
    const runner = recording({ code: 1, stdout: '', stderr: 'boom' });

    const result = await installLocalReranker({ run: runner.run, load: engineLoads });

    expect(reasonOf(result)).toContain(LOCAL_RERANKER_INSTALL_COMMAND);
  });
});
