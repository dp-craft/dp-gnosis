/**
 * The CLI's PRESENTATION of the stale-build fact: a `CommandOutcome` the
 * renderer in `cli.ts` prints like any other result.
 *
 * The fact itself — is this build older than its source, and which two files
 * say so — lives in `../buildFreshness.ts`, because the MCP bin needs the same
 * answer and a helper with consumers in two modules belongs above both. What
 * stays here is exactly what is CLI-shaped: the `CommandOutcome` vocabulary and
 * the `--json` payload. Folding either into the shared module would give it a
 * second responsibility and a dependency on `cli/outcome.ts`'s TYPES.
 *
 * The shared module does take the exit-code CONSTANT from `cli/outcome.ts`, so
 * there IS a transitive edge from `mcp/` into `cli/`. It is a deliberate
 * concession, not an oversight: `outcome.ts` owns the exit-code vocabulary and
 * imports nothing itself, so no cycle results and the dependency is one
 * constant wide.
 *
 * The no-op conditions, the timestamp choice and the history are documented at
 * the fact — this file re-states none of them.
 */
import type { BuildSite, StaleBuild } from '../buildFreshness.js';
import { STALE_BUILD_EXIT, staleBuild, staleBuildMessage } from '../buildFreshness.js';
import type { CommandOutcome } from './outcome.js';

export type { BuildSite };

const refusal = (stale: StaleBuild): CommandOutcome => ({
  exitCode: STALE_BUILD_EXIT,
  data: {
    error: staleBuildMessage(stale),
    build: stale.build.path,
    buildMtime: stale.build.iso,
    newestSource: stale.source.path,
    newestSourceMtime: stale.source.iso,
  },
  text: staleBuildMessage(stale),
});

/**
 * The refusal to serve a stale build, or `undefined` when the build is fresh,
 * not compiled, installed, or unreadable. `site` is a parameter so a test can
 * point the check at a temp fixture with authored mtimes instead of depending
 * on the working tree's.
 */
export const staleBuildRefusal = (site?: BuildSite): CommandOutcome | undefined => {
  const stale = staleBuild(site);
  return stale === undefined ? undefined : refusal(stale);
};
