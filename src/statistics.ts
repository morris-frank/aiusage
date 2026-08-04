/**
 * Derived statistics: the *shape* of a window, never a new total.
 *
 * Everything here is a second reading of records that `aggregate.ts` has
 * already totalled, so nothing in this module can change what the report says
 * was spent. Two shapes are produced:
 *
 *   - **time of day** — which hour of the reader's clock the usage happened in,
 *     and the weekday × hour grid behind it;
 *   - **concentration** — whether the window's spend is spiky or steady, as the
 *     share carried by its largest period, the count of periods needed to reach
 *     half of it, and the share in its busiest tenth.
 *
 * The discipline that matters here is refusing to draw a shape the data cannot
 * support. A whole-day bucket says nothing about *when* inside the day its
 * tokens were spent; spreading it over 24 hours would manufacture a flat
 * overnight profile that nobody measured. So a record is placed in an hour only
 * when its own bucket is at most an hour wide, everything coarser is counted as
 * explicitly excluded, and the excluded magnitude travels with the statistic
 * (`time-of-day-partial`) instead of being quietly absent.
 *
 * Concentration has no such limit — it reads the same period rows the figure
 * draws — so it is available for every source, hourly or not.
 */

import type { Bucket } from './aggregate.js';
import { totalTokens } from './aggregate.js';
import type { CostedRecord } from './cost.js';
import { dayKey, zonedHour, zonedWeekday } from './dates.js';
import { microsToUsd, sumReportedMicros } from './money.js';
import type { DateRange, Diagnostic, Granularity, ProviderId } from './types.js';

/** What the shares and rankings in here are shares *of*. */
export type StatisticsMeasure = 'cost' | 'tokens';

export type HourBucket = {
  /** Hour of the day, 0–23, on a clock in the report's timezone. */
  hour: number;
  /** Null when no contributing record had an obtainable cost. */
  cost: number | null;
  tokens: number;
  /** Null when no contributing platform reports request counts. */
  requests: number | null;
  /**
   * Distinct local days on which this hour saw usage. A large hour spread over
   * one day is a single late night; over twenty it is a working habit, and the
   * two read identically without this.
   */
  activeDays: number;
};

export type WeekHourCell = {
  /** ISO weekday: 1 = Monday … 7 = Sunday, in the report's timezone. */
  weekday: number;
  hour: number;
  cost: number | null;
  tokens: number;
};

export type TimeOfDayStatistics = {
  /** Always 24 entries, in hour order; an hour with no usage is present as zero. */
  hours: HourBucket[];
  /** Only the cells that saw usage — a 7×24 grid is mostly empty. */
  week: WeekHourCell[];
  /** Sources whose buckets were fine enough to place inside a day. */
  sources: ProviderId[];
  /** Sources that reported whole days, and so are absent from `hours`. */
  coarseSources: ProviderId[];
  /** Tokens excluded because their bucket was coarser than an hour. */
  excludedTokens: number;
  /** Cost excluded for the same reason. Null when none of it was obtainable. */
  excludedCost: number | null;
  /** Busiest hour by `measure`. Null when nothing was placed. */
  peakHour: number | null;
  measure: StatisticsMeasure;
};

export type ConcentrationStatistics = {
  /** One unit is one report period, at the report's own granularity. */
  unit: Granularity;
  measure: StatisticsMeasure;
  /** Periods with usage. Periods with none are absent from the report entirely. */
  activePeriods: number;
  /** Share of the measure carried by the single largest period, 0–1. */
  topShare: number;
  /** Fewest periods that together reach half the measure. */
  periodsForHalf: number;
  /**
   * Share carried by the busiest tenth of active periods, rounded up to at
   * least one period — so a 4-period window reports its largest period's share
   * rather than a decile that does not exist.
   */
  topDecileShare: number;
  /** How many periods `topDecileShare` covers, since it is rounded up. */
  topDecilePeriods: number;
};

export type UsageStatistics = {
  /** Null when no source reported a bucket fine enough to place inside a day. */
  timeOfDay: TimeOfDayStatistics | null;
  /** Null when the window has no periods with usage. */
  concentration: ConcentrationStatistics | null;
  /** What could not be computed, and why. Folded into `meta.notices`. */
  diagnostics: Diagnostic[];
};

export type StatisticsOptions = {
  range: DateRange;
  timeZone: string;
  granularity: Granularity;
  /** False under `--no-cost`: every statistic then ranks by tokens. */
  includeCost: boolean;
};

/** Widest bucket that can still be attributed to one hour of the clock. */
const HOUR_MS = 3_600_000;

export function computeStatistics(
  records: readonly CostedRecord[],
  periods: readonly Bucket[],
  options: StatisticsOptions,
): UsageStatistics {
  const diagnostics: Diagnostic[] = [];
  const timeOfDay = computeTimeOfDay(records, options, diagnostics);
  return { timeOfDay, concentration: computeConcentration(periods, options), diagnostics };
}

/**
 * Whether a record's own bucket is narrow enough to name an hour. Reading the
 * record's declared width, rather than trusting a provider-level capability
 * flag, keeps this correct for a source that mixes grains within one run.
 */
function placeableInHour(record: CostedRecord): boolean {
  const span = Date.parse(record.bucketEnd) - Date.parse(record.bucketStart);
  return Number.isFinite(span) && span >= 0 && span <= HOUR_MS;
}

type HourAccumulator = {
  costs: (number | null)[];
  tokens: number;
  requests: number | null;
  days: Set<string>;
};

function computeTimeOfDay(
  records: readonly CostedRecord[],
  options: StatisticsOptions,
  diagnostics: Diagnostic[],
): TimeOfDayStatistics | null {
  const hours = new Map<number, HourAccumulator>();
  const week = new Map<string, { costs: (number | null)[]; tokens: number }>();
  const sources = new Set<ProviderId>();
  const coarseSources = new Set<ProviderId>();
  const excludedCosts: (number | null)[] = [];
  let excludedTokens = 0;

  for (const record of records) {
    const day = dayKey(record.bucketStart, options.timeZone);
    // The fetch window is wider than the report window whenever grouping is not
    // UTC; trim to what the report actually covers, exactly as periods are.
    if (day < options.range.since || day > options.range.until) continue;

    const tokens = totalTokens(record.tokens);
    if (!placeableInHour(record)) {
      coarseSources.add(record.provider);
      excludedTokens += tokens;
      excludedCosts.push(record.costMicros);
      continue;
    }

    sources.add(record.provider);
    const hour = zonedHour(record.bucketStart, options.timeZone);
    const entry: HourAccumulator = hours.get(hour) ?? {
      costs: [],
      tokens: 0,
      requests: null,
      days: new Set(),
    };
    entry.costs.push(record.costMicros);
    entry.tokens += tokens;
    if (record.requests !== null) entry.requests = (entry.requests ?? 0) + record.requests;
    if (tokens > 0 || (record.costMicros ?? 0) > 0) entry.days.add(day);
    hours.set(hour, entry);

    const weekday = zonedWeekday(record.bucketStart, options.timeZone);
    const cellKey = `${weekday}|${hour}`;
    const cell = week.get(cellKey) ?? { costs: [], tokens: 0 };
    cell.costs.push(record.costMicros);
    cell.tokens += tokens;
    week.set(cellKey, cell);
  }

  if (hours.size === 0) {
    diagnostics.push(unplaceableDiagnostic(coarseSources));
    return null;
  }

  const buckets: HourBucket[] = Array.from({ length: 24 }, (_unused, hour) => {
    const entry = hours.get(hour);
    return {
      hour,
      cost: entry ? usdOrNull(sumReportedMicros(entry.costs)) : null,
      tokens: entry?.tokens ?? 0,
      requests: entry?.requests ?? null,
      activeDays: entry?.days.size ?? 0,
    };
  });

  const measure = measureFrom(
    buckets.map((bucket) => bucket.cost),
    options.includeCost,
  );
  const peak = buckets.reduce<HourBucket | null>((best, bucket) => {
    const value = hourValue(bucket, measure);
    if (value <= 0) return best;
    return best === null || value > hourValue(best, measure) ? bucket : best;
  }, null);

  if (excludedTokens > 0 || excludedCosts.some((cost) => cost !== null)) {
    diagnostics.push(partialDiagnostic(coarseSources, excludedTokens, excludedCosts));
  }

  return {
    hours: buckets,
    week: [...week.entries()]
      .map(([key, cell]) => {
        const [weekday = '0', hour = '0'] = key.split('|');
        return {
          weekday: Number(weekday),
          hour: Number(hour),
          cost: usdOrNull(sumReportedMicros(cell.costs)),
          tokens: cell.tokens,
        };
      })
      .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
    sources: [...sources].sort(),
    coarseSources: [...coarseSources].sort(),
    excludedTokens,
    excludedCost: usdOrNull(sumReportedMicros(excludedCosts)),
    peakHour: peak?.hour ?? null,
    measure,
  };
}

function hourValue(bucket: HourBucket, measure: StatisticsMeasure): number {
  return measure === 'cost' ? (bucket.cost ?? 0) : bucket.tokens;
}

function computeConcentration(
  periods: readonly Bucket[],
  options: StatisticsOptions,
): ConcentrationStatistics | null {
  const measure = measureFrom(
    periods.map((period) => usdOrNull(period.costMicros)),
    options.includeCost,
  );
  const values = periods
    .map((period) =>
      measure === 'cost' ? (usdOrNull(period.costMicros) ?? 0) : totalTokens(period.tokens),
    )
    .filter((value) => value > 0)
    .sort((a, b) => b - a);

  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length === 0 || total <= 0) return null;

  let running = 0;
  let periodsForHalf = 0;
  for (const value of values) {
    running += value;
    periodsForHalf += 1;
    if (running >= total / 2) break;
  }

  const decilePeriods = Math.max(1, Math.ceil(values.length / 10));
  const decileTotal = values.slice(0, decilePeriods).reduce((sum, value) => sum + value, 0);

  return {
    unit: options.granularity,
    measure,
    activePeriods: values.length,
    topShare: (values[0] ?? 0) / total,
    periodsForHalf,
    topDecileShare: decileTotal / total,
    topDecilePeriods: decilePeriods,
  };
}

/**
 * Cost when there is cost to rank by, tokens otherwise. Falling back rather
 * than ranking by an all-null cost column keeps the statistic meaningful on a
 * run where no price was obtainable — and the chosen measure is reported, so no
 * reader has to guess which one they are looking at.
 */
function measureFrom(costs: readonly (number | null)[], includeCost: boolean): StatisticsMeasure {
  if (!includeCost) return 'tokens';
  const total = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  return total > 0 ? 'cost' : 'tokens';
}

function usdOrNull(micros: number | null): number | null {
  return micros === null ? null : microsToUsd(micros);
}

function unplaceableDiagnostic(coarseSources: ReadonlySet<ProviderId>): Diagnostic {
  const named = [...coarseSources].sort().join(', ');
  return {
    provider: null,
    level: 'info',
    code: 'time-of-day-unavailable',
    message: `No time-of-day statistic: every collected bucket covers a whole day${
      named ? ` (${named})` : ''
    }, which says nothing about when inside it the tokens were spent. \`aiusage report\` asks the platforms that support hourly buckets for them; \`--hourly\` does the same for the other commands. OpenRouter and ccusage report whole days only.`,
  };
}

function partialDiagnostic(
  coarseSources: ReadonlySet<ProviderId>,
  excludedTokens: number,
  excludedCosts: readonly (number | null)[],
): Diagnostic {
  const micros = sumReportedMicros(excludedCosts);
  const money = micros === null ? '' : ` and $${microsToUsd(micros).toFixed(2)}`;
  return {
    provider: null,
    level: 'warning',
    code: 'time-of-day-partial',
    message: `The time-of-day statistic covers only the sources that reported sub-daily buckets. ${excludedTokens.toLocaleString(
      'en-US',
    )} tokens${money} come from whole-day buckets (${[...coarseSources]
      .sort()
      .join(
        ', ',
      )}) and are excluded from it rather than spread across 24 hours. The report's own totals include them.`,
  };
}
