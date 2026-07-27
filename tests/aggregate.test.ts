import { describe, expect, it } from 'vitest';
import {
  aggregateByDimension,
  aggregateByPeriod,
  summarizeCostSource,
  totalsOf,
} from '../src/aggregate.js';
import { costedRecord } from './helpers/records.js';

const RANGE = { since: '2026-07-01', until: '2026-07-31' };

describe('summarizeCostSource', () => {
  it('reports a single provenance as itself and a mix as mixed', () => {
    expect(summarizeCostSource(['reported', 'reported'])).toBe('reported');
    expect(summarizeCostSource(['reported', 'calculated'])).toBe('mixed');
    // An incomplete bucket does not get to hide behind its priced records.
    expect(summarizeCostSource(['reported', 'unavailable'])).toBe('mixed');
    expect(summarizeCostSource([])).toBe('unavailable');
  });
});

describe('aggregateByPeriod', () => {
  const records = [
    costedRecord({ bucketStart: '2026-07-10T00:00:00.000Z', model: 'a', costMicros: 100 }),
    costedRecord({ bucketStart: '2026-07-10T00:00:00.000Z', model: 'b', costMicros: 200 }),
    costedRecord({ bucketStart: '2026-07-11T00:00:00.000Z', model: 'a', costMicros: 300 }),
  ];

  it('groups by day, sorted, with model breakdowns', () => {
    const periods = aggregateByPeriod(records, {
      granularity: 'daily',
      timeZone: 'UTC',
      range: RANGE,
      splits: ['model'],
    });

    expect(periods.map((period) => period.key)).toEqual(['2026-07-10', '2026-07-11']);
    expect(periods[0]?.costMicros).toBe(300);
    expect(periods[0]?.models).toEqual(['a', 'b']);
    expect(periods[0]?.breakdowns.model?.map((bucket) => bucket.key)).toEqual(['b', 'a']);
  });

  it('rolls days into months and weeks', () => {
    const monthly = aggregateByPeriod(records, {
      granularity: 'monthly',
      timeZone: 'UTC',
      range: RANGE,
      splits: [],
    });
    expect(monthly).toHaveLength(1);
    expect(monthly[0]?.key).toBe('2026-07');
    expect(monthly[0]?.costMicros).toBe(600);

    const weekly = aggregateByPeriod(records, {
      granularity: 'weekly',
      timeZone: 'UTC',
      range: RANGE,
      splits: [],
    });
    expect(weekly.map((week) => week.key)).toEqual(['2026-07-06']);
  });

  it('re-buckets into the requested timezone', () => {
    const late = [costedRecord({ bucketStart: '2026-07-10T23:00:00.000Z' })];
    expect(
      aggregateByPeriod(late, {
        granularity: 'daily',
        timeZone: 'Asia/Tokyo',
        range: RANGE,
        splits: [],
      })[0]?.key,
    ).toBe('2026-07-11');
  });

  it('drops periods that the fetch window overshot', () => {
    const outside = [costedRecord({ bucketStart: '2026-08-05T00:00:00.000Z' })];
    expect(
      aggregateByPeriod(outside, {
        granularity: 'daily',
        timeZone: 'UTC',
        range: RANGE,
        splits: [],
      }),
    ).toEqual([]);
  });

  it('keeps requests null when no platform reported any', () => {
    const periods = aggregateByPeriod(
      [costedRecord({ requests: null }), costedRecord({ requests: null })],
      { granularity: 'daily', timeZone: 'UTC', range: RANGE, splits: [] },
    );
    expect(periods[0]?.requests).toBeNull();

    const mixed = aggregateByPeriod(
      [costedRecord({ requests: null }), costedRecord({ requests: 4 })],
      { granularity: 'daily', timeZone: 'UTC', range: RANGE, splits: [] },
    );
    expect(mixed[0]?.requests).toBe(4);
  });
});

describe('aggregateByDimension', () => {
  it('orders by cost and labels unattributed groups honestly', () => {
    const buckets = aggregateByDimension(
      [
        costedRecord({ apiKey: { id: 'k1', name: 'Cheap key' }, costMicros: 10 }),
        costedRecord({ apiKey: { id: 'k2', name: 'Expensive key' }, costMicros: 999 }),
        costedRecord({ apiKey: null, costMicros: 50 }),
      ],
      'apiKey',
    );

    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'Expensive key',
      '(no API key reported)',
      'Cheap key',
    ]);
  });

  it('falls back to the id when the platform gives no name', () => {
    const [bucket] = aggregateByDimension(
      [costedRecord({ account: { id: 'user_9', name: null } })],
      'account',
    );
    expect(bucket?.label).toBe('user_9');
  });

  it('groups by model canonically, merging an OpenRouter-prefixed id with the first-party spelling', () => {
    const buckets = aggregateByDimension(
      [
        costedRecord({ provider: 'openrouter', model: 'anthropic/claude-opus-5', costMicros: 200 }),
        costedRecord({ provider: 'anthropic', model: 'claude-opus-5', costMicros: 100 }),
        costedRecord({ provider: 'openai', model: 'gpt-5.6', costMicros: 50 }),
      ],
      'model',
    );
    expect(buckets.map((bucket) => [bucket.key, bucket.label, bucket.costMicros])).toEqual([
      ['claude-opus-5', 'claude-opus-5', 300],
      ['gpt-5.6', 'gpt-5.6', 50],
    ]);
  });

  it('groups across providers when asked', () => {
    const buckets = aggregateByDimension(
      [
        costedRecord({ provider: 'openai' }),
        costedRecord({ provider: 'anthropic' }),
        costedRecord({ provider: 'anthropic' }),
      ],
      'provider',
    );
    expect(buckets.map((bucket) => [bucket.key, bucket.recordCount])).toEqual([
      ['anthropic', 2],
      ['openai', 1],
    ]);
  });
});

describe('totalsOf', () => {
  it('sums buckets and preserves a mixed provenance', () => {
    const buckets = aggregateByDimension(
      [
        costedRecord({ model: 'a', costSource: 'reported', costMicros: 100 }),
        costedRecord({ model: 'b', costSource: 'calculated', costMicros: 200 }),
      ],
      'model',
    );
    const totals = totalsOf(buckets);

    expect(totals.costMicros).toBe(300);
    expect(totals.costSource).toBe('mixed');
    expect(totals.models).toEqual(['a', 'b']);
    expect(totals.recordCount).toBe(2);
  });

  it('reports no cost at all as unavailable, not zero', () => {
    const buckets = aggregateByDimension(
      [costedRecord({ costMicros: null, costSource: 'unavailable' })],
      'model',
    );
    expect(totalsOf(buckets).costMicros).toBeNull();
    expect(totalsOf(buckets).costSource).toBe('unavailable');
  });
});
