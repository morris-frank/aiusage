import { describe, expect, it } from 'vitest';
import { aggregateByPeriod } from '../src/aggregate.js';
import type { CostedRecord } from '../src/cost.js';
import { computeStatistics, type StatisticsOptions } from '../src/statistics.js';
import { costedRecord } from './helpers/records.js';

const RANGE = { since: '2026-07-01', until: '2026-07-31' };

const OPTIONS: StatisticsOptions = {
  range: RANGE,
  timeZone: 'UTC',
  granularity: 'daily',
  includeCost: true,
};

/** An hourly bucket: what Anthropic and OpenAI return when asked for `1h`. */
function hourly(day: string, hour: number, overrides: Partial<CostedRecord> = {}): CostedRecord {
  const start = `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const end = `${day}T${String(hour + 1).padStart(2, '0')}:00:00.000Z`;
  return costedRecord({ bucketStart: start, bucketEnd: end, ...overrides });
}

/** A whole-day bucket: what OpenRouter and ccusage return, always. */
function whole(day: string, overrides: Partial<CostedRecord> = {}): CostedRecord {
  return costedRecord({
    bucketStart: `${day}T00:00:00.000Z`,
    bucketEnd: `${day}T00:00:00.000Z`.replace(day, nextDay(day)),
    ...overrides,
  });
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function statisticsOf(records: CostedRecord[], overrides: Partial<StatisticsOptions> = {}) {
  const options = { ...OPTIONS, ...overrides };
  const periods = aggregateByPeriod(records, {
    granularity: options.granularity,
    timeZone: options.timeZone,
    range: options.range,
    splits: [],
  });
  return computeStatistics(records, periods, options);
}

describe('time of day', () => {
  it('places an hourly bucket in the hour its clock shows, and leaves quiet hours at zero', () => {
    const { timeOfDay } = statisticsOf([
      hourly('2026-07-10', 9, { costMicros: 2_000_000 }),
      hourly('2026-07-11', 9, { costMicros: 1_000_000 }),
      hourly('2026-07-11', 22, { costMicros: 500_000 }),
    ]);

    expect(timeOfDay?.hours).toHaveLength(24);
    expect(timeOfDay?.hours[9]).toMatchObject({ hour: 9, cost: 3, activeDays: 2 });
    expect(timeOfDay?.hours[22]).toMatchObject({ hour: 22, cost: 0.5, activeDays: 1 });
    // A quiet hour is present and empty, not missing — the panel has 24 slots.
    expect(timeOfDay?.hours[3]).toMatchObject({ hour: 3, cost: null, tokens: 0, activeDays: 0 });
    expect(timeOfDay?.peakHour).toBe(9);
  });

  it('reads the hour off the report timezone, not off UTC', () => {
    // 23:00 UTC is 09:00 the next morning in Sydney; the reader's clock wins.
    const { timeOfDay } = statisticsOf([hourly('2026-07-10', 23, { costMicros: 1_000_000 })], {
      timeZone: 'Australia/Sydney',
    });
    expect(timeOfDay?.peakHour).toBe(9);
  });

  it('excludes a whole-day bucket rather than spreading it over 24 hours', () => {
    const { timeOfDay, diagnostics } = statisticsOf([
      hourly('2026-07-10', 9, { costMicros: 1_000_000, tokens: tokens(100) }),
      whole('2026-07-10', {
        provider: 'openrouter',
        costMicros: 9_000_000,
        tokens: tokens(900),
      }),
    ]);

    // The day-grain row contributes nothing to any hour…
    const placed = (timeOfDay?.hours ?? []).reduce((sum, hour) => sum + (hour.cost ?? 0), 0);
    expect(placed).toBe(1);
    // …and its magnitude is stated rather than silently absent.
    expect(timeOfDay?.excludedCost).toBe(9);
    expect(timeOfDay?.excludedTokens).toBe(900);
    expect(timeOfDay?.coarseSources).toEqual(['openrouter']);
    expect(timeOfDay?.sources).toEqual(['anthropic']);

    const notice = diagnostics.find((one) => one.code === 'time-of-day-partial');
    expect(notice?.level).toBe('warning');
    expect(notice?.message).toContain('openrouter');
    expect(notice?.message).toContain('900 tokens');
    expect(notice?.message).toContain('$9.00');
  });

  it('reports no statistic at all, with a reason, when every bucket is a whole day', () => {
    const { timeOfDay, diagnostics } = statisticsOf([
      whole('2026-07-10', { provider: 'openrouter' }),
      whole('2026-07-11', { provider: 'ccusage' }),
    ]);

    expect(timeOfDay).toBeNull();
    const notice = diagnostics.find((one) => one.code === 'time-of-day-unavailable');
    expect(notice?.level).toBe('info');
    expect(notice?.message).toContain('ccusage, openrouter');
  });

  it('buckets weekday × hour on ISO weekdays and skips cells with no usage', () => {
    // 2026-07-10 is a Friday; 2026-07-12 a Sunday.
    const { timeOfDay } = statisticsOf([
      hourly('2026-07-10', 14, { costMicros: 1_000_000 }),
      hourly('2026-07-12', 14, { costMicros: 2_000_000 }),
    ]);

    expect(timeOfDay?.week).toEqual([
      { weekday: 5, hour: 14, cost: 1, tokens: 1100 },
      { weekday: 7, hour: 14, cost: 2, tokens: 1100 },
    ]);
    // Only two of the 168 cells saw usage; the rest are absent, not zero rows.
    expect(timeOfDay?.week).toHaveLength(2);
  });

  it('trims to the report window, since a non-UTC run fetches wider than it reports', () => {
    const { timeOfDay } = statisticsOf([
      hourly('2026-06-30', 9, { costMicros: 5_000_000 }),
      hourly('2026-07-10', 11, { costMicros: 1_000_000 }),
    ]);
    expect(timeOfDay?.hours[9]?.cost).toBeNull();
    expect(timeOfDay?.peakHour).toBe(11);
  });

  it('ranks by tokens instead of cost when no cost was collected', () => {
    const { timeOfDay } = statisticsOf(
      [
        hourly('2026-07-10', 4, { costMicros: null, costSource: 'unavailable', tokens: tokens(9) }),
        hourly('2026-07-10', 5, { costMicros: null, costSource: 'unavailable', tokens: tokens(1) }),
      ],
      { includeCost: false },
    );
    expect(timeOfDay?.measure).toBe('tokens');
    expect(timeOfDay?.peakHour).toBe(4);
  });
});

describe('concentration', () => {
  it('measures how much of the window sits in its busiest periods', () => {
    // Ten days: one at $70, nine at ~$3.33 each. Total $100.
    const records = [
      whole('2026-07-01', { costMicros: 70_000_000 }),
      ...Array.from({ length: 9 }, (_unused, index) =>
        whole(`2026-07-${String(index + 2).padStart(2, '0')}`, { costMicros: 3_333_333 }),
      ),
    ];
    const { concentration } = statisticsOf(records);

    expect(concentration?.unit).toBe('daily');
    expect(concentration?.measure).toBe('cost');
    expect(concentration?.activePeriods).toBe(10);
    expect(concentration?.topShare).toBeCloseTo(0.7, 3);
    // One day already carries more than half of it.
    expect(concentration?.periodsForHalf).toBe(1);
    expect(concentration?.topDecilePeriods).toBe(1);
    expect(concentration?.topDecileShare).toBeCloseTo(0.7, 3);
  });

  it('rounds the decile up to one period rather than reporting a decile that does not exist', () => {
    const { concentration } = statisticsOf([
      whole('2026-07-01', { costMicros: 3_000_000 }),
      whole('2026-07-02', { costMicros: 1_000_000 }),
    ]);
    expect(concentration?.activePeriods).toBe(2);
    expect(concentration?.topDecilePeriods).toBe(1);
    expect(concentration?.topDecileShare).toBeCloseTo(0.75, 6);
    expect(concentration?.periodsForHalf).toBe(1);
  });

  it('is absent, not zero, for a window with no usage', () => {
    expect(statisticsOf([]).concentration).toBeNull();
  });

  it('counts periods with usage, ignoring the ones the window never reached', () => {
    const { concentration } = statisticsOf([
      whole('2026-07-01', { costMicros: 1_000_000 }),
      whole('2026-07-20', { costMicros: 1_000_000 }),
    ]);
    // 31 days in range, 2 with usage: a "share of the window" would be a fiction.
    expect(concentration?.activePeriods).toBe(2);
  });
});

/** All of a record's tokens on the input side, so `total` is exactly `count`. */
function tokens(count: number) {
  return { input: count, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 };
}
