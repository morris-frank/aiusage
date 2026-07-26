/**
 * Terminal output.
 *
 * Same information as `--json`, arranged for reading: numbers right-aligned and
 * thousands-separated, cost provenance visible per row, and every warning
 * printed *after* the table so it cannot be mistaken for data. A platform that
 * was skipped or failed still gets a line — the reader must be able to see that
 * a total is incomplete without reading the JSON.
 */

import { formatUsd } from './money.js';
import type { DimensionReport, PeriodReport, ProviderSummary } from './report.js';
import type { Diagnostic, DiagnosticLevel, ProviderCapabilities } from './types.js';

export type Alignment = 'left' | 'right';

export type Column = {
  header: string;
  align?: Alignment;
  /** Cells longer than this are truncated with an ellipsis. */
  maxWidth?: number;
};

export type RenderOptions = {
  color: boolean;
  /** Drop secondary columns for narrow terminals. */
  compact: boolean;
  /** Nest per-model rows under each period. */
  breakdown: boolean;
  includeCost: boolean;
};

const ANSI = {
  reset: '[0m',
  dim: '[2m',
  yellow: '[33m',
  red: '[31m',
} as const;

export function renderTable(columns: readonly Column[], rows: readonly string[][]): string {
  const widths = columns.map((column, index) => {
    const cells = rows.map((row) => row[index] ?? '');
    const longest = Math.max(column.header.length, ...cells.map((cell) => cell.length), 0);
    return column.maxWidth ? Math.min(longest, column.maxWidth) : longest;
  });

  const line = (left: string, mid: string, right: string): string =>
    left + widths.map((width) => '─'.repeat(width + 2)).join(mid) + right;

  const renderRow = (cells: readonly string[]): string =>
    `│ ${cells
      .map((cell, index) =>
        pad(
          truncate(cell, widths[index] ?? 0),
          widths[index] ?? 0,
          columns[index]?.align ?? 'left',
        ),
      )
      .join(' │ ')} │`;

  return [
    line('┌', '┬', '┐'),
    renderRow(columns.map((column) => column.header)),
    line('├', '┼', '┤'),
    ...rows.map(renderRow),
    line('└', '┴', '┘'),
  ].join('\n');
}

function truncate(text: string, width: number): string {
  if (width <= 0 || text.length <= width) return text;
  return width <= 1 ? '…' : `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number, align: Alignment): string {
  const padding = ' '.repeat(Math.max(width - text.length, 0));
  return align === 'right' ? padding + text : text + padding;
}

function num(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

type TokenCells = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

/**
 * One row of the token columns. Period rows, nested model rows and the total row
 * differ only in their leading cells, so they share this builder — which also
 * guarantees the column count matches the header in every mode.
 */
function tokenCells(
  leading: string[],
  tokens: TokenCells,
  total: number,
  cost: number | undefined,
  costSource: string,
  options: RenderOptions,
): string[] {
  const cells = [...leading, num(tokens.inputTokens), num(tokens.outputTokens)];
  if (!options.compact) {
    cells.push(num(tokens.cacheCreationTokens), num(tokens.cacheReadTokens));
  }
  cells.push(num(total));
  if (options.includeCost) cells.push(formatCost(cost), costSource);
  return cells;
}

export function renderPeriodReport(report: PeriodReport, options: RenderOptions): string {
  const rows = report.daily ?? report.weekly ?? report.monthly ?? [];
  const columns: Column[] = [
    { header: periodHeader(report), maxWidth: 12 },
    { header: 'Models', maxWidth: options.compact ? 18 : 34 },
    { header: 'Input', align: 'right' },
    { header: 'Output', align: 'right' },
  ];
  if (!options.compact) {
    columns.push({ header: 'Cache W', align: 'right' }, { header: 'Cache R', align: 'right' });
  }
  columns.push({ header: 'Total', align: 'right' });
  if (options.includeCost) {
    columns.push({ header: 'Cost', align: 'right' }, { header: 'Cost from', maxWidth: 11 });
  }

  const body: string[][] = [];
  for (const row of rows) {
    body.push(
      tokenCells(
        [row.period, row.modelsUsed.join(', ') || '—'],
        row,
        row.totalTokens,
        row.totalCost,
        row.metadata.costSource,
        options,
      ),
    );
    if (!options.breakdown) continue;

    for (const model of row.modelBreakdowns) {
      body.push(
        tokenCells(
          ['', `  ↳ ${model.modelName}`],
          model,
          model.inputTokens +
            model.outputTokens +
            model.cacheCreationTokens +
            model.cacheReadTokens,
          model.cost,
          model.costSource ?? '',
          options,
        ),
      );
    }
  }

  body.push(
    tokenCells(
      ['TOTAL', ''],
      report.totals,
      report.totals.totalTokens,
      report.totals.totalCost,
      report.totals.costSource,
      options,
    ),
  );

  return [
    renderTable(columns, body),
    renderProviderFooter(report.meta.providers, options),
    renderNotices(report.meta.notices, options),
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

function periodHeader(report: PeriodReport): string {
  if (report.weekly) return 'Week of';
  if (report.monthly) return 'Month';
  return 'Date';
}

export function renderDimensionReport(report: DimensionReport, options: RenderOptions): string {
  const columns: Column[] = [
    { header: dimensionHeader(report.dimension), maxWidth: options.compact ? 22 : 40 },
    { header: 'Providers', maxWidth: 22 },
    { header: 'Input', align: 'right' },
    { header: 'Output', align: 'right' },
    { header: 'Total', align: 'right' },
  ];
  if (options.includeCost) {
    columns.push({ header: 'Cost', align: 'right' }, { header: 'Cost from', maxWidth: 11 });
  }

  const body = report.rows.map((row) => {
    const cells = [
      row.name,
      row.providers.join(', '),
      num(row.inputTokens),
      num(row.outputTokens),
      num(row.totalTokens),
    ];
    if (options.includeCost) cells.push(formatCost(row.cost), row.costSource ?? '');
    return cells;
  });

  const totals = [
    'TOTAL',
    '',
    num(report.totals.inputTokens),
    num(report.totals.outputTokens),
    num(report.totals.totalTokens),
  ];
  if (options.includeCost)
    totals.push(formatCost(report.totals.totalCost), report.totals.costSource);
  body.push(totals);

  return [
    renderTable(columns, body),
    renderProviderFooter(report.meta.providers, options),
    renderNotices(report.meta.notices, options),
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

function dimensionHeader(dimension: DimensionReport['dimension']): string {
  switch (dimension) {
    case 'model':
      return 'Model';
    case 'apiKey':
      return 'API key';
    case 'account':
      return 'Account';
    case 'workspace':
      return 'Workspace';
    case 'provider':
      return 'Provider';
  }
}

/** The capability matrix behind `aiusage providers`. */
export function renderProviderMatrix(
  providers: readonly ProviderSummary[],
  options: RenderOptions,
): string {
  const columns: Column[] = [
    { header: 'Provider', maxWidth: 18 },
    { header: 'Status' },
    { header: 'Usage' },
    { header: 'Billed cost' },
    { header: 'Model' },
    { header: 'API key' },
    { header: 'Account' },
    { header: 'Workspace' },
    { header: 'Lookback' },
  ];

  const rows = providers.map((provider) => [
    provider.label,
    provider.status,
    yesNo(provider.capabilities.usage),
    yesNo(provider.capabilities.reportedCost),
    yesNo(provider.capabilities.splitByModel),
    yesNo(provider.capabilities.splitByApiKey),
    yesNo(provider.capabilities.splitByAccount),
    yesNo(provider.capabilities.splitByWorkspace),
    lookback(provider.capabilities),
  ]);

  const identities = providers
    .filter((provider) => provider.identity && Object.keys(provider.identity).length > 0)
    .map((provider) => `${provider.label}: ${describeIdentity(provider)}`);

  return [
    renderTable(columns, rows),
    identities.length > 0 ? paint(identities.join('\n'), ANSI.dim, options.color) : '',
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

function describeIdentity(provider: ProviderSummary): string {
  const identity = provider.identity ?? {};
  return (
    Object.entries(identity)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ') || '—'
  );
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function lookback(capabilities: ProviderCapabilities): string {
  // A platform that is not reporting usage has no lookback to speak of; saying
  // "unlimited" there would read as a capability it does not have right now.
  if (!capabilities.usage) return '—';
  return capabilities.maxLookbackDays === null ? 'unlimited' : `${capabilities.maxLookbackDays}d`;
}

function renderProviderFooter(
  providers: readonly ProviderSummary[],
  options: RenderOptions,
): string {
  const notable = providers.filter((provider) => provider.status !== 'ok');
  if (notable.length === 0) return '';
  const lines = notable.map(
    (provider) =>
      `${provider.label}: ${provider.status}${provider.status === 'unsupported' ? ' (no usage API)' : ''}`,
  );
  return paint(
    `Providers not fully reported:\n${lines.map((line) => `  ${line}`).join('\n')}`,
    ANSI.dim,
    options.color,
  );
}

export function renderNotices(
  notices: readonly Diagnostic[],
  options: RenderOptions,
  minimumLevel: DiagnosticLevel = 'warning',
): string {
  const ranked: Record<DiagnosticLevel, number> = { info: 0, warning: 1, error: 2 };
  const shown = notices.filter((notice) => ranked[notice.level] >= ranked[minimumLevel]);
  if (shown.length === 0) return '';

  const marker: Record<DiagnosticLevel, string> = { info: 'i', warning: '!', error: '✗' };
  const lines = shown.map((notice) => {
    const scope = notice.provider ?? 'aiusage';
    const text = `${marker[notice.level]} [${scope}/${notice.code}] ${notice.message}`;
    const colour =
      notice.level === 'error' ? ANSI.red : notice.level === 'warning' ? ANSI.yellow : ANSI.dim;
    return paint(text, colour, options.color);
  });
  return lines.join('\n');
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return '—';
  return formatUsd(Math.round(cost * 1_000_000));
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}
