#!/usr/bin/env node
/**
 * Process binding for the CLI. Adapts the values `runCli` returns to the real
 * process: writes the streams, sets the exit code. No parsing, no formatting.
 */
import { runCli } from './cli.js';

const write = (stream: NodeJS.WriteStream, content: string): void => {
  if (content.length > 0) {
    stream.write(content);
  }
};

const main = async (): Promise<void> => {
  const result = await runCli(process.argv.slice(2));
  write(process.stdout, result.stdout);
  write(process.stderr, result.stderr);
  process.exitCode = result.exitCode;
};

await main();
