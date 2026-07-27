/**
 * The report figure: stacked panels on one shared time axis, as a self-contained
 * SVG.
 *
 * Four panels when cost was collected, three without it:
 *
 *   - **cost per period**, stacked by series — composition and the peak period;
 *   - **cumulative cost** per series, each line labelled at its end point;
 *   - **tokens per period**, stacked by the same series — where the volume went,
 *     which is not the same shape as where the money went;
 *   - **token mix**, the share of each period that was uncached input, output,
 *     cache write and cache read. Absolute tokens are already in the panel above,
 *     so this one is normalised: it answers "what kind of tokens", and a caching
 *     change shows up here first.
 *
 * A fifth panel, **top models**, answers a different question from the series
 * panels above: not "how did this move over time" but "which model, ranked".
 * Model is a high-cardinality categorical nested under provider (a handful of
 * providers, dozens of models), so it gets a dot chart — position along a
 * common scale, Cleveland & McGill's most accurate elementary task, ranked
 * order being exactly what pie/treemap/bubble-area encodings are worse at —
 * rather than a 16-colour legend no reader can hold in working memory. Colour
 * on that panel is the *provider* that served the model, reusing the same
 * vendor palette as everywhere else, not a new per-model hue. The tail beyond
 * the top few is folded into a disclosed "Other N models" row rather than cut
 * silently, and a model billed under more than one provider (routed at reduced
 * fidelity) gets the neutral mark instead of either provider's colour, so that
 * ambiguity is shown rather than hidden.
 *
 * Measures on different scales get their own panel, never a second y-axis.
 *
 * Provenance is part of the figure, not an afterthought: the caption states the
 * window, the cost provenance of the numbers plotted, the price sources, and any
 * source that did not fully report. A figure that gets forwarded without its
 * table must still be impossible to over-read.
 *
 * Visual language: Soilytix — flat, hairline rules, no gradients, no shadows,
 * Inter, white report surface, Lime ink for the title and the key rule, Mint as
 * the one primary highlight, and a vendor mark per series so identity never
 * depends on hue alone.
 */

import type { SplitDimension } from '../aggregate.js';
import { formatUsd } from '../money.js';
import type { DimensionBreakdown, ModelBreakdown, PeriodReport, ReportRow } from '../report.js';
import {
  escapeXml,
  SERIES_COLOURS,
  TOKEN,
  TOKEN_CLASSES,
  type VendorId,
  vendorColour,
  vendorMark,
  vendorOf,
} from './tokens.js';

export type ChartOptions = {
  /** Which breakdown to draw as series; `provider` unless asked otherwise. */
  series: SplitDimension;
  /** False when `--no-cost`: the cost panels are dropped rather than faked. */
  includeCost: boolean;
  width?: number;
  /**
   * Draw the figure's own title block. False when the figure is embedded in a
   * page that already carries the heading, so the title is not printed twice.
   */
  header?: boolean;
};

export type Series = {
  key: string;
  label: string;
  colour: string;
  vendor: VendorId;
  /** One value per period, in period order. */
  cost: number[];
  tokens: number[];
  costTotal: number;
  tokenTotal: number;
};

type Measure = 'cost' | 'tokens';

type PanelSpec =
  | { kind: 'stacked'; id: string; title: string; measure: Measure }
  | { kind: 'cumulative'; id: string; title: string; measure: Measure }
  | { kind: 'mix'; id: string; title: string }
  | { kind: 'ranked'; id: string; title: string; measure: Measure; models: RankedModel[] };

type Box = { top: number; bottom: number };

/** One row of the top-models dot chart: a model, ranked, marked by agent. */
type RankedModel = {
  label: string;
  vendor: VendorId;
  value: number;
  agents: string[];
  /** This exact model was run under more than one agent. */
  mixedAgent: boolean;
  /** This row is the collapsed tail, not a real model. */
  isOther: boolean;
  /** Only set on the `isOther` row: how many models it folds in. */
  tailCount?: number;
};

const LEFT = 76;
const RIGHT_MARGIN = 168; // room for the end labels of the cumulative lines
const PANEL_HEIGHT = 150;
const PANEL_GAP = 74;
const RANK_ROW_HEIGHT = 22;
const RANK_CAPACITY = 8;
/** Room for the model label and its vendor mark, left of the dot chart's axis. */
const RANK_LEFT_MARGIN = 210;

const BREAKDOWN_KEY: Record<SplitDimension, keyof ReportRow> = {
  model: 'modelBreakdowns',
  apiKey: 'apiKeyBreakdowns',
  account: 'accountBreakdowns',
  workspace: 'workspaceBreakdowns',
  provider: 'providerBreakdowns',
  agent: 'agentBreakdowns',
};

const SERIES_NOUN: Record<SplitDimension, string> = {
  model: 'model',
  apiKey: 'API key',
  account: 'account',
  workspace: 'workspace',
  provider: 'provider',
  agent: 'agent',
};

export function renderReportSvg(report: PeriodReport, options: ChartOptions): string {
  const rows = periodsOf(report);
  const width = options.width ?? 960;
  const right = width - RIGHT_MARGIN;
  const series = buildSeries(rows, options);
  const rankedModels = buildModelRanking(rows, options.includeCost ? 'cost' : 'tokens');
  const panels = panelSpecs(report, options, rankedModels);

  const withHeader = options.header !== false;
  const legendRows = Math.max(1, Math.ceil(series.length / 4));
  const legendTop = withHeader ? 126 : 30;
  const firstPanelTop = legendTop + legendRows * 22 + 30;
  const boxes: Box[] = [];
  let panelTop = firstPanelTop;
  for (const spec of panels) {
    const panelHeight =
      spec.kind === 'ranked' ? rankedPanelHeight(spec.models.length) : PANEL_HEIGHT;
    boxes.push({ top: panelTop, bottom: panelTop + panelHeight });
    panelTop += panelHeight + PANEL_GAP;
  }
  const captionTop = (boxes.at(-1)?.bottom ?? firstPanelTop) + 58;
  const captionText = wrapAll(
    captionLines(report, options, series, rankedModels),
    width - LEFT * 2,
  );
  const height = captionTop + captionText.length * 15 + 16;

  const parts: string[] = [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${TOKEN.surface}"/>`,
    ...(withHeader ? header(report, options, width, series) : []),
    ...legend(series, legendTop, width, options),
    ...panels.flatMap((spec, index) =>
      panelGroup(spec, boxes[index] ?? { top: 0, bottom: 0 }, rows, series, right),
    ),
    ...caption(captionText, captionTop),
  ];

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${TOKEN.font}" role="img">`,
    `<title>${escapeXml(titleOf(options))}</title>`,
    parts.join('\n'),
    '</svg>',
  ].join('\n');
}

export function periodsOf(report: PeriodReport): ReportRow[] {
  return report.daily ?? report.weekly ?? report.monthly ?? [];
}

function panelSpecs(
  report: PeriodReport,
  options: ChartOptions,
  rankedModels: readonly RankedModel[],
): PanelSpec[] {
  const cadence = cadenceOf(report);
  const specs: PanelSpec[] = [];
  if (options.includeCost) {
    specs.push({ kind: 'stacked', id: 'cost-daily', title: `${cadence} cost`, measure: 'cost' });
    specs.push({
      kind: 'cumulative',
      id: 'cost-cumulative',
      title: 'Cumulative cost',
      measure: 'cost',
    });
    specs.push({
      kind: 'stacked',
      id: 'tokens-daily',
      title: `${cadence} tokens`,
      measure: 'tokens',
    });
  } else {
    // Without cost there is nothing to compare tokens against, so the token
    // panels take both the composition and the accumulation.
    specs.push({
      kind: 'stacked',
      id: 'tokens-daily',
      title: `${cadence} tokens`,
      measure: 'tokens',
    });
    specs.push({
      kind: 'cumulative',
      id: 'tokens-cumulative',
      title: 'Cumulative tokens',
      measure: 'tokens',
    });
  }
  // A ranking needs at least two models to rank; with zero or one, the panel
  // above already says everything it could.
  if (rankedModels.length > 1) {
    const measure: Measure = options.includeCost ? 'cost' : 'tokens';
    specs.push({
      kind: 'ranked',
      id: 'model-rank',
      title: `Top models by ${measure === 'cost' ? 'cost' : 'tokens'}`,
      measure,
      models: [...rankedModels],
    });
  }
  specs.push({ kind: 'mix', id: 'token-mix', title: 'Token mix' });
  return specs;
}

function rankedPanelHeight(count: number): number {
  return Math.max(70, count * RANK_ROW_HEIGHT + 20);
}

export function titleOf(options: ChartOptions): string {
  const noun = SERIES_NOUN[options.series];
  return options.includeCost ? `LLM spend by ${noun}` : `LLM token usage by ${noun}`;
}

function measureOf(breakdown: DimensionBreakdown, measure: Measure): number {
  return measure === 'cost' ? (breakdown.cost ?? 0) : breakdown.totalTokens;
}

function buildSeries(rows: readonly ReportRow[], options: ChartOptions): Series[] {
  const key = BREAKDOWN_KEY[options.series];
  const found = new Map<
    string,
    { label: string; cost: number[]; tokens: number[]; models: Set<string> }
  >();

  rows.forEach((row, index) => {
    for (const breakdown of (row[key] as DimensionBreakdown[] | undefined) ?? []) {
      const id = breakdown.id ?? breakdown.name;
      const entry =
        found.get(id) ??
        ({
          label: breakdown.name || id,
          cost: new Array<number>(rows.length).fill(0),
          tokens: new Array<number>(rows.length).fill(0),
          models: new Set<string>(),
        } satisfies { label: string; cost: number[]; tokens: number[]; models: Set<string> });
      entry.cost[index] = (entry.cost[index] ?? 0) + measureOf(breakdown, 'cost');
      entry.tokens[index] = (entry.tokens[index] ?? 0) + measureOf(breakdown, 'tokens');
      for (const model of breakdown.models ?? []) entry.models.add(model);
      found.set(id, entry);
    }
  });

  const sum = (values: readonly number[]): number => values.reduce((total, one) => total + one, 0);

  return (
    [...found.entries()]
      .map(([id, entry]) => {
        const vendor = markFor(id, entry.models);
        // Strip the vendor prefix (e.g. "openai/", "anthropic/") from the label
        // if it matches the identified vendor, since the icon carries that information.
        let displayLabel = entry.label;
        if (displayLabel.includes('/')) {
          const parts = displayLabel.split('/');
          if (vendorOf(parts[0] ?? '') === vendor) {
            displayLabel = parts.slice(1).join('/');
          }
        }

        return {
          key: id,
          label: displayLabel,
          colour: TOKEN.highlight,
          vendor,
          cost: entry.cost,
          tokens: entry.tokens,
          costTotal: sum(entry.cost),
          tokenTotal: sum(entry.tokens),
        };
      })
      // Largest first, so the primary highlight lands on the series that matters
      // and the stack order is stable across renders.
      .sort((a, b) =>
        options.includeCost
          ? b.costTotal - a.costTotal || b.tokenTotal - a.tokenTotal || a.key.localeCompare(b.key)
          : b.tokenTotal - a.tokenTotal || a.key.localeCompare(b.key),
      )
      .map((entry, index, array) => {
        // Find how many earlier series in the sorted list share the same vendor
        const sameVendorIndex = array
          .slice(0, index)
          .filter((earlier) => earlier.vendor === entry.vendor).length;

        return {
          ...entry,
          colour:
            sameVendorIndex === 0
              ? vendorColour(entry.vendor)
              : (SERIES_COLOURS[index % SERIES_COLOURS.length] ?? TOKEN.highlight),
        };
      })
  );
}

/**
 * Every model, ranked by total cost or tokens across the whole window,
 * regardless of `options.series` — `modelBreakdowns` is unconditional on every
 * row, so this reads directly off it rather than requiring `--split model`.
 *
 * Colour comes from the *agent* that ran the model (`vendorOf` applied to the
 * agent name, not the model name) — never the literal provider id `ccusage`,
 * which names the local-usage tool, not a billable endpoint; a remote
 * platform's own id (`openrouter`, `openai`, `anthropic`) already doubles as
 * its agent name. A model run under more than one agent has no single colour
 * to wear honestly, so it gets the neutral mark instead of picking one
 * arbitrarily; `captionLines` discloses which models that happened to.
 */
function buildModelRanking(rows: readonly ReportRow[], measure: Measure): RankedModel[] {
  const found = new Map<string, { value: number; agents: Set<string> }>();

  for (const row of rows) {
    for (const model of row.modelBreakdowns) {
      const value = valueOfModel(model, measure);
      const entry = found.get(model.modelName) ?? { value: 0, agents: new Set<string>() };
      entry.value += value;
      for (const agent of model.agents) entry.agents.add(agent);
      found.set(model.modelName, entry);
    }
  }

  const ranked: RankedModel[] = [...found.entries()]
    .map(([label, entry]) => {
      const agents = [...entry.agents].sort();
      const mixedAgent = agents.length > 1;
      return {
        label,
        vendor: mixedAgent ? ('other' as VendorId) : vendorOf(agents[0] ?? ''),
        value: entry.value,
        agents,
        mixedAgent,
        isOther: false,
      };
    })
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  if (ranked.length <= RANK_CAPACITY) return ranked;

  const kept = ranked.slice(0, RANK_CAPACITY);
  const tail = ranked.slice(RANK_CAPACITY);
  kept.push({
    label: `Other ${tail.length} models`,
    vendor: 'other',
    value: tail.reduce((sum, one) => sum + one.value, 0),
    agents: [...new Set(tail.flatMap((one) => one.agents))].sort(),
    mixedAgent: false,
    isOther: true,
    tailCount: tail.length,
  });
  return kept;
}

function valueOfModel(model: ModelBreakdown, measure: Measure): number {
  return measure === 'cost'
    ? (model.cost ?? 0)
    : model.inputTokens + model.outputTokens + model.cacheCreationTokens + model.cacheReadTokens;
}

/**
 * A series' mark comes from its own name where that names a vendor. An API key
 * called "ci" or a person's name does not, so the models it ran are the next
 * evidence — and only when they all point at one vendor, since a key that spans
 * two vendors has no single mark to wear.
 */
function markFor(name: string, models: ReadonlySet<string>): VendorId {
  const own = vendorOf(name);
  if (own !== 'other') return own;
  const vendors = new Set([...models].map(vendorOf));
  vendors.delete('other');
  const [only] = vendors;
  return vendors.size === 1 && only ? only : 'other';
}

function header(
  report: PeriodReport,
  options: ChartOptions,
  width: number,
  series: readonly Series[],
): string[] {
  const rows = periodsOf(report);
  const total = options.includeCost
    ? formatUsd(Math.round(series.reduce((sum, one) => sum + one.costTotal, 0) * 1_000_000))
    : compactTokens(series.reduce((sum, one) => sum + one.tokenTotal, 0));
  const active = rows.filter((row) =>
    options.includeCost ? (row.totalCost ?? 0) > 0 : row.totalTokens > 0,
  ).length;
  const { since, until } = report.meta.range;

  return [
    text(LEFT, 34, 'AIUSAGE REPORT', {
      size: 10.5,
      fill: TOKEN.eyebrow,
      weight: 600,
      letterSpacing: 1.6,
    }),
    // Lime ink carries the title and the rule below it; Mint is reserved for the
    // one data highlight, so the two greens never compete.
    text(LEFT, 64, titleOf(options), { size: 27, fill: TOKEN.eyebrow, weight: 300 }),
    text(
      LEFT,
      88,
      `${since} to ${until} · ${total} across ${active} active ${periodNoun(report, active !== 1).toLowerCase()} · grouped ${report.meta.granularity} in ${report.meta.timezone}`,
      { size: 12.5, fill: TOKEN.muted },
    ),
    `<line x1="${LEFT}" y1="100" x2="${width - LEFT}" y2="100" stroke="${TOKEN.eyebrow}" stroke-width="1"/>`,
  ];
}

function legend(
  series: readonly Series[],
  top: number,
  width: number,
  options: ChartOptions,
): string[] {
  const parts: string[] = ['<g data-part="legend">'];
  const columns = Math.min(4, Math.max(1, series.length));
  const columnWidth = (width - LEFT - 92) / columns;

  series.forEach((entry, index) => {
    const x = LEFT + (index % columns) * columnWidth;
    const y = top + Math.floor(index / columns) * 22;
    const label = truncate(entry.label, 24);
    const amount = options.includeCost
      ? formatUsd(Math.round(entry.costTotal * 1_000_000))
      : compactTokens(entry.tokenTotal);
    parts.push(
      vendorMark(entry.vendor, x, y - 11, 12, entry.colour),
      `<rect x="${x + 18}" y="${y - 9}" width="8" height="8" fill="${entry.colour}"/>`,
      text(x + 32, y, label, { size: 12, fill: TOKEN.body }),
      text(x + 32 + labelWidth(label) + 8, y, amount, { size: 11.5, fill: TOKEN.subtle }),
    );
  });
  parts.push('</g>');
  return parts;
}

function panelGroup(
  spec: PanelSpec,
  box: Box,
  rows: readonly ReportRow[],
  series: readonly Series[],
  right: number,
): string[] {
  const body =
    spec.kind === 'mix'
      ? mixPanel(rows, box, right)
      : spec.kind === 'stacked'
        ? stackedPanel(rows, series, box, right, spec.measure)
        : spec.kind === 'ranked'
          ? rankedPanel(spec.models, box, right, spec.measure)
          : cumulativePanel(series, box, right, spec.measure);

  return [
    `<g data-panel="${spec.id}">`,
    ...panelTitle(spec, box),
    ...body,
    // The ranked panel's rows are models, not periods — a date axis under it
    // would claim an ordering along time that isn't there.
    ...(spec.kind === 'ranked' ? [] : axisDates(rows, box.bottom, right)),
    `</g>`,
  ];
}

function panelTitle(spec: PanelSpec, box: Box): string[] {
  const parts = [
    text(LEFT, box.top - 14, spec.title, { size: 11.5, fill: TOKEN.muted, letterSpacing: 0.3 }),
  ];

  // The mix panel's series are the token classes, so its key sits with it rather
  // than in the figure legend.
  if (spec.kind === 'mix') {
    let x = LEFT + 90;
    for (const klass of TOKEN_CLASSES) {
      parts.push(
        `<rect x="${x}" y="${box.top - 22}" width="8" height="8" fill="${klass.colour}"/>`,
        text(x + 13, box.top - 14, klass.label, { size: 10.5, fill: TOKEN.muted }),
      );
      x += 26 + labelWidth(klass.label);
    }
    return parts;
  }

  // The ranked panel's colour means "agent", not "model" — a different
  // mapping from whatever the figure's own legend is keying on (which follows
  // `options.series` and could be model, API key, or anything else) — so it
  // carries its own small key rather than relying on the legend above it.
  if (spec.kind === 'ranked') {
    const agents = [...new Set(spec.models.flatMap((model) => model.agents))].sort();
    let x = LEFT + 150;
    for (const agent of agents) {
      const vendor = vendorOf(agent);
      const colour = vendorColour(vendor);
      parts.push(
        vendorMark(vendor, x, box.top - 22, 10, colour),
        text(x + 14, box.top - 14, agent, { size: 10.5, fill: TOKEN.muted }),
      );
      x += 22 + labelWidth(agent);
    }
  }
  return parts;
}

type Scale = (value: number) => number;

function scaleOf(box: Box, max: number): Scale {
  // A flat all-zero window still needs a usable axis rather than a divide by zero.
  const span = max > 0 ? max : 1;
  return (value) => box.bottom - (value / span) * (box.bottom - box.top);
}

/**
 * The axis tops out at the next round tick above the data, so gridlines bracket
 * the tallest bar instead of it running into the panel's edge.
 */
function axisMax(max: number): number {
  const step = niceStep(max);
  return Math.max(step, Math.ceil(max / step) * step);
}

/** A round tick step: 1, 2, 2.5 or 5 × a power of ten, aiming for ~4 gridlines. */
function niceStep(max: number): number {
  if (max <= 0) return 1;
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (magnitude * factor >= rough) return magnitude * factor;
  }
  return magnitude * 10;
}

type Format = (value: number) => string;

function formatFor(measure: Measure): Format {
  return measure === 'cost'
    ? (value) => (value === 0 ? '$0' : formatUsd(Math.round(value * 1_000_000)))
    : compactTokens;
}

function grid(box: Box, right: number, max: number, format: Format): string[] {
  const step = niceStep(max);
  const top = axisMax(max);
  const y = scaleOf(box, top);
  const parts: string[] = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    const at = round(y(value));
    if (at < box.top - 1) break;
    parts.push(
      `<line x1="${LEFT}" y1="${at}" x2="${right}" y2="${at}" stroke="${TOKEN.grid}" stroke-width="1"/>`,
      text(LEFT - 10, at + 4, format(value), { size: 11, fill: TOKEN.muted, anchor: 'end' }),
    );
  }
  return parts;
}

function baseline(box: Box, right: number): string {
  return `<line x1="${LEFT}" y1="${box.bottom}" x2="${right}" y2="${box.bottom}" stroke="${TOKEN.rule}" stroke-width="1"/>`;
}

function slots(count: number, right: number): { centre: (index: number) => number; width: number } {
  const usable = right - LEFT;
  const slot = count > 0 ? usable / count : usable;
  return { centre: (index) => LEFT + slot * (index + 0.5), width: slot };
}

function stackedPanel(
  rows: readonly ReportRow[],
  series: readonly Series[],
  box: Box,
  right: number,
  measure: Measure,
): string[] {
  const values = (entry: Series): number[] => (measure === 'cost' ? entry.cost : entry.tokens);
  const perPeriod = rows.map((_row, index) =>
    series.reduce((sum, entry) => sum + (values(entry)[index] ?? 0), 0),
  );
  const max = Math.max(0, ...perPeriod);
  const y = scaleOf(box, axisMax(max));
  const { centre, width } = slots(rows.length, right);
  const barWidth = Math.max(2, Math.min(22, width * 0.62));

  const bars: string[] = [];
  rows.forEach((_row, index) => {
    let base = 0;
    for (const entry of series) {
      const value = values(entry)[index] ?? 0;
      if (value <= 0) continue;
      const top = y(base + value);
      const bottom = y(base);
      base += value;
      bars.push(
        rect(
          centre(index) - barWidth / 2,
          top,
          barWidth,
          Math.max(0.6, bottom - top),
          entry.colour,
        ),
      );
    }
  });

  return [...grid(box, right, max, formatFor(measure)), ...bars, baseline(box, right)];
}

function cumulativePanel(
  series: readonly Series[],
  box: Box,
  right: number,
  measure: Measure,
): string[] {
  const values = (entry: Series): number[] => (measure === 'cost' ? entry.cost : entry.tokens);
  const totals = series.map((entry) => (measure === 'cost' ? entry.costTotal : entry.tokenTotal));
  // One line per series, so the ceiling is the largest single series — not the
  // sum, which would squash every line onto the floor.
  const max = Math.max(0, ...totals);
  const y = scaleOf(box, axisMax(max));
  const count = values(series[0] ?? emptySeries()).length;
  const { centre } = slots(count, right);
  const format = formatFor(measure);

  const parts = grid(box, right, max, format);
  const ends: { label: string; colour: string; vendor: VendorId; y: number; total: number }[] = [];

  for (const entry of series) {
    let running = 0;
    const points = values(entry).map((value, index) => {
      running += value;
      return `${round(centre(index))} ${round(y(running))}`;
    });
    if (points.length === 0) continue;
    parts.push(
      `<path d="M${points.join('L')}" fill="none" stroke="${entry.colour}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    if (running > 0) {
      ends.push({
        label: entry.label,
        colour: entry.colour,
        vendor: entry.vendor,
        y: y(running),
        total: running,
      });
    }
  }

  // Direct labels are the secondary encoding: with them, no series depends on hue
  // alone to be identified.
  const ordered = ends.sort((a, b) => a.y - b.y);
  const positions = spread(
    ordered.map((end) => end.y),
    14,
    box.bottom - 6,
  );
  const endX = centre(count - 1);
  ordered.forEach((end, index) => {
    const at = round(positions[index] ?? end.y);
    parts.push(
      `<circle cx="${round(endX)}" cy="${round(end.y)}" r="3" fill="${end.colour}"/>`,
      vendorMark(end.vendor, round(endX) + 9, at - 9, 11, end.colour),
      text(round(endX) + 24, at + 4, `${truncate(end.label, 16)}  ${format(end.total)}`, {
        size: 11.5,
        fill: TOKEN.body,
      }),
    );
  });
  parts.push(baseline(box, right));
  return parts;
}

/** Push labels apart, then lift the whole group if it runs past `limit`. */
function spread(positions: readonly number[], gap: number, limit: number): number[] {
  const out: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const position of positions) {
    const at = Math.max(position, previous + gap);
    out.push(at);
    previous = at;
  }
  const overflow = (out.at(-1) ?? 0) - limit;
  return overflow > 0 ? out.map((value) => value - overflow) : out;
}

/**
 * One dot per model, ranked by total cost or tokens across the whole window —
 * position along a shared scale, not area or a colour ramp, for the same
 * accuracy reason `cumulativePanel` uses lines over a stacked comparison.
 * Direct labels again, so no reader needs a 9-entry legend to identify a row.
 */
function rankedPanel(
  models: readonly RankedModel[],
  box: Box,
  right: number,
  measure: Measure,
): string[] {
  const axisLeft = LEFT + RANK_LEFT_MARGIN;
  const max = Math.max(0, ...models.map((model) => model.value));
  const top = axisMax(max);
  const step = niceStep(max);
  const format = formatFor(measure);
  const x = (value: number) => axisLeft + (value / (top > 0 ? top : 1)) * (right - axisLeft);

  const parts: string[] = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    const at = round(x(value));
    parts.push(
      `<line x1="${at}" y1="${box.top - 4}" x2="${at}" y2="${box.bottom}" stroke="${TOKEN.grid}" stroke-width="1"/>`,
      text(at, box.bottom + 16, format(value), { size: 10.5, fill: TOKEN.muted, anchor: 'middle' }),
    );
  }

  models.forEach((model, index) => {
    const y = box.top + index * RANK_ROW_HEIGHT + RANK_ROW_HEIGHT / 2;
    const colour = model.vendor === 'other' ? TOKEN.subtle : vendorColour(model.vendor);
    // A superscript dagger, not a second line, so a mixed-agent model still
    // fits in one row height — the caption spells out what it means.
    const label =
      truncate(model.label, model.mixedAgent ? 27 : 30) + (model.mixedAgent ? ' †' : '');

    parts.push(
      vendorMark(model.vendor, axisLeft - 26, y - 6, 12, colour),
      text(axisLeft - 36, y + 4, label, { size: 11.5, fill: TOKEN.body, anchor: 'end' }),
    );
    if (model.value > 0) {
      const at = round(x(model.value));
      parts.push(
        `<circle cx="${at}" cy="${round(y)}" r="3.5" fill="${colour}"/>`,
        text(at + 10, y + 4, format(model.value), { size: 11, fill: TOKEN.subtle }),
      );
    }
  });

  return parts;
}

/**
 * Share of each period's tokens by class. Normalised on purpose: the absolute
 * counts are in the panel above, and what this panel is for — a change in how
 * much of the workload is cache reads — is invisible at absolute scale.
 */
function mixPanel(rows: readonly ReportRow[], box: Box, right: number): string[] {
  const y = scaleOf(box, 100);
  const { centre, width } = slots(rows.length, right);
  const barWidth = Math.max(2, Math.min(22, width * 0.62));

  const parts: string[] = [];
  for (const share of [0, 25, 50, 75, 100]) {
    const at = round(y(share));
    parts.push(
      `<line x1="${LEFT}" y1="${at}" x2="${right}" y2="${at}" stroke="${TOKEN.grid}" stroke-width="1"/>`,
      text(LEFT - 10, at + 4, `${share}%`, { size: 11, fill: TOKEN.muted, anchor: 'end' }),
    );
  }

  rows.forEach((row, index) => {
    const counts: Record<string, number> = {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheCreation: row.cacheCreationTokens,
      cacheRead: row.cacheReadTokens,
    };
    const total = Object.values(counts).reduce((sum, one) => sum + one, 0);
    if (total <= 0) return;
    let base = 0;
    for (const klass of TOKEN_CLASSES) {
      const share = ((counts[klass.key] ?? 0) / total) * 100;
      if (share <= 0) continue;
      const top = y(base + share);
      const bottom = y(base);
      base += share;
      parts.push(
        rect(
          centre(index) - barWidth / 2,
          top,
          barWidth,
          Math.max(0.6, bottom - top),
          klass.colour,
        ),
      );
    }
  });

  parts.push(baseline(box, right));
  return parts;
}

function axisDates(rows: readonly ReportRow[], atY: number, right: number): string[] {
  if (rows.length === 0) return [];
  const { centre } = slots(rows.length, right);
  // Label at most ~8 periods; a crowded axis is unreadable and the caption
  // carries the exact window anyway.
  const stride = Math.max(1, Math.ceil(rows.length / 8));
  return rows.flatMap((row, index) =>
    index % stride === 0 || index === rows.length - 1
      ? [
          text(round(centre(index)), atY + 18, row.period, {
            size: 10.5,
            fill: TOKEN.muted,
            anchor: 'middle',
          }),
        ]
      : [],
  );
}

/**
 * The provenance block. Everything a reader needs to not over-trust the figure:
 * how the plotted money was established, where prices came from, and which
 * sources are missing from it.
 */
export function captionLines(
  report: PeriodReport,
  options: ChartOptions,
  series: readonly Series[],
  rankedModels: readonly RankedModel[] = [],
): string[] {
  const lines: string[] = [];
  const noun = SERIES_NOUN[options.series];

  if (options.includeCost) {
    lines.push(
      `Cost provenance: ${report.totals.costSource} — reported = the platform billed it, allocated = billed coarser and split by derived cost, imported = restated from ccusage’s own calculation, calculated = tokens × unit price.`,
    );
  } else {
    lines.push('Tokens only (--no-cost): cost was not collected, so none is plotted.');
  }
  lines.push(
    'Token counts are not comparable across models — a cache read and an output token are the same unit and nothing like the same money.',
  );

  if (series.length === 0) {
    lines.push(`No ${noun} breakdown was available, so no series could be drawn.`);
  }
  if (gapsIn(report, periodsOf(report).length)) {
    lines.push(
      'The axis has one slot per period that recorded usage; periods with none are omitted rather than drawn as gaps, so horizontal spacing is by period, not by elapsed time.',
    );
  }

  const notReported = report.meta.providers.filter((provider) => provider.status !== 'ok');
  if (notReported.length > 0) {
    lines.push(
      `Not fully reported, so absent or partial here: ${notReported
        .map((provider) => `${provider.label} (${provider.status})`)
        .join(', ')}. A missing source is unknown, not zero.`,
    );
  }

  const unattributed = report.meta.unattributedCost.reduce((sum, entry) => sum + entry.cost, 0);
  if (unattributed > 0) {
    lines.push(
      `$${unattributed.toFixed(2)} of billed cost is not token consumption (web search, code execution, session fees) and is excluded from the panels.`,
    );
  }
  if (report.meta.priceSources.length > 0) {
    lines.push(`Unit prices: ${report.meta.priceSources.join(', ')}.`);
  }

  const tail = rankedModels.find((model) => model.isOther);
  if (tail?.tailCount) {
    lines.push(
      `The models panel groups the ${tail.tailCount} lowest-total models as "${tail.label}" rather than omitting them; each one's own figure is in modelBreakdowns.`,
    );
  }
  const mixedAgent = rankedModels.filter((model) => model.mixedAgent);
  if (mixedAgent.length > 0) {
    lines.push(
      `${mixedAgent.map((model) => model.label).join(', ')} ${mixedAgent.length === 1 ? 'was' : 'were'} run under more than one agent in this window (${[
        ...new Set(mixedAgent.flatMap((model) => model.agents)),
      ].join(
        ', ',
      )}); the models panel marks ${mixedAgent.length === 1 ? 'it' : 'them'} with the neutral ring rather than either agent's colour.`,
    );
  }

  const warnings = report.meta.notices.filter((notice) => notice.level !== 'info');
  lines.push(
    `${report.meta.tool} ${report.meta.version} · generated ${report.meta.generatedAt}${
      warnings.length > 0 ? ` · ${warnings.length} warning(s) in the report’s meta.notices` : ''
    }`,
  );
  return lines;
}

/**
 * Whether the window contains periods with no rows. The x axis is ordinal — one
 * slot per period *with* usage — so a window with holes must say so.
 */
function gapsIn(report: PeriodReport, rowCount: number): boolean {
  if (report.meta.granularity !== 'daily') return false;
  const { since, until } = report.meta.range;
  const days =
    Math.round(
      (new Date(`${until}T00:00:00Z`).getTime() - new Date(`${since}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1;
  return rowCount > 0 && rowCount < days;
}

function caption(lines: readonly string[], top: number): string[] {
  return [
    `<line x1="${LEFT}" y1="${top - 22}" x2="${LEFT + 300}" y2="${top - 22}" stroke="${TOKEN.rule}" stroke-width="1"/>`,
    ...lines.map((line, index) =>
      text(LEFT, top + index * 15, line, { size: 10.5, fill: TOKEN.subtle }),
    ),
  ];
}

function wrapAll(lines: readonly string[], pixels: number): string[] {
  // Inter averages ~5.4px per character at the caption size.
  const budget = Math.max(40, Math.floor(pixels / 5.4));
  return lines.flatMap((line) => wrap(line, budget));
}

/** Greedy word wrap. The caption is prose and must not run off the page. */
function wrap(line: string, budget: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= budget) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export function periodNoun(report: PeriodReport, plural: boolean): string {
  const noun = report.weekly ? 'Week' : report.monthly ? 'Month' : 'Day';
  return plural ? `${noun}s` : noun;
}

function cadenceOf(report: PeriodReport): string {
  return report.weekly ? 'Weekly' : report.monthly ? 'Monthly' : 'Daily';
}

type TextOptions = {
  size: number;
  fill: string;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  letterSpacing?: number;
};

function text(x: number, y: number, content: string, options: TextOptions): string {
  const attributes = [
    `x="${x}"`,
    `y="${y}"`,
    `font-size="${options.size}"`,
    `fill="${options.fill}"`,
    options.weight ? `font-weight="${options.weight}"` : '',
    options.anchor ? `text-anchor="${options.anchor}"` : '',
    options.letterSpacing ? `letter-spacing="${options.letterSpacing}"` : '',
  ].filter(Boolean);
  return `<text ${attributes.join(' ')}>${escapeXml(content)}</text>`;
}

function rect(x: number, y: number, width: number, height: number, fill: string): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" fill="${fill}"/>`;
}

/** Approximate advance width for Inter at 12px — only used to place labels. */
function labelWidth(label: string): number {
  return label.length * 6.4;
}

function truncate(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

export function compactTokens(value: number): string {
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [scale, suffix] of units) {
    if (value >= scale) return `${(value / scale).toFixed(value / scale >= 10 ? 0 : 1)}${suffix}`;
  }
  return String(Math.round(value));
}

function emptySeries(): Series {
  return {
    key: '',
    label: '',
    colour: TOKEN.highlight,
    vendor: 'other',
    cost: [],
    tokens: [],
    costTotal: 0,
    tokenTotal: 0,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
