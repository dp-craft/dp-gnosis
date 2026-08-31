/**
 * The wizard's SECOND reranker route: a downloaded GGUF served by llama.cpp
 * (`backend: 'http'`, the shipped default) or loaded in-process by
 * `node-llama-cpp` (`backend: 'local'`).
 *
 * The two backends produce DIFFERENT config keys, and the difference is a
 * safety property rather than a formatting one — which is why it is asserted
 * here at the pure-plan level, where the whole of it is a function call and
 * nothing has been written yet.
 *
 * Four things are under test: that each backend writes its own keys and only
 * its own; that the calibration key refuses the local engine; that the run-mode
 * menu says what the wizard renders and quotes no figure; and that the real
 * in-process engine actually discriminates on a machine that has the weights.
 */
import { existsSync } from 'node:fs';

import type { RunMode } from '../src/cli/wizard/advice.js';
import { LOCAL_ENGINE_ADVICE, RUN_MODE_CHOICES } from '../src/cli/wizard/advice.js';
import type { PlanLocations, RerankAnswer, WizardAnswers } from '../src/cli/wizard/plan.js';
import { buildPlan } from '../src/cli/wizard/plan.js';
import { RERANK_K_INIT, RERANK_PROBE_MIN_SCORE } from '../src/config.js';
import { resetLocalRerankerCache } from '../src/localReranker.js';
import { rerankCalibrationKey, rerankHealth } from '../src/rerank.js';

const LOCATIONS: PlanLocations = {
  profilePath: '/tmp/gnosis-wizard/profiles/user.profile.json',
  atomsDir: '/tmp/gnosis-wizard/atoms',
  indexPath: '/tmp/gnosis-wizard/index/fts5.db',
  repoRoot: '/tmp/gnosis-wizard',
};

const MODEL_PATH = '/home/dev/models/gguf/rerankers/qwen3-reranker-0.6b-q8_0.gguf';

/**
 * The answers a user gave to everything EXCEPT the reranker, so each test below
 * varies one thing. The corpus root is absolute because a relative one is a
 * refusal, and a refusal would hide whatever the test meant to assert.
 */
const answersWith = (rerank: RerankAnswer | undefined): WizardAnswers => ({
  roots: [{ path: '/tmp/gnosis-wizard/notes', domain: 'notes' }],
  excludePaths: [],
  defaultType: 'knowledge',
  excludedTypes: [],
  analyzer: 'porter-fold',
  adapter: 'fts5',
  prf: false,
  rerank,
});

/** The plan, or a hard failure naming the refusal — an `ok: false` read as a plan asserts nothing. */
const planFor = (rerank: RerankAnswer | undefined): { profile: Readonly<Record<string, unknown>>; configPatch: Readonly<Record<string, unknown>> } => {
  const result = buildPlan(answersWith(rerank), LOCATIONS);
  if (!result.ok) throw new Error(`buildPlan refused these answers: ${result.error}`);
  return { profile: result.plan.profile, configPatch: result.plan.configPatch };
};

const httpAnswer = (poolK: number = RERANK_K_INIT): RerankAnswer => ({
  backend: 'http',
  url: 'http://127.0.0.1:8080',
  model: 'qwen3-reranker-0.6b',
  poolK,
});

const localAnswer = (poolK: number = RERANK_K_INIT): RerankAnswer => ({
  backend: 'local',
  modelPath: MODEL_PATH,
  model: 'qwen3-reranker-0.6b',
  poolK,
});

describe('the plan writes each rerank backend as its own keys', () => {
  it('writes url and model for the served backend, and no backend or modelPath beside them', () => {
    const { configPatch } = planFor(httpAnswer());
    expect(configPatch['rerank']).toEqual({ url: 'http://127.0.0.1:8080', model: 'qwen3-reranker-0.6b' });
  });

  /**
   * The load-bearing one. `RERANK_CALIBRATION` (`src/config.ts`) is keyed by
   * model ID and every entry in it was measured against the SERVED endpoint, so
   * a `rerank.model` written beside `backend: "local"` would let a local raw
   * score be read through a scale nothing measured on this engine — a
   * calibrated-looking probability for a calibration that never happened. The
   * absence of the key is therefore the assertion, not an omission in it.
   */
  it('writes backend and modelPath for the local engine, and MUST NOT write a model id beside them', () => {
    const { configPatch } = planFor(localAnswer());
    const rerank = configPatch['rerank'] as Readonly<Record<string, unknown>>;
    expect(rerank).toEqual({ backend: 'local', modelPath: MODEL_PATH });
    expect(Object.keys(rerank)).not.toContain('model');
  });

  it('writes no rerank key at all when the user declined the reranker', () => {
    const { configPatch } = planFor(undefined);
    expect(Object.keys(configPatch)).not.toContain('rerank');
  });

  /**
   * `rerankPoolK` is a MEASURED constant, so the profile states it only where it
   * differs from the shipped one. Writing the default would pin a value the
   * instance already derives, and a later change to `RERANK_K_INIT` would then
   * move every instance except the ones a wizard configured.
   */
  it.each([
    ['served', httpAnswer],
    ['local', localAnswer],
  ])('omits rerankPoolK on the %s backend when the pool equals the shipped RERANK_K_INIT', (_name, answer) => {
    const { profile } = planFor(answer(RERANK_K_INIT));
    expect(Object.keys(profile)).not.toContain('rerankPoolK');
  });

  it.each([
    ['served', httpAnswer],
    ['local', localAnswer],
  ])('writes rerankPoolK on the %s backend when the pool differs from RERANK_K_INIT', (_name, answer) => {
    const { profile } = planFor(answer(RERANK_K_INIT + 20));
    expect(profile['rerankPoolK']).toBe(RERANK_K_INIT + 20);
  });
});

describe('the calibration key refuses the local engine', () => {
  /**
   * Ranking works under the in-process engine; the PROBABILITY does not. The
   * calibration table is keyed by model ID alone and was measured against the
   * served endpoint, so an inherited key would publish a number computed against
   * a scale nothing measured. With no key, `confidence` reads `weak` and
   * `--min-relevance` refuses — the honest state until a calibration is actually
   * measured against this engine.
   */
  it('returns undefined for the local backend, so no scale is inherited', () => {
    expect(rerankCalibrationKey({ backend: 'local', model: 'qwen3-reranker-0.6b' })).toBeUndefined();
  });

  it('returns the resolved model id for the served backend', () => {
    expect(rerankCalibrationKey({ backend: 'http', model: 'qwen3-reranker-0.6b' })).toBe('qwen3-reranker-0.6b');
  });
});

describe('the run-mode menu', () => {
  it('offers exactly the two run modes', () => {
    expect(RUN_MODE_CHOICES.map(choice => choice.value)).toEqual<RunMode[]>(['served', 'local']);
  });

  it('recommends the served mode, and only that one', () => {
    expect(RUN_MODE_CHOICES.filter(choice => choice.recommended === true).map(choice => choice.value)).toEqual(['served']);
  });

  it.each(RUN_MODE_CHOICES.map(choice => [choice.value, choice] as const))(
    'gives the %s mode a title, a pro and a con — the wizard renders all three',
    (_value, choice) => {
      expect(choice.title.length).toBeGreaterThan(0);
      expect(choice.pro.length).toBeGreaterThan(0);
      expect(choice.con.length).toBeGreaterThan(0);
    }
  );

  /**
   * A figure quoted from one machine forecasts nothing about another, and
   * `handbook/GNOSIS-RULES.md` § Volatile facts records that copied figures rot
   * silently — this repository's own governance files carried three stale ones
   * at once. So the menu stays qualitative: the wizard times the engine on the
   * machine in front of it and shows the user THAT number instead.
   */
  it.each([
    ...RUN_MODE_CHOICES.flatMap(choice => [
      [`the ${choice.value} pro`, choice.pro] as const,
      [`the ${choice.value} con`, choice.con] as const,
    ]),
    ['the gpu advice', LOCAL_ENGINE_ADVICE.gpu] as const,
    ['the cpu advice', LOCAL_ENGINE_ADVICE.cpu] as const,
  ])('quotes no millisecond or nDCG figure in %s', (_name, text) => {
    expect(text).not.toMatch(/\d+\s*ms\b/i);
    expect(text).not.toMatch(/nDCG/i);
    expect(text).not.toMatch(/\bms\/doc\b/i);
  });
});

/**
 * The one test that loads the real engine.
 *
 * It SKIPS rather than fails where the weights are absent: a GGUF is hundreds of
 * megabytes and MUST NOT enter the repository, so a machine without one has
 * nothing to answer here. A green run on such a machine therefore proves less
 * than a green run on this one — which is what the skip line says out loud.
 */
const weightsPresent = existsSync(MODEL_PATH);

describe('the real in-process engine discriminates', () => {
  afterAll(async () => {
    await resetLocalRerankerCache();
  });

  it.skipIf(!weightsPresent)(
    'reports healthy, with the relevant document above the irrelevant one and above the probe floor',
    async () => {
      const health = await rerankHealth({ backend: 'local', modelPath: MODEL_PATH });
      if (health.kind !== 'healthy') throw new Error(`local rerank health was ${health.kind}: ${health.detail}`);
      expect(health.relevantScore).toBeGreaterThan(health.irrelevantScore);
      expect(health.relevantScore).toBeGreaterThan(RERANK_PROBE_MIN_SCORE);
    },
    180_000
  );
});
