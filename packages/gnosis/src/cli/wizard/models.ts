/**
 * The reranker GGUF catalogue — which published repository actually carries a
 * working rank head, and which one does not.
 *
 * It exists as CODE rather than as prose because the wizard has to REFUSE the
 * broken repositories by name. `OPTIONAL.md` § Which GGUF records why: most
 * published Qwen3-Reranker GGUFs are missing `cls.output.weight`, the
 * `[hidden, 2]` yes/no head whose softmax is the score. Without it the server
 * answers HTTP 200, the numbers parse as floats around 4.5e-23, and the run
 * records them as data — `GNOSIS-RULES.md` § The failure class, exactly. A
 * wizard that downloaded one would spend gigabytes configuring a reranker that
 * ranks nothing while every later run exits 0.
 *
 * No FILE NAME is written here, only a repository and a quantisation LABEL.
 * The file is resolved by listing the repository's own tree at download time,
 * so a repository that renames or re-quantises a file cannot leave this table
 * naming a path that 404s — and a name stated from memory is exactly what
 * `GNOSIS-RULES.md` § Volatile facts forbids.
 *
 * Sizes are the ones `OPTIONAL.md` records, kept as APPROXIMATE bytes for one
 * purpose only: warning about disk before a multi-gigabyte download starts. The
 * true size comes from the repository tree.
 */
import { RERANK_MODEL_ID } from '../../config.js';

/** The id `RERANK_MODEL_ID` names — the measured champion and the shipped default. */
export const QUALITY_MODEL_ID = RERANK_MODEL_ID;

/** The cheap alternative, verified rank head. */
export const FAST_MODEL_ID = 'qwen3-reranker-0.6b';

/** One gibibyte. Exported so a size is formatted against the same unit it was stated in. */
export const GIB = 1024 ** 3;

/** One quantisation a working repository publishes. */
export interface Quant {
  /** The label that appears in the file name, e.g. `Q8_0`. */
  readonly label: string;
  /** Roughly what it costs on disk. The tree listing is what the download trusts. */
  readonly approxBytes: number;
  /** What the wizard says about the tradeoff, in one clause. */
  readonly note: string;
}

/** A published GGUF repository and this project's verdict on it. */
export interface RerankerModel {
  /** The id the server must serve it under — what gnosis asks `/v1/models` for. */
  readonly servedId: string;
  /** The Hugging Face repository. */
  readonly repo: string;
  /** How the wizard names it in a menu. */
  readonly title: string;
  /** The qualitative case for and against, routed rather than quoted. */
  readonly pro: string;
  readonly con: string;
  /** Free VRAM at or above which this model is the recommendation. */
  readonly vramFloorBytes: number;
  /** Total RAM at or above which it is recommendable with no GPU at all. */
  readonly ramFloorBytes: number;
  readonly quants: readonly Quant[];
}

/**
 * The two repositories `OPTIONAL.md` verifies as WORKING — both converted with
 * the official `convert_hf_to_gguf.py`, both carrying `cls.output.weight`.
 *
 * The 4B is FIRST because it is what `RERANK_MODEL_ID` names and what every
 * recorded baseline was measured with. `setupCommand.ts:orderShippedFirst`
 * makes the same choice for the same reason.
 */
/*
 * eslint-disable no-magic-numbers --
 * Every number below is DATA, not a threshold: the published file sizes and the
 * hardware floors ARE the catalogue. Naming each one would produce a constant
 * per cell, read once, which hides the table rather than explaining it.
 */
const QUALITY_MODEL: RerankerModel = {
  servedId: QUALITY_MODEL_ID,
  repo: 'gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp',
  title: 'Qwen3-Reranker-4B — the quality reranker',
  pro: 'the measured champion and the shipped default; every recorded baseline in handbook/GNOSIS-BASELINES.md was measured at this model',
  con: 'the slower of the two, and the larger download',
  vramFloorBytes: 8 * GIB,
  ramFloorBytes: 16 * GIB,
  quants: [
    { label: 'Q4_K_M', approxBytes: Math.round(2.5 * GIB), note: 'smallest working 4B; fits a tighter card' },
    { label: 'Q8_0', approxBytes: Math.round(4.28 * GIB), note: 'the balanced choice' },
    { label: 'F16', approxBytes: Math.round(8.05 * GIB), note: 'unquantised; costs the most for the least gain' },
  ],
};

const FAST_MODEL: RerankerModel = {
  servedId: FAST_MODEL_ID,
  repo: 'Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp',
  title: 'Qwen3-Reranker-0.6B — the fast reranker',
  pro: 'markedly faster than the 4B and a much smaller download; the verified cheap alternative',
  con: 'measurably worse ordering on English than the 4B; nothing either way on Hungarian (figures: handbook/GNOSIS-BASELINES.md)',
  vramFloorBytes: 2 * GIB,
  ramFloorBytes: 4 * GIB,
  quants: [
    { label: 'Q2_K', approxBytes: Math.round(0.29 * GIB), note: 'smallest that runs' },
    { label: 'Q8_0', approxBytes: Math.round(0.8 * GIB), note: 'the balanced choice' },
    { label: 'F16', approxBytes: Math.round(1.2 * GIB), note: 'unquantised' },
  ],
};

/** Both verified repositories, quality first — the shipped id leads for the reason above. */
export const WORKING_MODELS: readonly RerankerModel[] = [QUALITY_MODEL, FAST_MODEL];

/** The model this machine's hardware argues for — a RECOMMENDATION, never a pick. */
export const recommendedModel = (
  vramBytes: number | undefined,
  totalRamBytes: number
): RerankerModel => {
  if (vramBytes !== undefined) return vramBytes >= QUALITY_MODEL.vramFloorBytes ? QUALITY_MODEL : FAST_MODEL;
  return totalRamBytes >= QUALITY_MODEL.ramFloorBytes ? QUALITY_MODEL : FAST_MODEL;
};

/** The quantisation a given free-disk figure argues for within one model. */
/** The label of the quantisation each model treats as its balanced choice. */
const BALANCED_QUANT = 'Q8_0';

/**
 * The quantisation a given free-disk figure argues for within one model. A
 * gigabyte of headroom is kept back: a download that exactly fills the disk
 * leaves no room for the atoms and the index this same wizard is about to build.
 */
export const recommendedQuant = (model: RerankerModel, freeDiskBytes: number | undefined): Quant => {
  const smallest = model.quants.reduce((best, quant) => (quant.approxBytes < best.approxBytes ? quant : best));
  const balanced = model.quants.find(quant => quant.label === BALANCED_QUANT) ?? smallest;
  if (freeDiskBytes === undefined) return balanced;
  const headroom = freeDiskBytes - GIB;
  return balanced.approxBytes <= headroom
    ? balanced
    : model.quants.find(quant => quant.approxBytes <= headroom) ?? smallest;
};
