/**
 * `counting.ts` — what one atom COSTS the budget.
 *
 * The charged text is injected, and that is the whole point of this file: a
 * command that renders something other than the body must be charged for what
 * it renders, or it budgets against text it never emits. The other two cases
 * are the refusals that keep a token count from being faked — a probe that does
 * not answer, and an atom the walk never measured.
 */
import { describe, expect, it } from 'vitest';

import { bodyText, byteCounting, resolveCounting } from '../src/cli/counting.js';
import type { RetrievedAtom } from '../src/port.js';
import type { TokenCounter, TokenCountResult } from '../src/tokenize.js';

const atom = (id: string, body: string): RetrievedAtom => ({
  id,
  title: id,
  domain: 'docs',
  type: 'knowledge',
  body,
  score: 1,
  sourcePath: `vault/${id}.md`,
  originPaths: [`doc/${id}.md`],
});

const counter = (
  probe: TokenCountResult,
  count: (text: string) => TokenCountResult
): TokenCounter => ({
  url: 'http://127.0.0.1:9292/upstream/model/tokenize',
  probe: async () => probe,
  count: async (text: string) => count(text),
});

const OK_PROBE: TokenCountResult = { ok: true, count: 1 };

describe('byteCounting', () => {
  it('charges the text ChargedText returns, not the body', async () => {
    const measured = await byteCounting(a => `${a.title}: summary`)([]);
    expect(measured.ok).toBe(true);
    const cost = measured.ok ? measured.measure(atom('a1', 'a much longer body here')) : -1;
    expect(cost).toBe(Buffer.byteLength('a1: summary', 'utf8'));
  });

  it('charges the UTF-8 length of the body under bodyText', async () => {
    const measured = await byteCounting(bodyText)([]);
    const cost = measured.ok ? measured.measure(atom('a1', 'árvíz')) : -1;
    expect(cost).toBe(Buffer.byteLength('árvíz', 'utf8'));
  });
});

describe('resolveCounting', () => {
  it('refuses with the probe reason under tokens', async () => {
    const failing = counter({ ok: false, reason: 'connect ECONNREFUSED' }, () => OK_PROBE);
    const resolved = await resolveCounting('tokens', failing, bodyText);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? '' : resolved.reason).toBe('connect ECONNREFUSED');
  });

  it('charges Infinity for an atom absent from the counted map', async () => {
    const served = counter(OK_PROBE, () => ({ ok: true, count: 7 }));
    const resolved = await resolveCounting('tokens', served, bodyText);
    expect(resolved.ok).toBe(true);
    const measured = resolved.ok ? await resolved.counting([atom('counted', 'body')]) : undefined;
    expect(measured?.ok === true ? measured.measure(atom('counted', 'body')) : -1).toBe(7);
    expect(measured?.ok === true ? measured.measure(atom('absent', 'body')) : -1).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it('counts the charged text rather than the body under tokens', async () => {
    const seen: string[] = [];
    const served = counter(OK_PROBE, text => {
      seen.push(text);
      return { ok: true, count: 3 };
    });
    const resolved = await resolveCounting('tokens', served, a => a.title);
    if (resolved.ok) await resolved.counting([atom('a1', 'the body')]);
    expect(seen).toEqual(['a1']);
  });
});
