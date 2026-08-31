/**
 * The wizard's presets — the one question that pre-selects the rest.
 *
 * A preset is PRESENTATION: it may only pre-select a row an existing menu
 * already offers, it MUST NOT introduce a value no menu offers, and it MUST NOT
 * move a shipped default. That is what this file measures, and it measures it
 * against `advice.ts` itself rather than against a copied number — a depth
 * written here as a literal would rot the moment `poolChoices` changed, and the
 * preset would then be offering a row the menu no longer has.
 */
import { analyzerFor, poolChoices } from '../src/cli/wizard/advice.js';
import type { Preset } from '../src/cli/wizard/preset.js';
import { CUSTOM_PRESET, PRESETS, presetSelections, presetTable } from '../src/cli/wizard/preset.js';

/** Every preset a menu row can yield — the three in the table, plus `custom`. */
const ALL: readonly Preset[] = [...PRESETS, CUSTOM_PRESET];

/** The four language / identifier answers the interview can arrive with. */
const CORPORA: readonly { readonly hungarian: boolean; readonly identifiers: boolean }[] = [
  { hungarian: false, identifiers: false },
  { hungarian: false, identifiers: true },
  { hungarian: true, identifiers: false },
  { hungarian: true, identifiers: true },
];

const byId = (id: string): Preset => {
  const found = ALL.find(preset => preset.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
};

const depthsOffered = (hungarian: boolean): readonly number[] =>
  poolChoices(hungarian).map(choice => Number(choice.value));

describe('PRESETS — the table the user chooses from', () => {
  it('should offer exactly fast, balanced and quality, cheapest first', () => {
    expect(PRESETS.map(preset => preset.id)).toEqual(['fast', 'balanced', 'quality']);
  });

  // `quality` reproduces the shipped configuration exactly, and every published
  // measurement of gnosis used it — so it is the one the wizard pre-selects.
  it('should recommend quality alone, since it is the shipped configuration', () => {
    expect([...PRESETS, CUSTOM_PRESET].filter(preset => preset.recommended === true).map(preset => preset.id))
      .toEqual(['quality']);
  });

  it('should give every preset a title and a summary to render', () => {
    ALL.forEach(preset => {
      expect(preset.title.length).toBeGreaterThan(0);
      expect(preset.summary.length).toBeGreaterThan(0);
    });
  });
});

describe('presetTable — the tradeoff, seen before the choice', () => {
  const rendered = presetTable().join('\n');

  it('should carry one row per preset, named', () => {
    PRESETS.forEach(preset => {
      expect(rendered).toContain(preset.id);
    });
  });

  it('should column the reranker and the candidate pool, which are what differ', () => {
    expect(rendered).toContain('reranker');
    expect(rendered).toContain('candidate pool');
  });

  it('should mark the recommended row so the table has an opinion', () => {
    expect(rendered).toContain('quality (recommended)');
  });

  // Two rows showing the same depth invite the reader to think one is wrong.
  it('should say in words why balanced and quality coincide on Hungarian', () => {
    expect(rendered).toContain('Hungarian');
    expect(rendered).toContain('SAME depth');
  });

  // `fast` declines the reranker, so the pool menu is never reached under it —
  // advertising a depth for that row would advertise a question it never asks.
  it('should advertise no candidate pool for the row that has no reranker', () => {
    expect(rendered).toContain('no reranker, so nothing to rerank');
  });
});

describe('presetSelections — a preset pre-selects, it never invents', () => {
  // Given any preset and any corpus answer, When the pool depth is derived,
  // Then it is a depth `poolChoices` itself returns — never a number of its own.
  it('should never return a pool depth outside the menu for that language', () => {
    CORPORA.forEach(corpus => {
      const offered = depthsOffered(corpus.hungarian);
      ALL.forEach(preset => {
        const selected = presetSelections(preset, corpus.hungarian, corpus.identifiers);
        expect(offered).toContain(selected.poolK);
      });
    });
  });

  // Hungarian withholds the smaller depth, so every preset lands on the one row.
  it('should land every preset on the single depth Hungarian offers', () => {
    const offered = depthsOffered(true);
    expect(offered).toHaveLength(1);
    ALL.forEach(preset => {
      expect(presetSelections(preset, true, false).poolK).toBe(offered[0]);
    });
  });

  it('should select the same adapter and the same PRF answer for every preset', () => {
    const selections = ALL.map(preset => presetSelections(preset, false, false));
    expect(new Set(selections.map(selection => selection.adapter))).toEqual(new Set(['fts5']));
    expect(new Set(selections.map(selection => selection.prf))).toEqual(new Set([true]));
  });

  // The language decides the chain. Speed never does — so no preset may move it.
  it('should take the analysis chain from the language and the identifiers alone', () => {
    CORPORA.forEach(corpus => {
      const expected = analyzerFor(corpus.hungarian, corpus.identifiers);
      ALL.forEach(preset => {
        expect(presetSelections(preset, corpus.hungarian, corpus.identifiers).analyzer).toBe(expected);
      });
    });
  });

  it('should turn the reranker off for fast alone — it is the one speed lever', () => {
    const off = ALL.filter(preset => !presetSelections(preset, false, false).rerank);
    expect(off.map(preset => preset.id)).toEqual(['fast']);
  });

  // Three rows in a comparison table that pre-select the same two things are
  // one row printed three times. On English each pair must differ.
  it('should give the three presets three distinct rerank-and-depth pairs on English', () => {
    const pairs = PRESETS.map(preset => {
      const selected = presetSelections(preset, false, false);
      return `${String(selected.rerank)}:${String(selected.poolK)}`;
    });

    expect(new Set(pairs).size).toBe(PRESETS.length);
  });

  // And on Hungarian they MUST coincide, because `poolChoices` withholds the
  // smaller depth there — which is why the table says so in words.
  it('should let balanced and quality coincide on Hungarian, where no smaller depth exists', () => {
    const balanced = presetSelections(byId('balanced'), true, false);
    const quality = presetSelections(byId('quality'), true, false);

    expect(balanced).toEqual(quality);
  });

  // Today's pre-selection is the reranker offered at the shipped depth, which
  // is what `quality` reproduces — so recommending it moves no default. The
  // comparison is over the pre-selected VALUES: `custom` is not one of them, it
  // is the flag saying whether the expert menus open in full, and the two
  // presets differ there by definition.
  it('should have quality select exactly what the interview already defaulted to', () => {
    const { custom: _quality, ...quality } = presetSelections(byId('quality'), false, false);
    const { custom: _custom, ...asked } = presetSelections(CUSTOM_PRESET, false, false);

    expect(quality).toEqual(asked);
  });

  // The flag the two expert menus branch on: exactly one preset carries it, and
  // it is the one whose whole meaning is "ask me everything".
  it('should mark custom, and only custom, as the preset that opens every menu in full', () => {
    const marked = ALL.filter(preset => presetSelections(preset, false, false).custom);

    expect(marked.map(preset => preset.id)).toEqual([CUSTOM_PRESET.id]);
  });

  // `custom` means "ask me everything, pre-select nothing new", so its
  // pre-selections are today's: the reranker offered, the shipped depth.
  it('should leave custom on the answers the interview already defaulted to', () => {
    const custom = presetSelections(CUSTOM_PRESET, false, false);
    const shipped = poolChoices(false).find(choice => choice.recommended === true)?.value;

    expect(custom.rerank).toBe(true);
    expect(custom.poolK).toBe(Number(shipped));
  });
});
