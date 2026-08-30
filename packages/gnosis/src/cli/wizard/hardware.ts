/**
 * The machine's facts, read once so the wizard can RECOMMEND a reranker model
 * instead of guessing one.
 *
 * Everything here is a fact the wizard is allowed to state — RAM, free disk on
 * the path the model would land in, and VRAM when a GPU actually answers. The
 * model verdict itself is NOT this module's business: it reads, it does not
 * decide. That split is what keeps the recommendation rules pure and testable.
 *
 * **Nothing here throws and nothing here hangs.** A wizard is an interactive
 * session with a person waiting at a prompt, so an absent `nvidia-smi`, a
 * `statfs` refused by the platform, or a driver that blocks forever must each
 * degrade to `undefined` rather than take the session down. `undefined` is a
 * first-class answer: "this was not knowable here", which the recommendation
 * layer reads as "do not use this axis", not as zero. Reporting a missing GPU
 * as `0` bytes would be a component producing nothing and the pipeline
 * recording it as data — `handbook/GNOSIS-RULES.md` § The failure class.
 *
 * The disk read walks UP to the nearest existing ancestor because the wizard
 * asks about a data root that does not exist yet; `statfs` on a path that is
 * about to be created answers ENOENT, and the free space of its parent is the
 * number the user actually needs.
 */

import { execFile } from 'node:child_process';
import { access, statfs } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** What `nvidia-smi` is asked for, and how long it is given to answer. */
const NVIDIA_SMI = 'nvidia-smi';
const NVIDIA_SMI_ARGS: readonly string[] = ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'];
const GPU_QUERY_TIMEOUT_MS = 3_000;

/** `nounits` makes the memory column MiB, so this is the only conversion. */
const BYTES_PER_MIB = 1024 * 1024;

/** What this machine can be told about itself. `undefined` means "not knowable here". */
export interface HardwareFacts {
  readonly totalRamBytes: number;
  readonly freeDiskBytes: number | undefined;
  readonly vramBytes: number | undefined;
  readonly gpuName: string | undefined;
}

interface GpuFacts {
  readonly vramBytes: number;
  readonly gpuName: string;
}

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** The deepest ancestor of `path` that is actually on disk — `undefined` at the root. */
const nearestExisting = async (path: string): Promise<string | undefined> => {
  const parent = dirname(path);
  if (await exists(path)) return path;
  return parent === path ? undefined : nearestExisting(parent);
};

const freeBytesAt = async (path: string): Promise<number | undefined> => {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
};

/** Free bytes on the filesystem that would hold `diskPath`. Never throws. */
export const readFreeDisk = async (diskPath: string): Promise<number | undefined> => {
  const target = await nearestExisting(resolve(diskPath));
  return target === undefined ? undefined : freeBytesAt(target);
};

const positiveNumber = (field: string | undefined): number | undefined => {
  const value = Number(field);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** The first CSV row of the query, or `undefined` when it is not the shape asked for. */
const parseGpuRow = (stdout: string): GpuFacts | undefined => {
  const fields = (stdout.split('\n')[0] ?? '').split(',').map(field => field.trim());
  const name = fields[0];
  const mib = positiveNumber(fields[1]);
  return name === undefined || name.length === 0 || mib === undefined
    ? undefined
    : { gpuName: name, vramBytes: mib * BYTES_PER_MIB };
};

/** Binary absent, non-zero exit, timeout, unparseable output — all the same answer. */
const readGpu = async (): Promise<GpuFacts | undefined> => {
  try {
    const { stdout } = await execFileAsync(NVIDIA_SMI, [...NVIDIA_SMI_ARGS], { timeout: GPU_QUERY_TIMEOUT_MS });
    return parseGpuRow(stdout);
  } catch {
    return undefined;
  }
};

/** Every fact the wizard may state about this machine. Never throws. */
export const readHardware = async (diskPath: string): Promise<HardwareFacts> => {
  const [freeDiskBytes, gpu] = await Promise.all([readFreeDisk(diskPath), readGpu()]);
  return {
    totalRamBytes: totalmem(),
    freeDiskBytes,
    vramBytes: gpu?.vramBytes,
    gpuName: gpu?.gpuName,
  };
};
