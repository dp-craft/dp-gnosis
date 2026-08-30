/**
 * The one question that answers the others — a named preset, asked once, that
 * PRE-SELECTS rows the expert menus already offer.
 *
 * The constraint is the whole design: a preset may only move a menu's cursor.
 * It MUST NOT introduce a value no menu offers, and it MUST NOT change a
 * shipped default. Every menu stays walkable and every row stays choosable, so
 * choosing a preset is never a door that closes one.
 *
 * That is why nothing here is a number. The pool depth is DERIVED from
 * {@link poolChoices} rather than written down: that function withholds the
 * smaller depth on a Hungarian corpus (`CONFIGURATION.md` § 9 measured a real
 * loss there), and a preset carrying its own `60` would hand the pool menu a
 * row it does not have. The analysis chain is likewise
 * {@link analyzerFor}'s answer and never the preset's — the LANGUAGE decides
 * the chain, and a speed preference has no business moving it.
 *
 * So only ONE axis actually differs between the presets: whether the reranker
 * is offered. That is not a thin design, it is the measured shape of the
 * tradeoff — the reranker is the slow hop, seconds against milliseconds, while
 * PRF runs inside SQLite with no model and no network call, and `fts5` is at
 * once the fastest route and the measured champion. Neither is a speed lever,
 * so no preset trades either away.
 */
import type { AnalyzerId } from '../../query.js';
import type { AdapterName } from '../adapter.js';
import type { Choice } from './advice.js';
import { analyzerFor, poolChoices } from './advice.js';
import { note } from './screen.js';

/**
 * Which row of {@link poolChoices} a preset pre-selects, named rather than
 * numbered. `inert` is a depth the user will never reach: the preset carrying
 * it declines the reranker, and the pool menu lives behind that question — so
 * it takes the shipped value and the table advertises no pool for that row.
 */
type PoolPick = 'reduced' | 'shipped' | 'inert';

export type PresetId = 'fast' | 'balanced' | 'quality' | 'custom';

/** One named starting point: how it reads, and the two things it pre-selects. */
export interface Preset {
  readonly id: PresetId;
  readonly title: string;
  readonly summary: string;
  /** Whether `Set up the reranker?` opens on yes. The one axis that differs. */
  readonly rerank: boolean;
  readonly pool: PoolPick;
  /** Set on the one preset the wizard pre-selects. */
  readonly recommended?: true;
}

/** The three presets the comparison table compares, cheapest first. */
export const PRESETS: readonly Preset[] = [
  {
    id: 'fast',
    title: 'Fast — no reranker',
    summary:
      'the first-pass word ranking on its own: a search comes back in milliseconds instead of seconds, there is no model to download, and `dp-gnosis setup` adds a reranker later without re-running this',
    rerank: false,
    pool: 'inert',
  },
  {
    id: 'balanced',
    title: 'Balanced — rerank fewer candidates',
    summary:
      'the reranker, over the smaller candidate depth the pool menu offers: roughly a 40 % latency cut on an English corpus for no quality difference the measurement could detect',
    rerank: true,
    pool: 'reduced',
  },
  {
    id: 'quality',
    title: 'Best quality — the shipped configuration (recommended)',
    summary:
      'the reranker over the full shipped depth: exactly what gnosis ships with, and what every published measurement of it used',
    rerank: true,
    pool: 'shipped',
    recommended: true,
  },
];

/**
 * The fourth menu row: no preset at all. It pre-selects exactly what the
 * interview defaulted to before presets existed, so choosing it keeps today's
 * behaviour to the letter — which is also why it is not in the comparison
 * table. It has nothing to compare.
 */
export const CUSTOM_PRESET: Preset = {
  id: 'custom',
  title: 'Let me choose — ask me everything, pre-select nothing',
  summary: 'every menu below opens on its own default, exactly as it would without a preset',
  rerank: true,
  pool: 'shipped',
};

/** What a preset hands to the menus that follow it. Every field is an `initial`. */
export interface PresetSelections {
  readonly analyzer: AnalyzerId;
  readonly adapter: AdapterName;
  readonly prf: boolean;
  readonly rerank: boolean;
  readonly poolK: number;
}

/**
 * `fts5` for every preset: it is the fastest of the routes AND the measured
 * champion, so no preference expressed here gives a reason to move it.
 */
const PRESET_ADAPTER: AdapterName = 'fts5';

/** The shipped row of the pool menu — read off the menu, never written down. */
const shippedDepth = (choices: readonly Choice<string>[]): Choice<string> | undefined =>
  choices.find(choice => choice.recommended === true);

/**
 * The smallest depth on offer — the LAST row, because `poolChoices` leads with
 * the shipped one. On a Hungarian corpus that function returns a single row, so
 * this resolves to the shipped depth: it withholds the smaller one there
 * because cutting it measured a real quality loss.
 */
const reducedDepth = (choices: readonly Choice<string>[]): Choice<string> | undefined =>
  choices[choices.length - 1];

const poolFor = (pick: PoolPick, hungarian: boolean): number => {
  const choices = poolChoices(hungarian);
  const wanted = pick === 'reduced' ? reducedDepth(choices) : shippedDepth(choices);
  return Number((wanted ?? reducedDepth(choices))?.value);
};

/**
 * The pre-selections, for the menus that come after the preset question.
 *
 * `prf` is `true` for every preset — the shipped default. Pseudo-relevance
 * feedback runs inside SQLite with no model, no server and no network hop, so
 * it is not the lever a speed preference should pull, and turning it off would
 * be a preset moving a measured default rather than a cursor.
 */
export const presetSelections = (
  preset: Preset,
  hungarian: boolean,
  identifiers: boolean
): PresetSelections => ({
  analyzer: analyzerFor(hungarian, identifiers),
  adapter: PRESET_ADAPTER,
  prf: true,
  rerank: preset.rerank,
  poolK: poolFor(preset.pool, hungarian),
});

/** The width of each column of {@link presetTable}, in the order they print. */
const NAME_WIDTH = 24;

const RERANK_WIDTH = 10;

const HEADINGS = { name: 'preset', rerank: 'reranker', pool: 'candidate pool' } as const;

const POOL_LABEL: Readonly<Record<PoolPick, string>> = {
  reduced: 'the smaller depth on offer',
  shipped: 'the shipped depth',
  inert: '— (no reranker, so nothing to rerank)',
};

const line = (name: string, rerank: string, pool: string): string =>
  `  ${name.padEnd(NAME_WIDTH)}${rerank.padEnd(RERANK_WIDTH)}${pool}`;

const nameOf = (preset: Preset): string =>
  preset.recommended === true ? `${preset.id} (recommended)` : preset.id;

const row = (preset: Preset): string =>
  line(nameOf(preset), preset.rerank ? 'yes' : 'no', POOL_LABEL[preset.pool]);

/**
 * The tradeoff, rendered before the question so the choice is made with it in
 * view. The pool column is a DESCRIPTION rather than a number because the
 * depths on offer depend on the language answer, and a table that printed a
 * depth the pool menu withholds would be advertising a row that is not there.
 */
const HUNGARIAN_FOOTNOTE =
  'On a Hungarian corpus balanced and quality land on the SAME depth: no smaller' +
  ' one is offered there, because cutting it measured a real quality loss.';

const TABLE_FOOTNOTE =
  'The reranker is the only slow part: it is a second pass that reads each candidate,' +
  ' so it costs seconds where the rest costs milliseconds. Everything below stays choosable —' +
  ' a preset only moves the cursor.';

export const presetTable = (): readonly string[] => [
  '',
  line(HEADINGS.name, HEADINGS.rerank, HEADINGS.pool),
  `  ${'─'.repeat(NAME_WIDTH + RERANK_WIDTH + HEADINGS.pool.length)}`,
  ...PRESETS.map(row),
  ...note([TABLE_FOOTNOTE, HUNGARIAN_FOOTNOTE]),
];
