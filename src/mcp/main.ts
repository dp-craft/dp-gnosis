/**
 * Process binding for the MCP server. Hands the real streams to `serveStdio`
 * and nothing else: no parsing, no formatting, no exit code — the session ends
 * when stdin closes, which is what an MCP client expects of a stdio server.
 */
import { serveStdio } from './server.js';

serveStdio({ input: process.stdin, output: process.stdout });
