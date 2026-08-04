/**
 * The printable report page: the figure, a summary strip, the period table and
 * the run's provenance, on a white surface.
 *
 * The table is the part people read twice, so it carries the shape of the numbers
 * as well as the numbers: a proportional bar behind each cost, a four-segment
 * mini bar for each period's token mix, a vendor mark per source, and a badge
 * naming the cost provenance of every row. Nothing here is decoration for its own
 * sake — each one answers "how big, made of what, from where" without a second
 * lookup.
 *
 * White page, hairline borders, no shadows: reports and documents are the white
 * surfaces in this visual language, and bone prints muddy.
 */

import type { CostSource } from '../cost.js';
import { formatUsd } from '../money.js';
import type { PeriodReport, ProviderSummary, ReportRow } from '../report.js';
import {
  type ChartOptions,
  compactTokens,
  periodNoun,
  periodsOf,
  renderReportSvg,
  titleOf,
} from './figure.js';
import { escapeXml, TOKEN, TOKEN_CLASSES, vendorColour, vendorMark, vendorOf } from './tokens.js';

export function renderReportHtml(report: PeriodReport, options: ChartOptions): string {
  const rows = periodsOf(report);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(titleOf(options))} — aiusage</title>
<style>
${styles()}
</style>
</head>
<body>
<main>
${headerBlock(report, options)}
${cards(report, options)}
<figure>
${renderReportSvg(report, { ...options, header: false })}
${figureCaption(report, options)}
</figure>
${periodTable(report, rows, options)}
${sourceTable(report, options)}
${noticeList(report)}
</main>
</body>
</html>
`;
}

function styles(): string {
  return `:root {
  --ink: ${TOKEN.ink}; --fg: ${TOKEN.body}; --muted: ${TOKEN.muted}; --subtle: ${TOKEN.subtle};
  --rule: ${TOKEN.rule}; --grid: ${TOKEN.grid}; --lime: ${TOKEN.eyebrow};
  --mint: ${TOKEN.highlight}; --mint-ink: ${TOKEN.highlightInk};
  --soft: ${TOKEN.accentSoft}; --soft-ink: ${TOKEN.accentSoftInk}; --cream: ${TOKEN.cream};
  --warn: ${TOKEN.warn}; --warn-soft: ${TOKEN.warnSoft}; --warn-soft-ink: ${TOKEN.warnSoftInk};
}
/* White page: this is a report, and bone prints muddy. */
body { margin: 0; background: #fff; color: var(--fg); font-family: ${TOKEN.font};
       font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
main { max-width: 1100px; margin: 0 auto; padding: 40px 28px 80px; }
figure { margin: 32px 0 0; }
svg { width: 100%; height: auto; display: block; }
figcaption { max-width: 78ch; margin: 12px 0 0; color: var(--muted); font-size: 12px; }

.eyebrow { font-size: 10.5px; font-weight: 600; letter-spacing: 0.16em; color: var(--lime);
           text-transform: uppercase; }
h1 { font-size: 34px; font-weight: 300; line-height: 1.15; color: var(--lime);
     margin: 6px 0 6px; letter-spacing: -0.01em; }
.lede { color: var(--muted); font-size: 13.5px; margin: 0 0 18px; }
.rule { height: 1px; background: var(--lime); margin: 0 0 28px; }
h2 { font-size: 17px; font-weight: 400; color: var(--ink); margin: 44px 0 4px; }
h2 + .note { margin: 0 0 14px; }
.note { color: var(--muted); font-size: 12.5px; }

/* Summary strip — hairline cards, flat. Numbers light and large; one Mint value. */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--rule); border-radius: 14px; padding: 16px 18px; }
.card .label { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase;
               color: var(--muted); }
.card .value { font-size: 27px; font-weight: 300; color: var(--ink); line-height: 1.25;
               font-variant-numeric: tabular-nums; margin-top: 4px; }
.card .value.primary { color: var(--mint-ink); }
.card .sub { font-size: 11.5px; color: var(--subtle); }

table { width: 100%; border-collapse: collapse; font-size: 12.5px;
        font-variant-numeric: tabular-nums; }
caption { text-align: left; color: var(--muted); font-size: 12.5px; padding: 0 0 12px; }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
thead th { position: sticky; top: 0; background: #fff; text-align: right; font-weight: 500;
           color: var(--muted); font-size: 10.5px; letter-spacing: 0.06em;
           text-transform: uppercase; padding: 8px 10px; border-bottom: 1px solid var(--rule); }
thead th.left { text-align: left; }
tbody td { padding: 7px 10px; border-bottom: 1px solid var(--grid); text-align: right;
           vertical-align: middle; }
tbody td.left { text-align: left; }
tbody tr:last-child td { border-bottom: 1px solid var(--rule); }
tfoot td { padding: 9px 10px; text-align: right; font-weight: 500; color: var(--ink);
           border-top: 1px solid var(--ink); }
tfoot td.left { text-align: left; }
.period { color: var(--ink); white-space: nowrap; }

/* Chips and marks */
.marks { display: inline-flex; gap: 5px; align-items: center; }
.marks svg { width: 13px; height: 13px; display: inline-block; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { font-size: 10.5px; padding: 1px 7px; border: 1px solid var(--rule); border-radius: 9999px;
        color: var(--muted); white-space: nowrap; }
.chip.more { border-style: dashed; }

/* A cost cell carries its own scale: the bar is the row's share of the largest. */
.amount { display: block; }
.bar { display: block; height: 3px; margin: 3px 0 0 auto; background: var(--mint); }
.bar.dim { background: var(--rule); }

/* Token mix, four ordered segments — the same ramp the figure uses. */
.mix { display: flex; height: 5px; width: 68px; margin: 4px 0 0 auto; }
.mix span { display: block; height: 100%; }

.badge { display: inline-block; font-size: 10px; letter-spacing: 0.04em; padding: 2px 7px;
         border-radius: 9999px; white-space: nowrap; }
/* Treatments derive from the system's accent-soft and warn tints, not new hexes. */
.badge.reported, .badge.imported, .badge.allocated { background: var(--soft); color: var(--soft-ink); }
.badge.calculated { background: var(--cream); color: var(--muted); }
/* "mixed" is heterogeneous, not a risk; only an absent figure gets the warn tint. */
.badge.mixed { background: var(--cream); color: var(--muted); }
.badge.unavailable { background: var(--warn-soft); color: var(--warn-soft-ink); }
.badge.ok { background: var(--soft); color: var(--soft-ink); }
.badge.partial, .badge.unsupported, .badge.skipped { background: var(--cream); color: var(--muted); }
.badge.error { background: var(--warn-soft); color: var(--warn-soft-ink); }
.notices { margin: 10px 0 0; padding-left: 20px; color: var(--muted); font-size: 12.5px; }
.notices li { margin: 5px 0; }
.notice-code { color: var(--ink); font-family: ${TOKEN.mono}; font-size: 11px; }

.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
           overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media print {
  main { padding: 0; max-width: none; }
  thead th { position: static; }
  h2 { break-after: avoid; }
  tbody tr { break-inside: avoid; }
  .table-scroll { overflow: visible; }
}`;
}

function headerBlock(report: PeriodReport, options: ChartOptions): string {
  const { since, until } = report.meta.range;
  return `<p class="eyebrow">aiusage report</p>
<h1>${escapeXml(titleOf(options))}</h1>
<p class="lede">${escapeXml(
    `${since} to ${until} · grouped ${report.meta.granularity} in ${report.meta.timezone} · generated ${report.meta.generatedAt}`,
  )}</p>
<div class="rule"></div>`;
}

function cards(report: PeriodReport, options: ChartOptions): string {
  const rows = periodsOf(report);
  const active = rows.filter((row) => row.totalTokens > 0).length;
  const cacheRead = report.totals.cacheReadTokens;
  const share = report.totals.totalTokens > 0 ? (cacheRead / report.totals.totalTokens) * 100 : 0;

  const entries: { label: string; value: string; sub: string; primary?: boolean }[] = [
    {
      label: 'Total cost',
      value: options.includeCost
        ? formatUsd(Math.round((report.totals.totalCost ?? 0) * 1e6))
        : '—',
      // The provenance travels with the number, never a footnote away from it.
      sub: options.includeCost ? `${report.totals.costSource}` : 'not collected (--no-cost)',
      primary: true,
    },
    {
      label: 'Total tokens',
      value: compactTokens(report.totals.totalTokens),
      sub: `${report.totals.totalTokens.toLocaleString('en-US')} across all classes`,
    },
    {
      label: `Active ${periodNoun(report, true).toLowerCase()}`,
      value: String(active),
      sub: `of ${rows.length} with usage in range`,
    },
    {
      label: 'Cache reads',
      value: `${share.toFixed(0)}%`,
      sub: 'of all tokens read from cache',
    },
  ];

  // Both derived statistics are absent when the collected grain cannot support
  // them, and a card is only shown when its number exists — an empty card would
  // read as a measured zero.
  const timeOfDay = report.statistics.timeOfDay;
  if (timeOfDay && timeOfDay.peakHour !== null) {
    const peak = timeOfDay.hours.find((hour) => hour.hour === timeOfDay.peakHour);
    entries.push({
      label: 'Busiest hour',
      value: `${String(timeOfDay.peakHour).padStart(2, '0')}:00`,
      sub: `${report.meta.timezone}, over ${peak?.activeDays ?? 0} ${
        (peak?.activeDays ?? 0) === 1 ? 'day' : 'days'
      } · ${timeOfDay.sources.join(', ')} only`,
    });
  }
  const concentration = report.statistics.concentration;
  if (concentration && concentration.activePeriods > 1) {
    entries.push({
      label: 'Concentration',
      value: `${(concentration.topDecileShare * 100).toFixed(0)}%`,
      sub: `of ${concentration.measure} in the busiest ${concentration.topDecilePeriods} of ${concentration.activePeriods} ${periodNoun(report, true).toLowerCase()}`,
    });
  }

  return `<div class="cards">
${entries
  .map(
    (entry) => `  <div class="card">
    <div class="label">${escapeXml(entry.label)}</div>
    <div class="value${entry.primary ? ' primary' : ''}">${escapeXml(entry.value)}</div>
    <div class="sub">${escapeXml(entry.sub)}</div>
  </div>`,
  )
  .join('\n')}
</div>`;
}

function figureCaption(report: PeriodReport, options: ChartOptions): string {
  const cost = options.includeCost
    ? `Cost is ${report.totals.costSource}; definitions and price sources are carried inside the figure.`
    : 'Cost was not collected, so the figure shows tokens only.';
  return `<figcaption>${escapeXml(
    `Shared, zero-based scales support comparison by position and length. ${cost} Exact values and source status follow below.`,
  )}</figcaption>`;
}

function periodTable(
  report: PeriodReport,
  rows: readonly ReportRow[],
  options: ChartOptions,
): string {
  const maxCost = Math.max(0, ...rows.map((row) => row.totalCost ?? 0));
  const maxTokens = Math.max(0, ...rows.map((row) => row.totalTokens));
  const noun = periodNoun(report, false);

  const body = rows
    .map((row) => {
      const cells = [
        `<td class="left period">${escapeXml(row.period)}</td>`,
        `<td class="left">${marks(row.metadata.agents.length > 0 ? row.metadata.agents : row.metadata.providers)}</td>`,
        `<td class="left">${chips(row.modelsUsed)}</td>`,
        number(row.inputTokens),
        number(row.outputTokens),
        number(row.cacheCreationTokens),
        number(row.cacheReadTokens),
        `<td>${escapeXml(compactTokens(row.totalTokens))}${mixBar(row)}${
          maxTokens > 0 ? '' : ''
        }</td>`,
      ];
      if (options.includeCost) {
        cells.push(costCell(row.totalCost ?? 0, maxCost));
      }
      return `  <tr>${cells.join('')}</tr>`;
    })
    .join('\n');

  const totalCells = [
    `<td class="left">Total</td>`,
    '<td></td>',
    '<td></td>',
    number(report.totals.inputTokens),
    number(report.totals.outputTokens),
    number(report.totals.cacheCreationTokens),
    number(report.totals.cacheReadTokens),
    `<td>${escapeXml(compactTokens(report.totals.totalTokens))}</td>`,
  ];
  if (options.includeCost) {
    totalCells.push(
      `<td>${escapeXml(formatUsd(Math.round((report.totals.totalCost ?? 0) * 1e6)))}</td>`,
    );
  }

  const head = ['', 'Sources', 'Models', 'Input', 'Output', 'Cache W', 'Cache R', 'Tokens'];
  if (options.includeCost) head.push('Cost');

  return `<h2>${escapeXml(periodNoun(report, true))}</h2>
<div class="table-scroll">
<table>
<caption>One row per ${noun.toLowerCase()} with usage. Cost bars share a common scale; the four-segment bar shows that ${noun.toLowerCase()}'s token mix (input, output, cache write, cache read).</caption>
<thead><tr>${head
    .map((label, index) =>
      index < 3
        ? `<th scope="col" class="left">${escapeXml(label || noun)}</th>`
        : `<th scope="col">${escapeXml(label)}</th>`,
    )
    .join('')}</tr></thead>
<tbody>
${body}
</tbody>
<tfoot><tr>${totalCells.join('')}</tr></tfoot>
</table>
</div>`;
}

function sourceTable(report: PeriodReport, options: ChartOptions): string {
  const answered = (provider: ProviderSummary): string => {
    const splits = [
      provider.capabilities.splitByModel ? 'model' : null,
      provider.capabilities.splitByApiKey ? 'key' : null,
      provider.capabilities.splitByAccount ? 'account' : null,
      provider.capabilities.splitByWorkspace ? 'workspace' : null,
      // Not a split, but the same kind of fact and the one that decides whether
      // a source appears in the time-of-day panels at all.
      provider.capabilities.hourly ? 'hourly' : null,
    ].filter((value): value is string => value !== null);
    return splits.length > 0 ? chips(splits, 5) : '<span class="chip">no splits</span>';
  };

  const body = report.meta.providers
    .map((provider) => {
      // Find all notices for this provider to show as tooltip
      const providerNotices = report.meta.notices.filter((n) => n.provider === provider.id);
      const tooltip =
        providerNotices.length > 0
          ? ` title="${escapeXml(providerNotices.map((n) => `[${n.code}] ${n.message}`).join(' | '))}"`
          : '';

      return `  <tr>
    <td class="left"${tooltip}>${marks([provider.id])} ${escapeXml(provider.label)}${providerNotices.length > 0 ? ' *' : ''}</td>
    <td class="left">${badge(provider.status)}</td>
    <td>${provider.recordCount.toLocaleString('en-US')}</td>
    ${options.includeCost ? `<td>${escapeXml(formatUsd(Math.round((provider.totalCost ?? 0) * 1e6)))}</td>` : ''}
    <td class="left">${answered(provider)}</td>
  </tr>`;
    })
    .join('\n');

  return `<h2>Sources</h2>
<div class="table-scroll">
<table>
<caption>What each source actually answered for this run. A non-<code>ok</code> source may leave the totals incomplete; absent usage is unknown, not zero. A source without <code>hourly</code> reported whole days and is absent from the time-of-day panels.</caption>
<thead><tr><th scope="col" class="left">Source</th><th scope="col" class="left">Status</th><th scope="col">Rows</th>${
    options.includeCost ? '<th scope="col">Cost</th>' : ''
  }<th scope="col" class="left">Answered</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
</div>`;
}

function noticeList(report: PeriodReport): string {
  if (report.meta.notices.length === 0) return '';
  const items = report.meta.notices
    .map(
      (notice) =>
        `<li><span class="notice-code">${escapeXml(notice.code)}</span> — ${escapeXml(notice.message)}</li>`,
    )
    .join('\n');
  return `<h2>Notices</h2>
<p class="note">Diagnostics emitted by the collection and costing run. These are visible text, not tooltip-only metadata.</p>
<ul class="notices">
${items}
</ul>`;
}

function number(value: number): string {
  return `<td>${value.toLocaleString('en-US')}</td>`;
}

function costCell(cost: number, max: number): string {
  const share = max > 0 ? Math.max(cost / max, 0) : 0;
  const width = (share * 100).toFixed(1);
  return `<td><span class="amount">${escapeXml(formatUsd(Math.round(cost * 1e6)))}</span><span class="bar${
    cost > 0 ? '' : ' dim'
  }" style="width:${width}%"></span></td>`;
}

function mixBar(row: ReportRow): string {
  const counts: Record<string, number> = {
    input: row.inputTokens,
    output: row.outputTokens,
    cacheCreation: row.cacheCreationTokens,
    cacheRead: row.cacheReadTokens,
  };
  const total = Object.values(counts).reduce((sum, one) => sum + one, 0);
  if (total <= 0) return '';
  const segments = TOKEN_CLASSES.map((klass) => {
    const share = ((counts[klass.key] ?? 0) / total) * 100;
    return share > 0
      ? `<span style="width:${share.toFixed(1)}%;background:${klass.colour}" title="${escapeXml(klass.label)}"><span class="sr-only">${escapeXml(klass.label)} ${share.toFixed(1)}%</span></span>`
      : '';
  }).join('');
  return `<span class="mix">${segments}</span>`;
}

function badge(kind: CostSource | 'mixed' | string): string {
  return `<span class="badge ${escapeXml(kind)}">${escapeXml(kind)}</span>`;
}

/** Vendor marks for a set of source names, deduplicated by mark. */
function marks(names: readonly string[]): string {
  const vendors = [...new Set(names.map(vendorOf))];
  const inner = vendors
    .map(
      (vendor) =>
        `<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">${vendorMark(vendor, 0.5, 0.5, 12, vendorColour(vendor))}</svg>`,
    )
    .join('');
  return `<span class="marks" title="${escapeXml(names.join(', '))}">${inner}</span>`;
}

function chips(values: readonly string[], limit = 3): string {
  if (values.length === 0) return '<span class="chip">—</span>';
  const shown = values
    .slice(0, limit)
    .map((value) => `<span class="chip">${escapeXml(value)}</span>`);
  if (values.length > limit) {
    shown.push(`<span class="chip more">+${values.length - limit}</span>`);
  }
  return `<span class="chips">${shown.join('')}</span>`;
}
