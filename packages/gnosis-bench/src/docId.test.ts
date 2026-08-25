import { describe, expect, it } from 'vitest';

import { assertNoIdCollisions, safeDocId } from './docId.js';

/** The filename rule `corpus.ts:fileNameFor` enforces. */
const FILENAME_SAFE = /^[A-Za-z0-9._-]{1,200}$/;

/** A real `webis-touche2020` id — every one of its 382,545 ids embeds a `:`. */
const TOUCHE_ID = 'c67482ba-2019-04-18T13:32:05Z-00000-000';
const TOUCHE_SAFE = 'c67482ba-2019-04-18T13_32_05Z-00000-000';

describe('safeDocId', () => {
  it('maps an unsafe id onto the filename-safe set', () => {
    expect(safeDocId(TOUCHE_ID)).toBe(TOUCHE_SAFE);
    expect(FILENAME_SAFE.test(safeDocId(TOUCHE_ID))).toBe(true);
  });

  it('is deterministic and idempotent, so corpus and qrels map independently', () => {
    expect(safeDocId(TOUCHE_ID)).toBe(safeDocId(TOUCHE_ID));
    expect(safeDocId(safeDocId(TOUCHE_ID))).toBe(safeDocId(TOUCHE_ID));
  });

  it('leaves an already-safe id byte-identical', () => {
    const safeIds = ['MED-10', '4983', 'ug7v899j', 'test-environment-aeghhgwpe-pro02a', 'a_b-c'];
    expect(safeIds.map(safeDocId)).toEqual(safeIds);
  });

  it('keeps two over-long ids sharing a prefix distinct', () => {
    const prefix = 'x'.repeat(220);
    expect(safeDocId(`${prefix}a`)).not.toBe(safeDocId(`${prefix}b`));
    expect(FILENAME_SAFE.test(safeDocId(`${prefix}a`))).toBe(true);
  });
});

describe('assertNoIdCollisions', () => {
  it('names both original ids when two documents would merge', () => {
    expect(() => assertNoIdCollisions(['a:b', 'a/b'])).toThrow(/"a:b"/);
    expect(() => assertNoIdCollisions(['a:b', 'a/b'])).toThrow(/"a\/b"/);
  });

  it('accepts a corpus whose ids stay distinct after mapping', () => {
    expect(() => assertNoIdCollisions([TOUCHE_ID, 'MED-10', 'a:b'])).not.toThrow();
  });

  it('tolerates the SAME id appearing twice — that is a duplicate, not a merge', () => {
    expect(() => assertNoIdCollisions([TOUCHE_ID, TOUCHE_ID])).not.toThrow();
  });
});
