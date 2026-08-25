/**
 * The other side of conformance case 4's process-boundary axis.
 *
 * Not a test file (the suite collects `tests/**\/*.test.ts` only): it is spawned
 * as `node --import tsx conformanceChild.ts <adapter> <atomsDir> <query>`, builds
 * the named adapter from scratch in a FRESH process, and prints
 * `[[id, score], ...]` as JSON on stdout. The parent compares that to its own
 * in-process result, which is what makes byte-stability a claim about the
 * adapter rather than about one process's warm state.
 */
import { CONFORMANCE_ADAPTERS } from './conformance.js';

const [adapterName, atomsDir, query] = process.argv.slice(2);

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const run = async (): Promise<void> => {
  if (adapterName === undefined || atomsDir === undefined || query === undefined) {
    fail('usage: conformanceChild.ts <adapterName> <atomsDir> <query>');
    return;
  }
  const factory = CONFORMANCE_ADAPTERS[adapterName];
  if (factory === undefined) {
    fail(`unknown adapter "${adapterName}"`);
    return;
  }
  const result = await (await factory(atomsDir)).retrieve(query, { k: 10 });
  process.stdout.write(JSON.stringify(result.atoms.map(atom => [atom.id, atom.score])));
};

await run();
