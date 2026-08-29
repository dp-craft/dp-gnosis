/**
 * A refusal's remedy is only worth its words if the caller can RUN it. An
 * installed package has `dp-gnosis` on PATH and no `npm run gnosis` anywhere; a
 * development checkout has exactly the reverse. The command named MUST follow
 * the caller, so both branches are pinned here against `isInstalled`'s own
 * evidence — the package's location — never against a real `node_modules` tree.
 */
import { describe, expect, it } from 'vitest';

import { cliInvocation, indexRebuildCommand, ingestCommand } from '../src/invocation.js';
import { isInstalled } from '../src/paths.js';

const INSTALLED_DIR = '/home/u/proj/node_modules/dp-gnosis/dist';
const CHECKOUT_DIR = '/home/u/dp-gnosis/packages/gnosis/src';

describe('cliInvocation — the command the CALLER actually has', () => {
  it('names the bin when the package sits in node_modules', () => {
    expect(cliInvocation(isInstalled(INSTALLED_DIR))).toBe('dp-gnosis');
  });

  it('names the repo script from a development checkout', () => {
    expect(cliInvocation(isInstalled(CHECKOUT_DIR))).toBe('npm run gnosis --');
  });
});

describe('indexRebuildCommand — the remedy both refusals are built from', () => {
  it('is runnable by an installed caller', () => {
    expect(indexRebuildCommand('fts5', isInstalled(INSTALLED_DIR))).toBe(
      'dp-gnosis index --adapter fts5'
    );
  });

  it('is unchanged for a checkout, so every recorded refusal text stands', () => {
    expect(indexRebuildCommand('fts5', isInstalled(CHECKOUT_DIR))).toBe(
      'npm run gnosis -- index --adapter fts5'
    );
  });

  it('carries the adapter it was asked about', () => {
    expect(indexRebuildCommand('lancedb', true)).toBe('dp-gnosis index --adapter lancedb');
  });
});

describe('ingestCommand — the other half of the same sentence', () => {
  it('is runnable by an installed caller', () => {
    expect(ingestCommand(isInstalled(INSTALLED_DIR))).toBe('dp-gnosis ingest');
  });

  it('names the repo script from a development checkout', () => {
    expect(ingestCommand(isInstalled(CHECKOUT_DIR))).toBe('npm run gnosis -- ingest');
  });

  it('agrees with the index remedy it shares a note with', () => {
    expect(ingestCommand(true).startsWith(cliInvocation(true))).toBe(true);
    expect(indexRebuildCommand('fts5', true).startsWith(cliInvocation(true))).toBe(true);
  });
});
