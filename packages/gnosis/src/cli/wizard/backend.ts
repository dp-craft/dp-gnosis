/**
 * Detects and drives an ALREADY-INSTALLED llama.cpp or Ollama. It never installs
 * one.
 *
 * That boundary is deliberate: a backend is a platform build and a package
 * manager's business, and a wizard that shelled out to one would own a failure
 * mode it cannot diagnose on a machine it has never seen. So this module reports
 * what is on `PATH`, renders the exact command a human can run, and — when asked
 * — starts it. Rung D of the plan (nothing installed) is a printed instruction,
 * not an attempted install.
 *
 * `SERVE_FLAGS` is ONE named constant because the same flag list is quoted in
 * `packages/gnosis/OPTIONAL.md` § Serving it. Two copies drift, and a drifted
 * `--pooling rank` is not a visible break: the server still answers 200 and the
 * scores still parse. It is the module's whole reason for holding a constant.
 *
 * `startServer` probes the port BEFORE it spawns, and reports `alreadyServing`
 * when something answers there. Spawning first cannot tell the two cases apart:
 * a process that dies with "address in use" still reports a pid, and the
 * readiness poll would then read the PRE-EXISTING server as its own success.
 * Having spawned, it deliberately does NOT wait. A server that is up is not yet
 * a server that discriminates, so "did it work" is `waitForServer` followed by
 * the rerank probe the wizard already owns — a started process is never itself
 * the evidence.
 *
 * Detection walks `process.env.PATH` rather than shelling out to `command -v`:
 * no shell, no quoting question, no dependency, and the same answer.
 *
 * `portTaken` lives here too, with the other port and process concerns, so a
 * caller that must know whether a port can be served asks the module that owns
 * serving — and a test can stub the host fact instead of binding a real port.
 */

import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';

/** The three servers the wizard knows how to talk to. */
export type BackendKind = 'llama-server' | 'llama-swap' | 'ollama';

const BACKEND_KINDS: readonly BackendKind[] = ['llama-server', 'llama-swap', 'ollama'];

/**
 * The reranking flag list, verbatim as `OPTIONAL.md` § Serving it documents it.
 * Whether `--embedding` is implied by `--reranking` is UNVERIFIED there; both
 * working model cards pass all three, so this is what is known to work.
 */
export const SERVE_FLAGS: readonly string[] = ['--reranking', '--pooling', 'rank', '--embedding', '-c', '8192'];

/** How often `waitForServer` re-asks, and where it asks. */
const POLL_INTERVAL_MS = 250;
const MODELS_PATH = '/v1/models';

export interface DetectedBackend {
  readonly kind: BackendKind;
  readonly path: string;
}

export interface ServeCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly rendered: string;
}

/**
 * `pid: undefined` is the third answer, and it is NOT a failure: something else
 * already answers on that address, so nothing was spawned and the caller probes
 * what is there. Reported rather than started over, because a second server on a
 * bound port dies with "address in use" AFTER the spawn has returned a pid —
 * and the readiness poll then reads the OTHER process's HTTP 200 as its own
 * success, which is a component producing nothing recorded as data.
 */
export type StartOutcome =
  | { readonly ok: true; readonly pid: number }
  | { readonly ok: true; readonly pid: undefined; readonly alreadyServing: string }
  | { readonly ok: false; readonly error: string };

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const executableAt = async (path: string): Promise<string | undefined> => {
  try {
    await access(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
};

/** The first `PATH` entry holding an executable of that name. */
const resolveOnPath = async (name: string): Promise<string | undefined> => {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(dir => dir.length > 0);
  const hits = await Promise.all(dirs.map(dir => executableAt(join(dir, name))));
  return hits.find(hit => hit !== undefined);
};

const detectOne = async (kind: BackendKind): Promise<DetectedBackend | undefined> => {
  const path = await resolveOnPath(kind);
  return path === undefined ? undefined : { kind, path };
};

/** Every backend on `PATH`, in the order the wizard offers them. */
export const detectBackends = async (): Promise<readonly DetectedBackend[]> => {
  const found = await Promise.all(BACKEND_KINDS.map(detectOne));
  return found.filter((entry): entry is DetectedBackend => entry !== undefined);
};

/** The serve command, both as argv and as the line the wizard prints. */
export const serveCommand = (modelPath: string, port: number): ServeCommand => {
  const command: BackendKind = 'llama-server';
  const args: readonly string[] = ['-m', modelPath, ...SERVE_FLAGS, '--port', String(port)];
  return { command, args, rendered: [command, ...args].join(' ') };
};

/** The loopback address a wizard-started server binds, and the caller probes. */
export const localBaseUrl = (port: number): string => `http://127.0.0.1:${String(port)}`;

/** The address a wizard-started server binds, and the address the bind probe tests. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Whether a server could BIND that port here — decided by binding it, which is
 * the question actually being asked.
 *
 * It used to be one `GET /v1/models`. Anything that is not an OpenAI-compatible
 * server — a dev server, a llama.cpp that died holding its socket — answers
 * non-200 or refuses the connection, so the port read as free, `spawnServer`
 * returned a pid before llama.cpp died on `bind: address in use`, the wizard
 * printed "started as pid N", and the wait then burned its whole budget before
 * failing with no cause. After a multi-gigabyte download.
 *
 * Any bind error counts as taken, EACCES included: "this process cannot serve
 * there" is the fact the caller needs, and which errno produced it changes
 * nothing about the answer.
 *
 * It is a FACT ABOUT THE HOST, which is why it is exported from here rather
 * than kept private to the interview: a suite that has to decide the answer
 * stubs this module, and binds nothing.
 */
export const portTaken = async (port: number): Promise<boolean> =>
  await new Promise<boolean>(settle => {
    const probe = createServer();
    probe.once('error', () => {
      settle(true);
    });
    probe.listen({ port, host: LOOPBACK_HOST }, () => {
      probe.close(() => {
        settle(false);
      });
    });
  });

const spawnServer = (modelPath: string, port: number, logPath: string): StartOutcome => {
  const { command, args } = serveCommand(modelPath, port);
  try {
    const log = openSync(logPath, 'a');
    const child = spawn(command, [...args], { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    closeSync(log);
    return child.pid === undefined ? { ok: false, error: `${command} did not report a pid` } : { ok: true, pid: child.pid };
  } catch (error: unknown) {
    return { ok: false, error: `could not start ${command}: ${describeError(error)}` };
  }
};

/**
 * Probes the port FIRST, then spawns detached with both streams in `logPath`,
 * and returns without waiting. The probe is `waitForServer` at a zero budget —
 * one readiness call, the same one the caller polls with, so the two can never
 * disagree about what "answering" means.
 */
export const startServer = async (modelPath: string, port: number, logPath: string): Promise<StartOutcome> => {
  const baseUrl = localBaseUrl(port);
  if (await waitForServer(baseUrl, 0)) return { ok: true, pid: undefined, alreadyServing: baseUrl };
  return spawnServer(modelPath, port, logPath);
};

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

const answered = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

const poll = async (url: string, deadline: number): Promise<boolean> => {
  if (await answered(url)) return true;
  if (Date.now() + POLL_INTERVAL_MS >= deadline) return false;
  await delay(POLL_INTERVAL_MS);
  return poll(url, deadline);
};

/** Whether the server answers `GET /v1/models` before the timeout expires. */
export const waitForServer = async (baseUrl: string, timeoutMs: number): Promise<boolean> =>
  poll(`${baseUrl.replace(/\/+$/u, '')}${MODELS_PATH}`, Date.now() + timeoutMs);
