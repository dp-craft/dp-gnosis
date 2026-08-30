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
 * Sizes are EXACT byte counts, read from the two repository trees on 2026-08-30
 * (`https://huggingface.co/api/models/gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp/tree/main`
 * and `https://huggingface.co/api/models/Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp/tree/main`),
 * replacing decimal-GB figures that had been scaled by `GIB` and so overstated
 * every displayed download by about 7%. They are still used for ONE purpose
 * only: the disk warning shown before a multi-gigabyte download starts. The
 * download itself never reads them — it resolves the true size from the tree.
 *
 * The quantisation list per model is CURATED, not the repository's listing: each
 * of the two repositories publishes nine GGUFs (HF tree API, read 2026-08-30 —
 * `https://huggingface.co/api/models/Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp/tree/main`
 * and `https://huggingface.co/api/models/gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp/tree/main`).
 *
 * `Q2_K` is excluded for the 0.6B BY MEASUREMENT. The publisher's own table
 * measures 0.6B Q2_K at -28.7% nDCG@10 against F16 (0.4770 vs 0.6688) on MTEB
 * AskUbuntuDupQuestions, 361 queries, one RTX 3090, every quant cut from the one
 * F16 source — `https://huggingface.co/Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp`.
 * The rule it fails: keep a quant only if it beats NO reranker at all. No
 * published score exists for not reranking on that task, so Q2_K could not be
 * shown to beat gnosis's own BM25 first-pass order — which is what "no reranker"
 * means here; it beats only a computed random-shuffle estimate (~0.41). And it
 * would still PASS `rerankHealth`: 0.4770 sits far above the ~4.5e-23 garbage
 * floor that probe detects, so it would load, discriminate, exit 0 and rank
 * badly forever — `GNOSIS-RULES.md` § The failure class, again.
 *
 * The exclusion is model-SPECIFIC, not a blanket rule: the same table measures 4B
 * Q2_K at -4.5% (0.6691 vs 0.7003 F16 —
 * `https://huggingface.co/gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp`), so the 4B
 * tolerates quantisation far better than the 0.6B does. Both figures come from a
 * single uploader's model card, not a reproduced study; the caveats are recorded
 * in `docs/research/2026-08-30-1140-qwen3-reranker-quantisation-evidence.md`.
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
    { label: 'Q4_K_M', approxBytes: 2_496_717_344, note: 'smallest working 4B; fits a tighter card' },
    { label: 'Q8_0', approxBytes: 4_279_678_912, note: 'the balanced choice' },
    { label: 'F16', approxBytes: 8_049_922_912, note: 'unquantised; costs the most for the least gain' },
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
    { label: 'Q4_K_M', approxBytes: 396_476_288, note: 'the smallest quantisation measured to leave this model\'s ranking essentially intact' },
    { label: 'Q8_0', approxBytes: 639_153_344, note: 'the balanced choice' },
    { label: 'F16', approxBytes: 1_197_634_304, note: 'unquantised' },
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
