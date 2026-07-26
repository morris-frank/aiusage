/**
 * Grouping. Records in, buckets out.
 *
 * Two shapes are produced: by period (daily/weekly/monthly rows, each optionally
 * carrying breakdowns) and by dimension (one row per model / API key / account /
 * workspace / provider across the whole window).
 *
 * Cost provenance survives grouping: a bucket whose records disagree about how
 * their cost was established is reported as `mixed` rather than picking the
 * flattering label.
 */

import type { CostedRecord, CostSource } from './cost.js';
import { periodInRange, periodKey } from './dates.js';
import { sumReportedMicros } from './money.js';
import {
  type DateRange,
  type Granularity,
  type ProviderId,
  type TokenCounts,
  ZERO_TOKENS,
} from './types.js';

export type SplitDimension = 'model' | 'apiKey' | 'account' | 'workspace' | 'provider';

export const SPLIT_DIMENSIONS: readonly SplitDimension[] = [
  'model',
  'apiKey',
  'account',
  'workspace',
  'provider',
];

export type CostSourceSummary = CostSource | 'mixed';

export type Bucket = {
  /** Stable identifier: a period key, or a dimension value id. */
  key: string;
  /** What to print: a model name, an API key name, a period. */
  label: string;
  tokens: TokenCounts;
  /** Null when no contributing platform reports request counts. */
  requests: number | null;
  costMicros: number | null;
  costSource: CostSourceSummary;
  providers: ProviderId[];
  models: string[];
  recordCount: number;
};

export type PeriodBucket = Bucket & {
  breakdowns: Partial<Record<SplitDimension, Bucket[]>>;
};

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** Total billable tokens. Reasoning tokens are part of output, so not added. */
export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
}

export function summarizeCostSource(sources: Iterable<CostSource>): CostSourceSummary {
  const distinct = new Set(sources);
  if (distinct.size === 0) return 'unavailable';
  if (distinct.size === 1) {
    const [only] = distinct;
    return only ?? 'unavailable';
  }
  // 'unavailable' alongside real figures still means the bucket is incomplete,
  // so it does not get to hide behind the others.
  return 'mixed';
}

type Accumulator = {
  key: string;
  label: string;
  tokens: TokenCounts;
  requests: number | null;
  costs: (number | null)[];
  sources: CostSource[];
  providers: Set<ProviderId>;
  models: Set<string>;
  recordCount: number;
};

function newAccumulator(key: string, label: string): Accumulator {
  return {
    key,
    label,
    tokens: { ...ZERO_TOKENS },
    requests: null,
    costs: [],
    sources: [],
    providers: new Set(),
    models: new Set(),
    recordCount: 0,
  };
}

function accumulate(accumulator: Accumulator, record: CostedRecord): void {
  accumulator.tokens = addTokens(accumulator.tokens, record.tokens);
  if (record.requests !== null)
    accumulator.requests = (accumulator.requests ?? 0) + record.requests;
  accumulator.costs.push(record.costMicros);
  accumulator.sources.push(record.costSource);
  accumulator.providers.add(record.provider);
  if (record.model) accumulator.models.add(record.model);
  accumulator.recordCount += 1;
}

function finalize(accumulator: Accumulator): Bucket {
  return {
    key: accumulator.key,
    label: accumulator.label,
    tokens: accumulator.tokens,
    requests: accumulator.requests,
    costMicros: sumReportedMicros(accumulator.costs),
    costSource: summarizeCostSource(accumulator.sources),
    providers: [...accumulator.providers].sort(),
    models: [...accumulator.models].sort(),
    recordCount: accumulator.recordCount,
  };
}

/** The dimension value a record belongs to, and how to print it. */
export function dimensionOf(
  record: CostedRecord,
  dimension: SplitDimension,
): { key: string; label: string } {
  switch (dimension) {
    case 'model':
      return record.model
        ? { key: record.model, label: record.model }
        : { key: '(unspecified)', label: '(model not reported)' };
    case 'apiKey':
      return principalOf(record.apiKey, 'API key');
    case 'account':
      return principalOf(record.account, 'account');
    case 'workspace':
      return principalOf(record.workspace, 'workspace');
    case 'provider':
      return { key: record.provider, label: record.provider };
  }
}

function principalOf(
  principal: { id: string; name: string | null } | null,
  noun: string,
): { key: string; label: string } {
  if (!principal) return { key: '(unattributed)', label: `(no ${noun} reported)` };
  return { key: principal.id, label: principal.name ?? principal.id };
}

export type AggregateOptions = {
  granularity: Granularity;
  timeZone: string;
  range: DateRange;
  /** Which breakdown arrays to attach to each period row. */
  splits: readonly SplitDimension[];
};

export function aggregateByPeriod(
  records: readonly CostedRecord[],
  options: AggregateOptions,
): PeriodBucket[] {
  const periods = new Map<string, { accumulator: Accumulator; records: CostedRecord[] }>();

  for (const record of records) {
    const key = periodKey(record.bucketStart, options.granularity, options.timeZone);
    // Non-UTC grouping needs a wider fetch window than the report; trim here.
    if (!periodInRange(key, options.granularity, options.range)) continue;

    let entry = periods.get(key);
    if (!entry) {
      entry = { accumulator: newAccumulator(key, key), records: [] };
      periods.set(key, entry);
    }
    accumulate(entry.accumulator, record);
    entry.records.push(record);
  }

  return [...periods.values()]
    .map(({ accumulator, records: periodRecords }) => {
      const breakdowns: Partial<Record<SplitDimension, Bucket[]>> = {};
      for (const dimension of options.splits) {
        breakdowns[dimension] = aggregateByDimension(periodRecords, dimension);
      }
      return { ...finalize(accumulator), breakdowns };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** One bucket per distinct dimension value, ordered by cost then tokens. */
export function aggregateByDimension(
  records: readonly CostedRecord[],
  dimension: SplitDimension,
): Bucket[] {
  const groups = new Map<string, Accumulator>();
  for (const record of records) {
    const { key, label } = dimensionOf(record, dimension);
    let accumulator = groups.get(key);
    if (!accumulator) {
      accumulator = newAccumulator(key, label);
      groups.set(key, accumulator);
    }
    accumulate(accumulator, record);
  }
  return [...groups.values()]
    .map(finalize)
    .sort(
      (a, b) =>
        (b.costMicros ?? 0) - (a.costMicros ?? 0) ||
        totalTokens(b.tokens) - totalTokens(a.tokens) ||
        a.key.localeCompare(b.key),
    );
}

export function totalsOf(buckets: readonly Bucket[]): Bucket {
  const accumulator = newAccumulator('total', 'Total');
  for (const bucket of buckets) {
    accumulator.tokens = addTokens(accumulator.tokens, bucket.tokens);
    if (bucket.requests !== null)
      accumulator.requests = (accumulator.requests ?? 0) + bucket.requests;
    accumulator.costs.push(bucket.costMicros);
    accumulator.sources.push(...expand(bucket.costSource));
    for (const provider of bucket.providers) accumulator.providers.add(provider);
    for (const model of bucket.models) accumulator.models.add(model);
    accumulator.recordCount += bucket.recordCount;
  }
  return finalize(accumulator);
}

function expand(summary: CostSourceSummary): CostSource[] {
  // 'mixed' has to stay mixed when rolled up, so seed it with two distinct
  // sources rather than losing the fact that the bucket was heterogeneous.
  return summary === 'mixed' ? ['reported', 'calculated'] : [summary];
}
