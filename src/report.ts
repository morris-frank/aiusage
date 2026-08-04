/**
 * The JSON contract.
 *
 * `aiusage --json` mirrors `ccusage --json` field for field on the shared parts,
 * so anything already parsing ccusage output keeps working:
 *
 *   { "daily": [ { agent, cacheCreationTokens, cacheReadTokens, inputTokens,
 *                  metadata, modelBreakdowns, modelsUsed, outputTokens, period,
 *                  totalCost, totalTokens } ],
 *     "totals": { cacheCreationTokens, cacheReadTokens, inputTokens,
 *                 outputTokens, totalCost, totalTokens } }
 *
 * Everything aiusage adds is **additive**: extra keys on rows (`provider`,
 * `apiKeyBreakdowns`, `accountBreakdowns`, …), a top-level `meta` block carrying
 * provenance, per-provider capabilities and warnings, and a top-level
 * `statistics` block carrying derived shape (time of day, spend concentration).
 * No shared key changes meaning.
 *
 * One deliberate compatibility wart: `totalCost` is always a number, so a bucket
 * with no obtainable cost reports `0` — `metadata.costSource: "unavailable"` and
 * a `meta.notices` entry are what distinguish that from genuinely free usage.
 */

import type { Bucket, PeriodBucket, SplitDimension } from './aggregate.js';
import { totalTokens } from './aggregate.js';
import type { Collection } from './collect.js';
import type { CostedRecord, CostingResult, CostSource } from './cost.js';
import { canonicalModelId } from './models.js';
import { microsToUsd } from './money.js';
import { computeStatistics, type UsageStatistics } from './statistics.js';
import {
  type DateRange,
  type Diagnostic,
  type Granularity,
  PROVIDER_LABELS,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderIdentity,
  type ProviderStatus,
} from './types.js';
import { VERSION } from './version.js';

export type ModelBreakdown = {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost?: number;
  costSource?: CostSource | 'mixed';
  provider: string;
  /** aiusage addition: the agent(s) behind this model (ccusage-compatible
   * `agent` names for local rows, the provider id for platform rows) — never
   * the literal provider id `ccusage`, which names the tool, not an agent. */
  agents: string[];
  requests: number | null;
};

export type DimensionBreakdown = {
  id: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost?: number;
  costSource?: CostSource | 'mixed';
  providers: string[];
  models: string[];
  agents: string[];
  requests: number | null;
};

export type ReportRow = {
  /** ccusage compatibility: the source of the row. `all` when several. */
  agent: string;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  metadata: {
    agents: string[];
    providers: string[];
    costSource: CostSource | 'mixed';
    requests: number | null;
    reasoningTokens: number;
  };
  modelBreakdowns: ModelBreakdown[];
  modelsUsed: string[];
  outputTokens: number;
  period: string;
  totalCost?: number;
  totalTokens: number;
  /** aiusage additions, present only for the splits that were requested. */
  apiKeyBreakdowns?: DimensionBreakdown[];
  accountBreakdowns?: DimensionBreakdown[];
  workspaceBreakdowns?: DimensionBreakdown[];
  providerBreakdowns?: DimensionBreakdown[];
  agentBreakdowns?: DimensionBreakdown[];
};

export type ReportTotals = {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost?: number;
  totalTokens: number;
  requests: number | null;
  costSource: CostSource | 'mixed';
};

export type ProviderSummary = {
  id: ProviderId;
  label: string;
  status: ProviderStatus;
  capabilities: ProviderCapabilities;
  identity: ProviderIdentity | null;
  recordCount: number;
  totalCost?: number;
  costSource: CostSource | 'mixed';
};

export type ReportMeta = {
  tool: 'aiusage';
  version: string;
  generatedAt: string;
  granularity: Granularity;
  range: DateRange;
  timezone: string;
  costIncluded: boolean;
  priceSources: string[];
  providers: ProviderSummary[];
  unattributedCost: {
    provider: ProviderId;
    cost: number;
    description: string | null;
    reason: string;
  }[];
  notices: Diagnostic[];
};

export type PeriodReport = {
  daily?: ReportRow[];
  weekly?: ReportRow[];
  monthly?: ReportRow[];
  totals: ReportTotals;
  /**
   * aiusage addition: derived shape — time of day, spend concentration. Never a
   * total, and every part of it is nullable, because a shape the collected
   * grain cannot support is reported as absent rather than flattened into one.
   */
  statistics: UsageStatistics;
  meta: ReportMeta;
};

export type DimensionReport = {
  dimension: SplitDimension;
  rows: DimensionBreakdown[];
  totals: ReportTotals;
  meta: ReportMeta;
};

export type ReportOptions = {
  granularity: Granularity;
  range: DateRange;
  timeZone: string;
  splits: readonly SplitDimension[];
  includeCost: boolean;
  generatedAt: Date;
  priceSources: readonly string[];
};

const BREAKDOWN_KEY: Record<Exclude<SplitDimension, 'model'>, keyof ReportRow> = {
  apiKey: 'apiKeyBreakdowns',
  account: 'accountBreakdowns',
  workspace: 'workspaceBreakdowns',
  provider: 'providerBreakdowns',
  agent: 'agentBreakdowns',
};

export function buildPeriodReport(
  periods: readonly PeriodBucket[],
  totals: Bucket,
  collection: Collection,
  costing: CostingResult,
  options: ReportOptions,
): PeriodReport {
  const rows = periods.map((period) => toRow(period, options));
  const statistics = computeStatistics(costing.records, periods, {
    range: options.range,
    timeZone: options.timeZone,
    granularity: options.granularity,
    includeCost: options.includeCost,
  });
  const report: PeriodReport = {
    totals: toTotals(totals, options.includeCost),
    statistics,
    // The statistics' own diagnostics belong with every other notice, so a
    // reader of `meta.notices` sees what the shape panels left out too.
    meta: buildMeta(collection, costing, options, statistics.diagnostics),
  };
  report[options.granularity] = rows;
  return report;
}

export function buildDimensionReport(
  dimension: SplitDimension,
  buckets: readonly Bucket[],
  totals: Bucket,
  collection: Collection,
  costing: CostingResult,
  options: ReportOptions,
): DimensionReport {
  return {
    dimension,
    rows: buckets.map((bucket) => toDimensionBreakdown(bucket, options.includeCost)),
    totals: toTotals(totals, options.includeCost),
    meta: buildMeta(collection, costing, options),
  };
}

function toRow(period: PeriodBucket, options: ReportOptions): ReportRow {
  const providers = period.providers.map(String);
  const agents = period.agents;
  const row: ReportRow = {
    // ccusage's own semantic: the agent that produced the row, `all` when several.
    agent: agents.length === 1 ? (agents[0] ?? 'all') : 'all',
    cacheCreationTokens: period.tokens.cacheCreation,
    cacheReadTokens: period.tokens.cacheRead,
    inputTokens: period.tokens.input,
    metadata: {
      // For platform rows the platform *is* the agent; local rows carry the real
      // agent name (`claude`, `codex`), which is what ccusage consumers expect.
      agents,
      providers,
      costSource: period.costSource,
      requests: period.requests,
      reasoningTokens: period.tokens.reasoning,
    },
    modelBreakdowns: (period.breakdowns.model ?? []).map((bucket) =>
      toModelBreakdown(bucket, options.includeCost),
    ),
    modelsUsed: period.models,
    outputTokens: period.tokens.output,
    period: period.key,
    totalTokens: totalTokens(period.tokens),
  };
  if (options.includeCost) row.totalCost = usd(period.costMicros);

  for (const dimension of options.splits) {
    if (dimension === 'model') continue;
    const buckets = period.breakdowns[dimension];
    if (!buckets) continue;
    const key = BREAKDOWN_KEY[dimension];
    // Index assignment keeps the four breakdown keys in one place instead of
    // four near-identical branches.
    (row as Record<string, unknown>)[key] = buckets.map((bucket) =>
      toDimensionBreakdown(bucket, options.includeCost),
    );
  }
  return row;
}

function toModelBreakdown(bucket: Bucket, includeCost: boolean): ModelBreakdown {
  const breakdown: ModelBreakdown = {
    modelName: bucket.label,
    inputTokens: bucket.tokens.input,
    outputTokens: bucket.tokens.output,
    cacheCreationTokens: bucket.tokens.cacheCreation,
    cacheReadTokens: bucket.tokens.cacheRead,
    provider: bucket.providers.join(','),
    agents: bucket.agents,
    requests: bucket.requests,
  };
  if (includeCost) {
    breakdown.cost = usd(bucket.costMicros);
    breakdown.costSource = bucket.costSource;
  }
  return breakdown;
}

function toDimensionBreakdown(bucket: Bucket, includeCost: boolean): DimensionBreakdown {
  const breakdown: DimensionBreakdown = {
    id: bucket.key,
    name: bucket.label,
    inputTokens: bucket.tokens.input,
    outputTokens: bucket.tokens.output,
    cacheCreationTokens: bucket.tokens.cacheCreation,
    cacheReadTokens: bucket.tokens.cacheRead,
    totalTokens: totalTokens(bucket.tokens),
    providers: bucket.providers.map(String),
    models: bucket.models,
    agents: bucket.agents,
    requests: bucket.requests,
  };
  if (includeCost) {
    breakdown.cost = usd(bucket.costMicros);
    breakdown.costSource = bucket.costSource;
  }
  return breakdown;
}

function toTotals(totals: Bucket, includeCost: boolean): ReportTotals {
  const result: ReportTotals = {
    cacheCreationTokens: totals.tokens.cacheCreation,
    cacheReadTokens: totals.tokens.cacheRead,
    inputTokens: totals.tokens.input,
    outputTokens: totals.tokens.output,
    totalTokens: totalTokens(totals.tokens),
    requests: totals.requests,
    costSource: totals.costSource,
  };
  if (includeCost) result.totalCost = usd(totals.costMicros);
  return result;
}

function buildMeta(
  collection: Collection,
  costing: CostingResult,
  options: ReportOptions,
  extraNotices: readonly Diagnostic[] = [],
): ReportMeta {
  return {
    tool: 'aiusage',
    version: VERSION,
    generatedAt: options.generatedAt.toISOString(),
    granularity: options.granularity,
    range: options.range,
    timezone: options.timeZone,
    costIncluded: options.includeCost,
    priceSources: [...options.priceSources],
    providers: collection.results.map((result) =>
      summarizeProvider(result, costing.records, options.includeCost),
    ),
    unattributedCost: costing.unattributed.map((entry) => ({
      provider: entry.provider,
      cost: usd(entry.amountMicros),
      description: entry.description,
      reason: entry.reason,
    })),
    notices: [
      ...collection.diagnostics,
      ...costing.diagnostics,
      ...modelCanonicalizationNotice(costing.records),
      ...extraNotices,
    ],
  };
}

/**
 * One notice, only when canonicalising model ids (see `models.ts`) actually
 * merged two or more distinct raw spellings into one row — never silent, per
 * the same discipline as every other provenance-affecting transform here.
 */
function modelCanonicalizationNotice(records: readonly CostedRecord[]): Diagnostic[] {
  const rawByCanonical = new Map<string, Set<string>>();
  for (const record of records) {
    if (!record.model) continue;
    const canonical = canonicalModelId(record.model);
    const raw = rawByCanonical.get(canonical) ?? new Set<string>();
    raw.add(record.model);
    rawByCanonical.set(canonical, raw);
  }
  const merged = [...rawByCanonical.entries()].filter(([, raw]) => raw.size > 1);
  if (merged.length === 0) return [];

  const examples = merged
    .slice(0, 3)
    .map(([canonical, raw]) => `${canonical} (${[...raw].sort().join(', ')})`)
    .join('; ');
  return [
    {
      provider: null,
      level: 'info',
      code: 'model-id-canonicalized',
      message: `${merged.length} model id(s) were merged by canonical identity — vendor prefix and pinned-snapshot date stripped, since platforms spell the same model differently: ${examples}${merged.length > 3 ? ', …' : ''}. A distinct dated snapshot you needed to tell apart will read as the same row.`,
    },
  ];
}

function summarizeProvider(
  result: Collection['results'][number],
  records: readonly CostedRecord[],
  includeCost: boolean,
): ProviderSummary {
  const own = records.filter((record) => record.provider === result.provider);
  const sources = new Set<CostSource>(own.map((record) => record.costSource));
  const costMicros = own.reduce(
    (sum, record) => (record.costMicros === null ? sum : sum + record.costMicros),
    0,
  );

  const summary: ProviderSummary = {
    id: result.provider,
    label: PROVIDER_LABELS[result.provider],
    status: result.status,
    capabilities: result.capabilities,
    identity: result.identity,
    recordCount: own.length,
    costSource:
      sources.size === 0
        ? 'unavailable'
        : sources.size === 1
          ? ([...sources][0] ?? 'unavailable')
          : 'mixed',
  };
  if (includeCost) summary.totalCost = usd(costMicros);
  return summary;
}

/** Cost is emitted in USD; `null` becomes 0 for ccusage compatibility. */
function usd(micros: number | null): number {
  return micros === null ? 0 : microsToUsd(micros);
}
