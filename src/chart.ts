/**
 * The report figure: a two-panel chart, rendered as a self-contained SVG.
 *
 * Same question the terminal table answers, arranged so distribution and
 * accumulation are both visible on one shared time axis:
 *
 *   - **top panel** — cost per period, stacked by series (provider by default),
 *     so composition and the peak period read off directly;
 *   - **bottom panel** — the cumulative total per series, each line labelled at
 *     its end point, so identity never depends on colour alone.
 *
 * Two measures on different scales get two panels, never two y-axes on one.
 *
 * Provenance is part of the figure, not an afterthought: the caption states the
 * window, the cost provenance of the numbers plotted, the price sources, and any
 * source that did not fully report. A figure that gets forwarded without its
 * table must still be impossible to over-read.
 *
 * Visual language: Soilytix — flat, hairline rules, no gradients, no shadows,
 * Inter, white surface (this is a report, not a slide), obsidian ink, lime-ink
 * eyebrow and rules, mint as the one primary highlight.
 */

import type { SplitDimension } from './aggregate.js';
import { formatUsd } from './money.js';
import type { DimensionBreakdown, PeriodReport, ReportRow } from './report.js';

/** Design tokens, from the Soilytix design system (`colors_and_type.css`). */
const TOKEN = {
  surface: '#FFFFFF',
  ink: '#29332E',
  body: '#233A2E',
  muted: '#6C7E72',
  subtle: '#93A89B',
  rule: '#E4E7DC',
  grid: '#E8EBE0',
  eyebrow: '#4A7A0F',
  highlight: '#1AB172',
  font: "Inter, 'Helvetica Neue', Arial, sans-serif",
} as const;

/**
 * Series colours: mint first — the largest series is the one primary highlight —
 * then the categorical accents (level 350) and the neutral charcoal role. Azure
 * is deliberately absent: the current system has no blue.
 */
const SERIES_COLOURS = [
  '#1AB172', // mint (primary highlight)
  '#E07724', // copper
  '#D76EB9', // rose
  '#D28000', // gold
  '#4A4A44', // charcoal (neutral role)
  '#EA6B65', // ember
  '#00AA8E', // teal
  '#B48240', // earth gold
] as const;

export type ChartOptions = {
  /** Which breakdown to draw as series; `provider` unless asked otherwise. */
  series: SplitDimension;
  /** False when `--no-cost`: the panels then plot tokens. */
  includeCost: boolean;
  width?: number;
};

type Series = {
  key: string;
  label: string;
  colour: string;
  /** One value per period, in period order. */
  values: number[];
  total: number;
};

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
  const rows = report.daily ?? report.weekly ?? report.monthly ?? [];
  const width = options.width ?? 960;
  const series = buildSeries(rows, options);
  const value = (row: ReportRow): number => measure(row, options);

  const left = 76;
  const right = width - 168; // room for the end labels of the cumulative lines
  const captionText = captionLines(report, options, series).flatMap((line) =>
    wrap(line, charBudget(width - left * 2)),
  );

  const legendRows = Math.max(1, Math.ceil(series.length / 4));
  const legendTop = 126;
  const panelTop = legendTop + legendRows * 22 + 26;
  const panelHeight = 176;
  const gap = 78;
  const panel1 = { top: panelTop, bottom: panelTop + panelHeight };
  const panel2 = { top: panel1.bottom + gap, bottom: panel1.bottom + gap + panelHeight };
  const captionTop = panel2.bottom + 58;
  const height = captionTop + captionText.length * 15 + 16;

  const dailyMax = Math.max(0, ...rows.map(value));
  // The cumulative panel draws one line per series, so its ceiling is the largest
  // single series — not the sum, which would leave every line squashed at the floor.
  const cumulativeMax = Math.max(0, ...series.map((entry) => entry.total));

  const parts: string[] = [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${TOKEN.surface}"/>`,
    ...header(report, options, width, series),
    ...legend(series, left, legendTop, width, options),
    ...panel(cadenceOf(report), options.includeCost ? 'cost' : 'tokens', left, panel1),
    ...gridAndTicks(left, right, panel1, dailyMax, options),
    ...stackedBars(rows, series, left, right, panel1, dailyMax),
    ...axisDates(rows, left, right, panel1.bottom),
    ...panel('Cumulative', options.includeCost ? 'cost' : 'tokens', left, panel2),
    ...gridAndTicks(left, right, panel2, cumulativeMax, options),
    ...cumulativeLines(series, left, right, panel2, cumulativeMax, options),
    ...axisDates(rows, left, right, panel2.bottom),
    ...caption(captionLines(report, options, series), left, captionTop, width),
  ];

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${TOKEN.font}" role="img">`,
    `<title>${escapeXml(titleOf(options))}</title>`,
    parts.join('\n'),
    '</svg>',
  ].join('\n');
}

function titleOf(options: ChartOptions): string {
  const noun = SERIES_NOUN[options.series];
  return options.includeCost ? `LLM spend by ${noun}` : `LLM token usage by ${noun}`;
}

function measure(row: ReportRow, options: ChartOptions): number {
  return options.includeCost ? (row.totalCost ?? 0) : row.totalTokens;
}

function measureBreakdown(breakdown: DimensionBreakdown, options: ChartOptions): number {
  return options.includeCost ? (breakdown.cost ?? 0) : breakdown.totalTokens;
}

function buildSeries(rows: readonly ReportRow[], options: ChartOptions): Series[] {
  const key = BREAKDOWN_KEY[options.series];
  const totals = new Map<string, { label: string; values: number[] }>();

  rows.forEach((row, index) => {
    const breakdowns = (row[key] as DimensionBreakdown[] | undefined) ?? [];
    for (const breakdown of breakdowns) {
      const id = breakdown.id ?? breakdown.name;
      const found = totals.get(id) ?? {
        label: breakdown.name || id,
        values: new Array<number>(rows.length).fill(0),
      };
      const at = found.values[index] ?? 0;
      found.values[index] = at + measureBreakdown(breakdown, options);
      totals.set(id, found);
    }
  });

  return (
    [...totals.entries()]
      .map(([id, entry]) => ({
        key: id,
        label: entry.label,
        colour: TOKEN.highlight,
        values: entry.values,
        total: entry.values.reduce((sum, one) => sum + one, 0),
      }))
      // Largest first, so the primary highlight lands on the series that matters
      // and the stack order is stable across renders.
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
      .map((entry, index) => ({
        ...entry,
        colour: SERIES_COLOURS[index % SERIES_COLOURS.length] ?? TOKEN.highlight,
      }))
  );
}

function header(
  report: PeriodReport,
  options: ChartOptions,
  width: number,
  series: readonly Series[],
): string[] {
  const total = series.reduce((sum, entry) => sum + entry.total, 0);
  const rows = report.daily ?? report.weekly ?? report.monthly ?? [];
  const active = rows.filter((row) => measure(row, options) > 0).length;
  const { since, until } = report.meta.range;

  return [
    text(76, 34, 'AIUSAGE REPORT', {
      size: 10.5,
      fill: TOKEN.eyebrow,
      weight: 600,
      letterSpacing: 1.6,
    }),
    // Lime ink carries the title and the rule below it; Mint is reserved for the
    // one data highlight, so the two greens never compete.
    text(76, 64, titleOf(options), { size: 27, fill: TOKEN.eyebrow, weight: 300 }),
    text(
      76,
      88,
      `${since} to ${until} · ${formatMeasure(total, options)} across ${active} active ${periodNoun(report, active !== 1).toLowerCase()} · grouped ${report.meta.granularity} in ${report.meta.timezone}`,
      { size: 12.5, fill: TOKEN.muted },
    ),
    // The one key rule, in lime ink.
    `<line x1="76" y1="100" x2="${width - 76}" y2="100" stroke="${TOKEN.eyebrow}" stroke-width="1"/>`,
  ];
}

function legend(
  series: readonly Series[],
  left: number,
  top: number,
  width: number,
  options: ChartOptions,
): string[] {
  const parts: string[] = [];
  const columns = Math.min(4, Math.max(1, series.length));
  const columnWidth = (width - left - 92) / columns;

  series.forEach((entry, index) => {
    const x = left + (index % columns) * columnWidth;
    const y = top + Math.floor(index / columns) * 22;
    parts.push(`<circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${entry.colour}"/>`);
    parts.push(
      text(x + 17, y, truncate(entry.label, 26), { size: 12, fill: TOKEN.body }),
      text(
        x + 17 + labelWidth(truncate(entry.label, 26)) + 8,
        y,
        formatMeasure(entry.total, options),
        {
          size: 11.5,
          fill: TOKEN.subtle,
        },
      ),
    );
  });
  return parts;
}

function panel(
  label: string,
  measureName: string,
  left: number,
  bounds: { top: number; bottom: number },
): string[] {
  return [
    text(left, bounds.top - 12, `${label} ${measureName}`, {
      size: 11,
      fill: TOKEN.muted,
      letterSpacing: 0.3,
    }),
  ];
}

function periodNoun(report: PeriodReport, plural: boolean): string {
  const noun = report.weekly ? 'Week' : report.monthly ? 'Month' : 'Day';
  return plural ? `${noun}s` : noun;
}

function cadenceOf(report: PeriodReport): string {
  return report.weekly ? 'Weekly' : report.monthly ? 'Monthly' : 'Daily';
}

type Scale = (value: number) => number;

function scaleOf(bounds: { top: number; bottom: number }, max: number): Scale {
  // A flat all-zero window still needs a usable axis rather than a divide by zero.
  const span = max > 0 ? max : 1;
  return (value) => bounds.bottom - (value / span) * (bounds.bottom - bounds.top);
}

/**
 * The axis tops out at the next round tick above the data, so gridlines bracket
 * the tallest bar instead of it running into the panel's edge.
 */
function axisMax(max: number): number {
  const step = niceStep(max);
  return Math.max(step, Math.ceil(max / step) * step);
}

function gridAndTicks(
  left: number,
  right: number,
  bounds: { top: number; bottom: number },
  max: number,
  options: ChartOptions,
): string[] {
  const step = niceStep(max);
  const top = axisMax(max);
  const y = scaleOf(bounds, top);
  const parts: string[] = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    const at = y(value);
    if (at < bounds.top - 1) break;
    parts.push(
      `<line x1="${left}" y1="${round(at)}" x2="${right}" y2="${round(at)}" stroke="${TOKEN.grid}" stroke-width="1"/>`,
    );
    parts.push(
      text(left - 10, round(at) + 4, formatMeasure(value, options), {
        size: 11,
        fill: TOKEN.muted,
        anchor: 'end',
      }),
    );
  }
  return parts;
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

function slots(
  count: number,
  left: number,
  right: number,
): { centre: (index: number) => number; width: number } {
  const usable = right - left;
  const slot = count > 0 ? usable / count : usable;
  return { centre: (index) => left + slot * (index + 0.5), width: slot };
}

function stackedBars(
  rows: readonly ReportRow[],
  series: readonly Series[],
  left: number,
  right: number,
  bounds: { top: number; bottom: number },
  max: number,
): string[] {
  const { centre, width } = slots(rows.length, left, right);
  const y = scaleOf(bounds, axisMax(max));
  const barWidth = Math.max(2, Math.min(22, width * 0.62));
  const parts: string[] = [];

  rows.forEach((_row, index) => {
    let base = 0;
    for (const entry of series) {
      const value = entry.values[index] ?? 0;
      if (value <= 0) continue;
      const top = y(base + value);
      const bottom = y(base);
      base += value;
      const heightPx = Math.max(0.6, bottom - top);
      parts.push(
        `<rect x="${round(centre(index) - barWidth / 2)}" y="${round(top)}" width="${round(barWidth)}" height="${round(heightPx)}" fill="${entry.colour}"/>`,
      );
    }
  });

  // Baseline: a hairline, not a heavy axis.
  parts.push(
    `<line x1="${left}" y1="${bounds.bottom}" x2="${right}" y2="${bounds.bottom}" stroke="${TOKEN.rule}" stroke-width="1"/>`,
  );
  return parts;
}

function cumulativeLines(
  series: readonly Series[],
  left: number,
  right: number,
  bounds: { top: number; bottom: number },
  max: number,
  options: ChartOptions,
): string[] {
  const count = series[0]?.values.length ?? 0;
  const { centre } = slots(count, left, right);
  const y = scaleOf(bounds, axisMax(max));
  const parts: string[] = [];

  const ends: { label: string; colour: string; x: number; y: number; total: number }[] = [];
  for (const entry of series) {
    let running = 0;
    const points = entry.values.map((value, index) => {
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
        x: centre(count - 1),
        y: y(running),
        total: running,
      });
    }
  }

  // Direct labels are the secondary encoding: with them, no series depends on
  // hue alone to be identified. Labels are pushed apart, then the whole group is
  // lifted if it would run off the bottom of the panel.
  const ordered = ends.sort((a, b) => a.y - b.y);
  const positions: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const end of ordered) {
    const at = Math.max(end.y, previous + 14);
    positions.push(at);
    previous = at;
  }
  // Keep the lowest label clear of the date axis below the panel.
  const overflow = (positions.at(-1) ?? 0) - (bounds.bottom - 6);
  if (overflow > 0) {
    for (let index = 0; index < positions.length; index += 1) {
      positions[index] = (positions[index] ?? 0) - overflow;
    }
  }

  ordered.forEach((end, index) => {
    parts.push(`<circle cx="${round(end.x)}" cy="${round(end.y)}" r="3" fill="${end.colour}"/>`);
    parts.push(
      text(
        round(end.x) + 9,
        round(positions[index] ?? end.y) + 4,
        `${truncate(end.label, 18)}  ${formatMeasure(end.total, options)}`,
        { size: 11.5, fill: TOKEN.body },
      ),
    );
  });
  parts.push(
    `<line x1="${left}" y1="${bounds.bottom}" x2="${right}" y2="${bounds.bottom}" stroke="${TOKEN.rule}" stroke-width="1"/>`,
  );
  return parts;
}

function axisDates(
  rows: readonly ReportRow[],
  left: number,
  right: number,
  baseline: number,
): string[] {
  if (rows.length === 0) return [];
  const { centre } = slots(rows.length, left, right);
  // Label at most ~8 periods; a crowded axis is unreadable and the caption
  // carries the exact window anyway.
  const stride = Math.max(1, Math.ceil(rows.length / 8));
  const parts: string[] = [];
  rows.forEach((row, index) => {
    if (index % stride !== 0 && index !== rows.length - 1) return;
    parts.push(
      text(round(centre(index)), baseline + 18, row.period, {
        size: 10.5,
        fill: TOKEN.muted,
        anchor: 'middle',
      }),
    );
  });
  return parts;
}

/**
 * The provenance block. Everything a reader needs to not over-trust the figure:
 * how the plotted money was established, where prices came from, and which
 * sources are missing from it.
 */
function captionLines(
  report: PeriodReport,
  options: ChartOptions,
  series: readonly Series[],
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

  if (series.length === 0) {
    lines.push(`No ${noun} breakdown was available, so no series could be drawn.`);
  }

  const rows = report.daily ?? report.weekly ?? report.monthly ?? [];
  if (gapsIn(report, rows.length)) {
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

function caption(lines: readonly string[], left: number, top: number, width: number): string[] {
  const wrapped = lines.flatMap((line) => wrap(line, charBudget(width - left * 2)));
  return [
    `<line x1="${left}" y1="${top - 22}" x2="${left + 300}" y2="${top - 22}" stroke="${TOKEN.rule}" stroke-width="1"/>`,
    ...wrapped.map((line, index) =>
      text(left, top + index * 15, line, { size: 10.5, fill: TOKEN.subtle }),
    ),
  ];
}

/** Characters that fit in `pixels` at the caption size — Inter averages ~5.4px. */
function charBudget(pixels: number): number {
  return Math.max(40, Math.floor(pixels / 5.4));
}

/** Greedy word wrap. The caption is prose and must not run off the page. */
function wrap(line: string, budget: number): string[] {
  const words = line.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
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

/** Approximate advance width for Inter at 12px — only used to place legend amounts. */
function labelWidth(label: string): number {
  return label.length * 6.4;
}

function truncate(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

function formatMeasure(value: number, options: ChartOptions): string {
  if (!options.includeCost) return compactTokens(value);
  if (value === 0) return '$0';
  return formatUsd(Math.round(value * 1_000_000));
}

function compactTokens(value: number): string {
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

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The printable wrapper: the same figure on a white page with the period table
 * under it. Reports, documents and email are the white surfaces in this visual
 * language — bone is for slides and app UI.
 */
export function renderReportHtml(report: PeriodReport, options: ChartOptions): string {
  const rows = report.daily ?? report.weekly ?? report.monthly ?? [];
  const svg = renderReportSvg(report, options);
  const cell = (value: string, align = 'right'): string =>
    `<td style="text-align:${align}">${escapeXml(value)}</td>`;

  const body = rows
    .map((row) =>
      [
        '<tr>',
        cell(row.period, 'left'),
        cell(row.modelsUsed.join(', ') || '—', 'left'),
        cell(row.inputTokens.toLocaleString('en-US')),
        cell(row.outputTokens.toLocaleString('en-US')),
        cell(row.totalTokens.toLocaleString('en-US')),
        cell(options.includeCost ? formatUsd(Math.round((row.totalCost ?? 0) * 1e6)) : '—'),
        cell(row.metadata.costSource, 'left'),
        '</tr>',
      ].join(''),
    )
    .join('\n');

  const notices = report.meta.notices
    .map(
      (notice) =>
        `<li><code>${escapeXml(`${notice.provider ?? 'aiusage'}/${notice.code}`)}</code> ${escapeXml(notice.message)}</li>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(titleOf(options))} — aiusage</title>
<style>
  :root {
    --ink: ${TOKEN.ink}; --fg: ${TOKEN.body}; --muted: ${TOKEN.muted};
    --subtle: ${TOKEN.subtle}; --rule: ${TOKEN.rule}; --eyebrow: ${TOKEN.eyebrow};
  }
  /* White page: this is a report, and bone prints muddy. */
  body { margin: 0; background: #fff; color: var(--fg);
         font-family: ${TOKEN.font}; font-size: 15px; line-height: 1.6; }
  main { max-width: 1040px; margin: 0 auto; padding: 40px 24px 72px; }
  svg { width: 100%; height: auto; }
  h2 { font-size: 18px; font-weight: 400; color: var(--ink); margin: 40px 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px;
          font-variant-numeric: tabular-nums; }
  th, td { padding: 6px 10px; border-bottom: 1px solid var(--rule); }
  th { text-align: right; font-weight: 500; color: var(--muted); font-size: 11px;
       letter-spacing: 0.04em; text-transform: uppercase; }
  th:first-child, th:nth-child(2), th:last-child { text-align: left; }
  ul { padding-left: 18px; color: var(--muted); font-size: 12.5px; }
  code { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 0.92em;
         color: var(--eyebrow); }
  @media print { main { padding: 0; } h2 { break-after: avoid; } }
</style>
</head>
<body>
<main>
${svg}
<h2>${escapeXml(periodNoun(report, true))}</h2>
<table>
<thead><tr><th>${escapeXml(periodNoun(report, false))}</th><th>Models</th><th>Input</th><th>Output</th><th>Total tokens</th><th>Cost</th><th>Cost from</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
${notices ? `<h2>Notices</h2>\n<ul>\n${notices}\n</ul>` : ''}
</main>
</body>
</html>
`;
}
