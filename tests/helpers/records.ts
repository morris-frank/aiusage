import type { CostedRecord } from '../../src/cost.js';
import type { CostRecord, ProviderId, ProviderResult, UsageRecord } from '../../src/types.js';

export function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: 'anthropic',
    bucketStart: '2026-07-25T00:00:00.000Z',
    bucketEnd: '2026-07-26T00:00:00.000Z',
    model: 'claude-opus-4-6',
    account: null,
    apiKey: null,
    workspace: null,
    tokens: { input: 1000, output: 100, cacheCreation: 0, cacheRead: 0, reasoning: 0 },
    requests: null,
    reportedCostMicros: null,
    extras: {},
    tags: {},
    ...overrides,
  };
}

export function costedRecord(overrides: Partial<CostedRecord> = {}): CostedRecord {
  return {
    ...usageRecord(overrides),
    costMicros: 1000,
    costSource: 'calculated',
    priceSource: 'test-prices',
    ...overrides,
  };
}

export function costRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  return {
    provider: 'anthropic',
    bucketStart: '2026-07-25T00:00:00.000Z',
    bucketEnd: '2026-07-26T00:00:00.000Z',
    model: 'claude-opus-4-6',
    workspace: null,
    amountMicros: 1_000_000,
    description: 'Usage - Input Tokens',
    allocatable: true,
    ...overrides,
  };
}

export function providerResult(
  provider: ProviderId,
  records: UsageRecord[],
  costRecords: CostRecord[] = [],
): ProviderResult {
  return {
    provider,
    status: 'ok',
    capabilities: {
      usage: true,
      reportedCost: costRecords.length > 0,
      splitByModel: true,
      splitByApiKey: true,
      splitByAccount: true,
      splitByWorkspace: true,
      livePricing: false,
      maxLookbackDays: null,
    },
    records,
    costRecords,
    diagnostics: [],
    identity: {},
  };
}
