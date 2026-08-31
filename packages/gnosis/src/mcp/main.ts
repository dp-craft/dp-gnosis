#!/usr/bin/env node
/**
 * Process binding for the MCP server. Hands the real streams to `serveStdio`
 * and nothing else: no parsing, no formatting, no exit code — the session ends
 * when stdin closes, which is what an MCP client expects of a stdio server.
 *
 * The ONE thing decided before that: a compiled build older than `src/` must
 * not serve. The CLI refuses the same condition, and this bin is the more
 * dangerous half — no human reads an MCP session, so a stale server answers
 * with behaviour the source already changed and nobody ever sees it. The
 * verdict, the wording and the exit code all come from `staleBuildDiagnostic`
 * (`../buildFreshness.ts`), which is where they are testable; this file only
 * binds them to the process. It writes to STDERR, never stdout — stdout is the
 * protocol stream, and one stray line corrupts the session (`server.ts`).
 * Every no-op case of the guard is a normal start, so `tsx`, an installed tree
 * and any unreadable tree all serve exactly as before.
 *
 * The shebang is REQUIRED, not decorative: this file is a `bin` target
 * (`dp-gnosis-mcp`), and npm symlinks a bin rather than wrapping it, so an
 * installed launch execs `dist/mcp/main.js` directly. Without the line the
 * kernel has no interpreter for it and the MCP client sees the server die on
 * launch — `src/cli/main.ts` already carries the same line for the same reason.
 */
import { staleBuildDiagnostic } from '../buildFreshness.js';
import { serveStdio } from './server.js';

const stale = staleBuildDiagnostic();

if (stale === undefined) {
  serveStdio({ input: process.stdin, output: process.stdout });
} else {
  process.stderr.write(`${stale.message}\n`);
  process.exit(stale.exitCode);
}
