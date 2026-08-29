/**
 * The precedence rule, owned ONCE.
 *
 * Five settings now resolve the same way — the reranker's URL, model and
 * backend, and the three chat hop ids — and each of them can be stated in three
 * or four places at the same time. Spelling that order out per setting is how
 * two of them end up disagreeing about whether `config.json` outranks the
 * environment, and the disagreement is invisible: every tier returns a
 * plausible id, so the wrong winner reads exactly like the right one.
 *
 * A resolved value therefore travels WITH the tier that supplied it and with
 * the statements it beat. A value alone cannot say that a `config.json` named
 * another model and lost, which is the state a user who edited the file and saw
 * nothing change is in — and the only thing a diagnostic can report about it.
 */

/** Which tier supplied a resolved setting — the precedence, made readable. */
export type SettingOrigin = 'flag' | 'env' | 'config' | 'default';

/** A resolved setting WITH the tier that supplied it, mirroring `paths.ts:DataRootFact`. */
export interface SettingFact {
  readonly value: string;
  readonly origin: SettingOrigin;
  /** What the environment VARIABLE holds, whether or not it won. */
  readonly stated: string | undefined;
  /** What `config.json` declared, whether or not it won. */
  readonly configured: string | undefined;
}

/**
 * Every statement about one setting, before the precedence is read off them.
 * Generic in the setting's own type so a fact over a CLOSED vocabulary — the
 * rerank backend — keeps that vocabulary instead of widening to `string`.
 */
export interface SettingTiers<T extends string> {
  readonly explicit: T | undefined;
  readonly stated: T | undefined;
  readonly configured: T | undefined;
  readonly fallback: T;
}

/** `flag > env > config.json > constant`, stated once for every caller. */
export const factOf = <T extends string>(
  tiers: SettingTiers<T>
): SettingFact & { readonly value: T } => {
  const { stated, configured } = tiers;
  if (tiers.explicit !== undefined) {
    return { value: tiers.explicit, origin: 'flag', stated, configured };
  }
  if (stated !== undefined) return { value: stated, origin: 'env', stated, configured };
  if (configured !== undefined) return { value: configured, origin: 'config', stated, configured };
  return { value: tiers.fallback, origin: 'default', stated, configured };
};
