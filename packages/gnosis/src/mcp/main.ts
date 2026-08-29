#!/usr/bin/env node
/**
 * Process binding for the MCP server. Hands the real streams to `serveStdio`
 * and nothing else: no parsing, no formatting, no exit code — the session ends
 * when stdin closes, which is what an MCP client expects of a stdio server.
 *
 * The shebang is REQUIRED, not decorative: this file is a `bin` target
 * (`dp-gnosis-mcp`), and npm symlinks a bin rather than wrapping it, so an
 * installed launch execs `dist/mcp/main.js` directly. Without the line the
 * kernel has no interpreter for it and the MCP client sees the server die on
 * launch — `src/cli/main.ts` already carries the same line for the same reason.
 */
import { serveStdio } from './server.js';

serveStdio({ input: process.stdin, output: process.stdout });
