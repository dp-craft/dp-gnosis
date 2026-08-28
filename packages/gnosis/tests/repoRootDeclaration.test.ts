/**
 * An INSTALLED package has no repository to resolve a relative path against.
 * The location resolver fell back to a `REPO_ROOT` frozen at module load, which
 * an install resolves inside `node_modules` — so a relative `corpusRoot` or
 * `summarySidecar` pointed at the package's own tree, and the run either
 * refused with a bewildering path or, where every root was absolute, carried a
 * base nothing had stated.
 *
 * The rule under test is that dp-gnosis MUST NOT pick that base for the user.
 * It refuses and names both ways to state one — early, on the command itself,
 * so the message IS the diagnosis rather than something to reach by ingesting.
 */
import type { IngestProfile } from '../src/ingestProfile.js';
import { repoRootRefusal, undeclaredRepoRoot } from '../src/cli/locations.js';
import { runCli } from '../src/cli/cli.js';
import { activeProfile } from '../src/vocabulary.js';

const CHECKOUT = false;
const INSTALLED = true;

const profileWith = (repoRoot?: string): IngestProfile => ({
  ...activeProfile(),
  ...(repoRoot === undefined ? {} : { repoRoot }),
});

describe('undeclaredRepoRoot', () => {
  it('is true only when INSTALLED and neither the flag nor the profile states one', () => {
    expect(undeclaredRepoRoot({}, profileWith(), INSTALLED)).toBe(true);
  });

  it('is false when the flag states one', () => {
    expect(undeclaredRepoRoot({ '--repo-root': '/srv/vault' }, profileWith(), INSTALLED)).toBe(
      false
    );
  });

  it('is false when the profile declares one — what init writes', () => {
    expect(undeclaredRepoRoot({}, profileWith('/srv/vault'), INSTALLED)).toBe(false);
  });

  /**
   * The whole development and benchmark path. A checkout HAS a repository, so
   * `repoRoot()` is a fact there rather than a guess, and every recorded run
   * resolved through it.
   */
  it('is false in a CHECKOUT, whatever is declared', () => {
    expect(undeclaredRepoRoot({}, profileWith(), CHECKOUT)).toBe(false);
  });
});

describe('repoRootRefusal', () => {
  it('names BOTH ways to state one, and the command that writes it', () => {
    const message = repoRootRefusal();
    expect(message).toContain('--repo-root');
    expect(message).toContain('repoRoot');
    expect(message).toContain('init');
  });
});

/**
 * The guard is only worth having if it cannot fire where a repository exists.
 * This suite runs from a checkout, so every command below MUST reach its own
 * outcome rather than this refusal.
 *
 * The command below carries no query on purpose, and MUST NOT be "repaired"
 * into a real retrieve. The assertion is a negative, so nothing has to be
 * retrieved for it to discriminate: `outcomeFor` dispatches through
 * `withContext`, which calls `buildContext` — where the repoRoot check lives —
 * before any handler runs, and the missing-query message is raised downstream
 * of it in `retrieveCommand.ts`. That ordering is proven rather than assumed,
 * because a query-less `retrieve --profile /nonexistent/x.json` fails with the
 * profile error that `buildContext` itself raises. So the run exits on the
 * missing query having already passed the guard, and were the guard to fire in
 * a checkout its refusal would be on stderr and this test would fail. A real
 * retrieve costs seconds against a five-second timeout; this costs
 * milliseconds.
 */
describe('the CLI in a checkout', () => {
  it('does NOT refuse a command for an undeclared repoRoot', async () => {
    const result = await runCli(['retrieve']);
    expect(result.stderr).not.toContain('--repo-root');
  });
});
