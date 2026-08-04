#!/usr/bin/env node
/**
 * The command line. Deliberately shaped like `ccusage`: same subcommand names
 * where the concept exists remotely (`daily`, `weekly`, `monthly`), same flag
 * letters (`-j/--json`, `-s/--since`, `-u/--until`, `-z/--timezone`,
 * `-O/--offline`, `-b/--breakdown`, `--no-cost`, `--compact`, `--no-color`), and
 * a `--json` payload whose shared fields match ccusage's exactly.
 *
 * The commands ccusage has that make no sense against a billing API (`session`,
 * `blocks`, `statusline`) are absent rather than faked; in their place are the
 * splits a platform *can* answer: `keys`, `accounts`, `workspaces`, `models`,
 * plus `providers` (capability matrix) and `pricing` (unit prices with source).
 */

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  aggregateByDimension,
  aggregateByPeriod,
  SPLIT_DIMENSIONS,
  type SplitDimension,
  totalsOf,
} from './aggregate.js';
import { renderReportHtml, renderReportSvg } from './chart/index.js';
import { collectUsage, createHttpClient } from './collect.js';
import { type ConfigError, loadConfig, type RuntimeConfig } from './config.js';
import { applyCosts, type CostingResult } from './cost.js';
import {
  DateInputError,
  defaultRange,
  isValidTimeZone,
  parseDateInput,
  toDateString,
} from './dates.js';
import { loadPriceBook, type PriceBook } from './pricing/index.js';
import type { CommandRunner } from './providers/ccusage.js';
import {
  type RenderOptions,
  renderDimensionReport,
  renderNotices,
  renderPeriodReport,
  renderProviderMatrix,
  renderTable,
} from './render.js';
import {
  buildDimensionReport,
  buildPeriodReport,
  type PeriodReport,
  type ReportOptions,
  type ReportRow,
} from './report.js';
import { type DateRange, type Granularity, PROVIDER_IDS, type ProviderId } from './types.js';
import { VERSION } from './version.js';

const COMMANDS = [
  'daily',
  'weekly',
  'monthly',
  'models',
  'keys',
  'accounts',
  'workspaces',
  'agents',
  'providers',
  'pricing',
  'report',
] as const;

type Command = (typeof COMMANDS)[number];

const DIMENSION_COMMANDS: Partial<Record<Command, SplitDimension>> = {
  models: 'model',
  keys: 'apiKey',
  accounts: 'account',
  workspaces: 'workspace',
  agents: 'agent',
};

const HELP = `aiusage ${VERSION} — usage and cost across remote LLM platform APIs

USAGE
  aiusage [daily] [options]          usage grouped by day
  aiusage weekly|monthly [options]   usage grouped by ISO week / calendar month
  aiusage models [options]           usage grouped by model
  aiusage keys|accounts|workspaces   usage grouped by API key / user account / workspace
  aiusage agents [options]           usage grouped by agent (with --local)
  aiusage providers                  what each configured source can answer
  aiusage pricing [--model <id>]     unit prices, with their source
  aiusage report [--out <file>]      the report figure (SVG, or --format html);
                                      90-day default window, --local implied,
                                      saved as HTML to $AIUSAGE_REPORT_DIR (default:
                                      the working directory) unless --print or
                                      --out says otherwise

OPTIONS
  -j, --json                 machine-readable output (ccusage-compatible shape)
  -s, --since <date>         start of the window (YYYY-MM-DD or YYYYMMDD)
  -u, --until <date>         end of the window, inclusive
      --days <n>             window as "the last n days" (default: 30, 90 for report)
  -z, --timezone <tz>        IANA timezone for grouping (default: UTC)
  -p, --provider <list>      restrict to providers: ${PROVIDER_IDS.join(',')}
      --split <list>         breakdowns to include: ${SPLIT_DIMENSIONS.join(',')} (default: model)
  -b, --breakdown            show per-model rows under each period in the table
      --local                also run ccusage and fuse local agent usage in
                              (default for report; --no-local opts out)
  -O, --offline              price from the cached tables only; never fetch
      --out <file>           write the figure to a file instead of stdout
      --format <svg|html>    figure format for the report command (default: svg,
                              or html when --local saves to a file)
      --print                print the report figure to stdout even with --local
      --granularity <g>      report grain: daily|weekly|monthly (default: daily)
      --no-cost              omit cost entirely (tokens only)
      --compact              drop secondary columns for narrow terminals
      --color / --no-color   force colour on/off (default: auto)
  -h, --help                 this text
  -v, --version              print the version

CREDENTIALS (environment; a platform without them is skipped, not zeroed)
  OPENROUTER_API_KEY, OPENROUTER_MANAGEMENT_KEY   OpenRouter — both repeatable as
    OPENROUTER_MANAGEMENT_KEY_<LABEL> (one key per workspace) or a comma list
  OPENAI_ADMIN_KEY, OPENAI_ORG_ID                 OpenAI Platform (admin key)
  ANTHROPIC_ADMIN_KEY                             Claude Platform (admin key)
  TOGETHER_API_KEY                                Together AI (pricing + identity only)

OTHER ENVIRONMENT
  AIUSAGE_REPORT_DIR   directory the report figure is saved to (default: the
                       working directory); a leading ~/ is expanded

EXIT CODES
  0 success · 1 a platform failed · 2 bad invocation`;

export class UsageError extends Error {}

type ParsedOptions = {
  command: Command;
  json: boolean;
  range: DateRange;
  timeZone: string;
  providers: ProviderId[];
  splits: SplitDimension[];
  breakdown: boolean;
  offline: boolean;
  includeCost: boolean;
  compact: boolean;
  color: boolean;
  models: string[];
  /** Fuse local agent usage (ccusage) into the report. */
  local: boolean;
  out: string | null;
  /** Null when `--format` was not given, so the report command can pick its
   * own default instead of always falling back to svg. */
  format: 'svg' | 'html' | null;
  /** Force the report figure to stdout even when `--local` would otherwise
   * default to a file — the escape hatch back to the old behaviour. */
  print: boolean;
  /** Only `report` sets this; other commands take their grain from the command. */
  granularity: Granularity | null;
};

export type CliEnvironment = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: Date;
  isTty: boolean;
  /** Where a `report` figure lands when `AIUSAGE_REPORT_DIR` is unset. */
  cwd: string;
  /** Injected so `cli.ts` stays free of side effects and stays testable. */
  writeFile?: (path: string, content: string) => void;
  /** Injected process runner for the local source; tests spawn nothing. */
  runCommand?: CommandRunner;
};

export async function run(environment: CliEnvironment): Promise<number> {
  let options: ParsedOptions;
  try {
    const parsed = parseCli(environment);
    if (parsed === null) return 0; // --help / --version already printed
    options = parsed;
  } catch (error) {
    if (error instanceof DateInputError || error instanceof UsageError) {
      environment.stderr(`${error.message}\n\nRun \`aiusage --help\`.`);
      return 2;
    }
    throw error;
  }

  let config: RuntimeConfig;
  try {
    config = loadConfig(environment.env);
  } catch (error) {
    environment.stderr((error as ConfigError).message);
    return 2;
  }

  const http = createHttpClient(config);
  const collection = await collectUsage({
    config,
    range: options.range,
    timeZone: options.timeZone,
    only: options.providers,
    http,
    now: environment.now,
    local: options.local
      ? {
          command: config.ccusageCommand,
          offline: options.offline,
          timeoutMs: config.timeoutMs,
        }
      : null,
    ...(environment.runCommand ? { localRunner: environment.runCommand } : {}),
  });

  const { priceBook, diagnostics: pricingDiagnostics } = options.includeCost
    ? await loadPriceBook({
        http,
        cacheDir: config.cacheDir,
        offline: options.offline,
        providers: options.providers,
        credentials: config.credentials,
        now: () => environment.now,
      })
    : { priceBook: null, diagnostics: [] };

  const costing = costOf(collection, priceBook);
  costing.diagnostics.unshift(...pricingDiagnostics);

  const reportOptions: ReportOptions = {
    granularity: granularityOf(options),
    range: options.range,
    timeZone: options.timeZone,
    splits: options.splits,
    includeCost: options.includeCost,
    generatedAt: environment.now,
    priceSources: priceBook?.sources ?? [],
  };
  const renderOptions: RenderOptions = {
    color: options.color,
    compact: options.compact,
    breakdown: options.breakdown,
    includeCost: options.includeCost,
  };

  emit(environment, options, config, collection, costing, reportOptions, renderOptions, priceBook);
  return collection.results.some((result) => result.status === 'error') ? 1 : 0;
}

function costOf(
  collection: Awaited<ReturnType<typeof collectUsage>>,
  priceBook: PriceBook | null,
): CostingResult {
  if (priceBook) return applyCosts(collection.results, priceBook);
  // --no-cost still needs the records, just without money attached.
  return {
    records: collection.results.flatMap((result) =>
      result.records.map((record) => ({
        ...record,
        costMicros: null,
        costSource: 'unavailable' as const,
        priceSource: null,
      })),
    ),
    unattributed: [],
    diagnostics: [],
  };
}

function emit(
  environment: CliEnvironment,
  options: ParsedOptions,
  config: RuntimeConfig,
  collection: Awaited<ReturnType<typeof collectUsage>>,
  costing: CostingResult,
  reportOptions: ReportOptions,
  renderOptions: RenderOptions,
  priceBook: PriceBook | null,
): void {
  const dimension = DIMENSION_COMMANDS[options.command];

  if (options.command === 'providers') {
    const report = buildPeriodReport([], totalsOf([]), collection, costing, reportOptions);
    environment.stdout(
      options.json
        ? JSON.stringify({ providers: report.meta.providers, meta: report.meta }, null, 2)
        : renderProviderMatrix(report.meta.providers, renderOptions),
    );
    return;
  }

  if (options.command === 'pricing') {
    emitPricing(environment, options, collection, costing, reportOptions, renderOptions, priceBook);
    return;
  }

  if (dimension) {
    const buckets = aggregateByDimension(costing.records, dimension);
    const report = buildDimensionReport(
      dimension,
      buckets,
      totalsOf(buckets),
      collection,
      costing,
      reportOptions,
    );
    environment.stdout(
      options.json ? JSON.stringify(report, null, 2) : renderDimensionReport(report, renderOptions),
    );
    return;
  }

  const periods = aggregateByPeriod(costing.records, {
    granularity: reportOptions.granularity,
    timeZone: options.timeZone,
    range: options.range,
    splits: options.splits,
  });
  const report = buildPeriodReport(periods, totalsOf(periods), collection, costing, reportOptions);

  if (options.command === 'report') {
    emitFigure(environment, options, config, report);
    return;
  }

  if (options.json) {
    environment.stdout(JSON.stringify(report, null, 2));
    return;
  }
  const rows: ReportRow[] = report.daily ?? report.weekly ?? report.monthly ?? [];
  if (rows.length === 0) {
    environment.stdout(
      [
        `No usage found between ${options.range.since} and ${options.range.until}.`,
        renderProviderMatrix(report.meta.providers, renderOptions),
        renderNotices(report.meta.notices, renderOptions, 'info'),
      ]
        .filter((section) => section.length > 0)
        .join('\n\n'),
    );
    return;
  }
  environment.stdout(renderPeriodReport(report, renderOptions));
}

/**
 * The figure. `--json` still emits the report the figure was drawn from, so the
 * numbers behind a picture are always obtainable from the same invocation.
 *
 * `report --local` defaults to a file rather than stdout: a one-off local run is
 * usually a person looking at their own machine, not a script consuming the
 * output, and raw SVG dumped to a terminal is not something anyone reads there.
 * `--print` (or an explicit `--out`) opts back out, and a plain `report` (no
 * `--local`) is unaffected.
 */
function emitFigure(
  environment: CliEnvironment,
  options: ParsedOptions,
  config: RuntimeConfig,
  report: PeriodReport,
): void {
  const chartOptions = {
    series: seriesDimension(options.splits),
    includeCost: options.includeCost,
  };
  const autoSave = options.local && !options.json && !options.out && !options.print;
  const format = options.format ?? (autoSave ? 'html' : 'svg');
  const content = options.json
    ? JSON.stringify(report, null, 2)
    : format === 'html'
      ? renderReportHtml(report, chartOptions)
      : renderReportSvg(report, chartOptions);
  const out =
    options.out ?? (autoSave ? defaultReportPath(environment, config, options, format) : null);

  if (!out) {
    environment.stdout(content);
    return;
  }
  if (!environment.writeFile) {
    environment.stderr('This build cannot write files; drop --out and redirect stdout instead.');
    return;
  }
  environment.writeFile(out, content);
  environment.stderr(`Wrote ${out}`);
}

/**
 * Named by the day it was produced *and* the window it covers: a scheduled run
 * writes one file per day, and the run date is what a reader sorts by, while the
 * window is what tells them whether two files are comparable.
 */
function defaultReportPath(
  environment: CliEnvironment,
  config: RuntimeConfig,
  options: ParsedOptions,
  format: 'svg' | 'html',
): string {
  const today = toDateString(environment.now);
  return join(
    config.reportDir ?? environment.cwd,
    `${today}-aiusage-report-${options.range.since}-to-${options.range.until}.${format}`,
  );
}

/**
 * Series come from the first non-model split; agent is the safe default, not
 * provider — every remote platform record's agent already falls back to its
 * provider id (`agentOf`), so this changes nothing for them, but it keeps
 * ccusage's local rows split by the actual agent (`claude`, `codex`) instead
 * of lumped under the literal string `ccusage`, which names the tool that
 * fetched the rows, not a billable endpoint.
 */
function seriesDimension(splits: readonly SplitDimension[]): SplitDimension {
  return splits.find((split) => split !== 'model') ?? 'agent';
}

function emitPricing(
  environment: CliEnvironment,
  options: ParsedOptions,
  collection: Awaited<ReturnType<typeof collectUsage>>,
  costing: CostingResult,
  reportOptions: ReportOptions,
  renderOptions: RenderOptions,
  priceBook: PriceBook | null,
): void {
  // Default to the models that actually appear in the window, so `pricing` is
  // about this org's own spend rather than a catalogue dump.
  const wanted = new Map<string, ProviderId>();
  for (const record of costing.records) {
    if (record.model) wanted.set(record.model, record.provider);
  }
  for (const model of options.models) {
    const provider = options.providers[0];
    if (provider) wanted.set(model, provider);
  }

  if (wanted.size === 0) {
    environment.stderr(
      'No models to price: no usage was found in the window. Pass --model <id> (repeatable) together with --provider <id>.',
    );
    return;
  }
  if (!priceBook) {
    environment.stderr('--no-cost disables pricing; drop it to run `aiusage pricing`.');
    return;
  }

  const rows = [...wanted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, provider]) => {
      const found = priceBook.lookup(provider, model);
      return {
        model,
        provider,
        // Per-million is how every vendor publishes prices; per-token is what
        // the maths uses. Emit both so neither needs converting by hand.
        inputPerMTok: found ? found.price.inputPerToken * 1_000_000 : null,
        outputPerMTok: found ? found.price.outputPerToken * 1_000_000 : null,
        cacheReadPerMTok:
          found?.price.cacheReadPerToken != null ? found.price.cacheReadPerToken * 1_000_000 : null,
        cacheWritePerMTok:
          found?.price.cacheWritePerToken != null
            ? found.price.cacheWritePerToken * 1_000_000
            : null,
        source: found?.source ?? null,
        matchedKey: found?.matchedKey ?? null,
      };
    });

  const meta = buildPeriodReport([], totalsOf([]), collection, costing, reportOptions).meta;

  if (options.json) {
    environment.stdout(JSON.stringify({ pricing: rows, meta }, null, 2));
    return;
  }

  const money = (value: number | null): string => (value === null ? '—' : `$${value.toFixed(4)}`);
  environment.stdout(
    [
      renderTable(
        [
          { header: 'Model', maxWidth: 42 },
          { header: 'Provider' },
          { header: 'Input /Mtok', align: 'right' },
          { header: 'Output /Mtok', align: 'right' },
          { header: 'Cache read', align: 'right' },
          { header: 'Cache write', align: 'right' },
          { header: 'Source', maxWidth: 34 },
        ],
        rows.map((row) => [
          row.model,
          row.provider,
          money(row.inputPerMTok),
          money(row.outputPerMTok),
          money(row.cacheReadPerMTok),
          money(row.cacheWritePerMTok),
          row.source ?? '(no price found)',
        ]),
      ),
      renderNotices(meta.notices, renderOptions),
    ]
      .filter((section) => section.length > 0)
      .join('\n\n'),
  );
}

function granularityOf(options: ParsedOptions): Granularity {
  if (options.granularity) return options.granularity;
  if (options.command === 'weekly') return 'weekly';
  if (options.command === 'monthly') return 'monthly';
  return 'daily';
}

/** `report` has no daily/weekly/monthly form of its own, so it takes a flag. */
function parseGranularity(value: string | undefined, command: Command): Granularity | null {
  if (value === undefined) return null;
  if (command !== 'report') {
    throw new UsageError(
      '--granularity only applies to `aiusage report`; use daily/weekly/monthly.',
    );
  }
  if (value !== 'daily' && value !== 'weekly' && value !== 'monthly') {
    throw new UsageError(`Unknown --granularity "${value}". Expected daily, weekly or monthly.`);
  }
  return value;
}

/**
 * `parseArgs` throws a TypeError for an unknown flag; turn that into the same
 * UsageError every other invocation mistake produces, so exit code 2 is uniform.
 */
const CLI_OPTIONS = {
  json: { type: 'boolean', short: 'j', default: false },
  since: { type: 'string', short: 's' },
  until: { type: 'string', short: 'u' },
  days: { type: 'string' },
  timezone: { type: 'string', short: 'z' },
  provider: { type: 'string', short: 'p', multiple: true },
  split: { type: 'string', multiple: true },
  breakdown: { type: 'boolean', short: 'b', default: false },
  local: { type: 'boolean', default: false },
  'no-local': { type: 'boolean', default: false },
  offline: { type: 'boolean', short: 'O', default: false },
  out: { type: 'string' },
  format: { type: 'string' },
  print: { type: 'boolean', default: false },
  granularity: { type: 'string' },
  'no-cost': { type: 'boolean', default: false },
  compact: { type: 'boolean', default: false },
  color: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  model: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, options: CLI_OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

export function parseCli(environment: CliEnvironment): ParsedOptions | null {
  const { values, positionals } = parseCliArgs(environment.argv);

  if (values.help) {
    environment.stdout(HELP);
    return null;
  }
  if (values.version) {
    environment.stdout(VERSION);
    return null;
  }

  const command = parseCommand(positionals);
  return {
    command,
    json: values.json === true,
    range: parseRange(values, environment.now, command),
    timeZone: parseTimeZone(values.timezone),
    providers: parseProviders(values.provider),
    splits: parseSplits(values.split, command),
    breakdown: values.breakdown === true,
    offline: values.offline === true,
    includeCost: values['no-cost'] !== true,
    compact: values.compact === true,
    color: values['no-color'] === true ? false : values.color === true || colorAuto(environment),
    models: values.model ?? [],
    // report fuses local usage by default — it is usually a person looking at
    // their own machine's whole picture; --no-local opts back out.
    local: values['no-local'] === true ? false : values.local === true || command === 'report',
    out: values.out ?? null,
    format: parseFormat(values.format),
    print: values.print === true,
    granularity: parseGranularity(values.granularity, command),
  };
}

function parseCommand(positionals: readonly string[]): Command {
  const [first, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`Unexpected argument "${rest[0]}".`);
  if (first === undefined) return 'daily';
  const found = COMMANDS.find((command) => command === first);
  if (!found) {
    throw new UsageError(`Unknown command "${first}". Expected one of: ${COMMANDS.join(', ')}.`);
  }
  return found;
}

/**
 * `report`'s default window is wider than every other command's: it draws a
 * time series, and 30 days of daily bars is a thin picture to read a trend
 * from. Every other command keeps the 30-day default, which is also
 * OpenRouter's hard lookback limit.
 */
function defaultDays(command: Command): number {
  return command === 'report' ? 90 : 30;
}

function parseRange(
  values: { since?: string | undefined; until?: string | undefined; days?: string | undefined },
  now: Date,
  command: Command,
): DateRange {
  if (values.days !== undefined && (values.since !== undefined || values.until !== undefined)) {
    throw new UsageError('--days cannot be combined with --since/--until.');
  }
  if (values.days !== undefined) {
    const days = Number(values.days);
    if (!Number.isInteger(days) || days <= 0) {
      throw new UsageError(`--days must be a positive integer, got "${values.days}".`);
    }
    return defaultRange(now, days);
  }

  const fallback = defaultRange(now, defaultDays(command));
  const since = values.since === undefined ? fallback.since : parseDateInput(values.since, 'since');
  const until = values.until === undefined ? fallback.until : parseDateInput(values.until, 'until');
  if (since > until) throw new UsageError(`--since (${since}) is after --until (${until}).`);
  return { since, until };
}

function parseTimeZone(timezone: string | undefined): string {
  if (timezone === undefined) return 'UTC';
  if (!isValidTimeZone(timezone)) throw new UsageError(`Unknown timezone "${timezone}".`);
  return timezone;
}

function parseProviders(provider: string[] | undefined): ProviderId[] {
  if (!provider || provider.length === 0) return [...PROVIDER_IDS];
  const requested = provider.flatMap((value) => value.split(',')).map((value) => value.trim());
  const resolved: ProviderId[] = [];
  for (const value of requested) {
    if (value.length === 0) continue;
    const found = PROVIDER_IDS.find((id) => id === value);
    if (!found) {
      throw new UsageError(
        `Unknown provider "${value}". Expected one of: ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    if (!resolved.includes(found)) resolved.push(found);
  }
  return resolved.length > 0 ? resolved : [...PROVIDER_IDS];
}

/** Null means "not given" — `report` picks its own default from there. */
function parseFormat(format: string | undefined): 'svg' | 'html' | null {
  if (format === undefined) return null;
  if (format !== 'svg' && format !== 'html') {
    throw new UsageError(`Unknown --format "${format}". Expected svg or html.`);
  }
  return format;
}

function parseSplits(split: string[] | undefined, command: Command): SplitDimension[] {
  if (!split || split.length === 0) {
    // Model breakdowns are the ccusage-compatible default; the figure also
    // needs a series dimension, and agent is the one every source can answer
    // without lumping ccusage's local agents under the literal id `ccusage`.
    if (command === 'report') return ['model', 'agent'];
    return command === 'daily' || command === 'weekly' || command === 'monthly' ? ['model'] : [];
  }
  const requested = split.flatMap((value) => value.split(',')).map((value) => value.trim());
  const resolved: SplitDimension[] = [];
  for (const value of requested) {
    if (value.length === 0) continue;
    const found = SPLIT_DIMENSIONS.find((dimension) => dimension === value);
    if (!found) {
      throw new UsageError(
        `Unknown split "${value}". Expected one of: ${SPLIT_DIMENSIONS.join(', ')}.`,
      );
    }
    if (!resolved.includes(found)) resolved.push(found);
  }
  // The figure never stacks by model (too many categories for a legend; see
  // the "top models" panel instead) — it falls back to agent. An explicit
  // `--split model` with nothing else would leave that fallback with no
  // agent breakdown to draw, and silently render an empty figure.
  if (command === 'report' && !resolved.some((dimension) => dimension !== 'model')) {
    if (!resolved.includes('agent')) resolved.push('agent');
  }
  return resolved;
}

function colorAuto(environment: CliEnvironment): boolean {
  if (environment.env.NO_COLOR) return false;
  if (environment.env.FORCE_COLOR) return true;
  return environment.isTty;
}

export { HELP };
