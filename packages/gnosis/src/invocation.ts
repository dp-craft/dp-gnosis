import { isInstalled } from './paths.js';

/**
 * Sole owner of the answer to "how does THIS caller invoke gnosis". A refusal
 * whose whole purpose is its remedy defeats itself by naming a command the
 * reader cannot run, and that is exactly what a hardcoded repo npm script does
 * once the package is installed: `npm run gnosis` exists only inside this
 * checkout. The evidence is the same one `isInstalled` already decides on — the
 * package's own location — so the remedy follows the caller with no new flag,
 * no environment variable and nothing for a user to get wrong.
 */

/** `package.json`'s `bin` key — what an install puts on PATH. */
const INSTALLED_INVOCATION = 'dp-gnosis';

/** A checkout has no `bin` on PATH; it goes through the repo script. */
const CHECKOUT_INVOCATION = 'npm run gnosis --';

export const cliInvocation = (installed: boolean = isInstalled()): string =>
  installed ? INSTALLED_INVOCATION : CHECKOUT_INVOCATION;

/**
 * The index-build command, spelled ONCE for every refusal that names it. Two
 * refusals in two modules quote it, and a second spelling is a second thing to
 * forget when the CLI is renamed again.
 */
export const ingestCommand = (installed: boolean = isInstalled()): string =>
  `${cliInvocation(installed)} ingest`;

export const indexRebuildCommand = (
  adapter: string,
  installed: boolean = isInstalled()
): string => `${cliInvocation(installed)} index --adapter ${adapter}`;
