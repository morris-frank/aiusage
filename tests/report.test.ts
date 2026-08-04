import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateByDimension, aggregateByPeriod, totalsOf } from '../src/aggregate.js';
import type { Collection } from '../src/collect.js';
import type { CostingResult } from '../src/cost.js';
import { buildDimensionReport, buildPeriodReport, type ReportOptions } from '../src/report.js';
import { VERSION } from '../src/version.js';
import { costedRecord, providerResult } from './helpers/records.js';

/**
 * The shared shape `ccusage --json` emits per row, captured from
 * `npx ccusage@latest daily --json`. These key sets are the compatibility
 * contract: aiusage may add keys, never drop or rename one of these.
 */
const CCUSAGE_ROW_KEYS = [
  'agent',
  'cacheCreationTokens',
  'cacheReadTokens',
  'inputTokens',
  'metadata',
  'modelBreakdowns',
  'modelsUsed',
  'outputTokens',
  'period',
  'totalCost',
  'totalTokens',
];

const CCUSAGE_TOTALS_KEYS = [
  'cacheCreationTokens',
  'cacheReadTokens',
  'inputTokens',
  'outputTokens',
  'totalCost',
  'totalTokens',
];

const CCUSAGE_MODEL_BREAKDOWN_KEYS = [
  'cacheCreationTokens',
  'cacheReadTokens',
  'cost',
  'inputTokens',
  'modelName',
  'outputTokens',
];

const RANGE = { since: '2026-07-01', until: '2026-07-31' };

const RECORDS = [
  costedRecord({
    provider: 'anthropic',
    bucketStart: '2026-07-10T00:00:00.000Z',
    model: 'claude-opus-4-6',
    apiKey: { id: 'key_a', name: 'Prod' },
    account: { id: 'user_1', name: 'Grace' },
    workspace: { id: 'ws_1', name: 'Platform' },
    costMicros: 2_500_000,
    costSource: 'allocated',
    tokens: { input: 1000, output: 100, cacheCreation: 20, cacheRead: 300, reasoning: 10 },
    requests: 3,
  }),
  costedRecord({
    provider: 'openrouter',
    bucketStart: '2026-07-10T00:00:00.000Z',
    model: 'openai/gpt-5.3',
    costMicros: 500_000,
    costSource: 'reported',
    tokens: { input: 50, output: 25, cacheCreation: 0, cacheRead: 0, reasoning: 5 },
    requests: 1,
  }),
];

function fixtures(includeCost = true): {
  collection: Collection;
  costing: CostingResult;
  options: ReportOptions;
} {
  const collection: Collection = {
    results: [
      providerResult('anthropic', []),
      // A source that contributed nothing still has to appear in the report.
      { ...providerResult('openai', []), status: 'skipped' },
    ],
    diagnostics: [
      {
        provider: 'openai',
        level: 'warning',
        code: 'not-configured',
        message: 'OpenAI Platform is not configured. Its usage is unknown, not zero.',
      },
    ],
  };
  const costing: CostingResult = {
    records: RECORDS,
    unattributed: [
      {
        provider: 'anthropic',
        amountMicros: 500,
        description: 'Web search',
        reason: 'not-allocatable',
      },
    ],
    diagnostics: [],
  };
  const options: ReportOptions = {
    granularity: 'daily',
    range: RANGE,
    timeZone: 'UTC',
    splits: ['model', 'apiKey', 'account'],
    includeCost,
    generatedAt: new Date('2026-07-26T12:00:00Z'),
    priceSources: ['litellm@2026-07-26'],
  };
  return { collection, costing, options };
}

function periodReport(includeCost = true) {
  const { collection, costing, options } = fixtures(includeCost);
  const periods = aggregateByPeriod(costing.records, {
    granularity: options.granularity,
    timeZone: options.timeZone,
    range: options.range,
    splits: options.splits,
  });
  return buildPeriodReport(periods, totalsOf(periods), collection, costing, options);
}

describe('ccusage compatibility', () => {
  it('emits the granularity as the top-level key, alongside totals', () => {
    const report = periodReport();
    // Exact, so an accidental top-level key is caught. `statistics` is a
    // deliberate additive block; `daily`/`totals` keep ccusage's meaning.
    expect(Object.keys(report).sort()).toEqual(['daily', 'meta', 'statistics', 'totals']);
    expect(report.weekly).toBeUndefined();
  });

  it('emits every ccusage row key with ccusage’s meaning', () => {
    const [row] = periodReport().daily ?? [];
    for (const key of CCUSAGE_ROW_KEYS) expect(Object.keys(row ?? {})).toContain(key);

    expect(row?.period).toBe('2026-07-10');
    expect(row?.inputTokens).toBe(1050);
    expect(row?.outputTokens).toBe(125);
    expect(row?.cacheCreationTokens).toBe(20);
    expect(row?.cacheReadTokens).toBe(300);
    // totalTokens is input + output + cache, and excludes reasoning (a subset of output).
    expect(row?.totalTokens).toBe(1495);
    expect(row?.totalCost).toBeCloseTo(3, 9);
    expect(row?.modelsUsed).toEqual(['claude-opus-4-6', 'openai/gpt-5.3']);
  });

  it('emits ccusage’s model breakdown keys', () => {
    const [row] = periodReport().daily ?? [];
    const [breakdown] = row?.modelBreakdowns ?? [];
    for (const key of CCUSAGE_MODEL_BREAKDOWN_KEYS) {
      expect(Object.keys(breakdown ?? {})).toContain(key);
    }
    expect(breakdown?.modelName).toBe('claude-opus-4-6');
    expect(breakdown?.cost).toBeCloseTo(2.5, 9);
  });

  it('emits ccusage’s totals keys', () => {
    const { totals } = periodReport();
    for (const key of CCUSAGE_TOTALS_KEYS) expect(Object.keys(totals)).toContain(key);
    expect(totals.totalTokens).toBe(1495);
    expect(totals.totalCost).toBeCloseTo(3, 9);
  });

  it('sets agent to the single contributing platform, or all', () => {
    const [row] = periodReport().daily ?? [];
    expect(row?.agent).toBe('all');
    expect(row?.metadata.agents).toEqual(['anthropic', 'openrouter']);
    expect(row?.metadata.providers).toEqual(['anthropic', 'openrouter']);
  });
});

describe('aiusage additions', () => {
  it('attaches only the requested breakdowns', () => {
    const [row] = periodReport().daily ?? [];
    expect(row?.apiKeyBreakdowns?.map((entry) => entry.name)).toEqual([
      'Prod',
      '(no API key reported)',
    ]);
    expect(row?.accountBreakdowns?.map((entry) => entry.name)).toEqual([
      'Grace',
      '(no account reported)',
    ]);
    expect(row?.workspaceBreakdowns).toBeUndefined();
    expect(row?.providerBreakdowns).toBeUndefined();
  });

  it('records provenance per row and per platform', () => {
    const report = periodReport();
    const [row] = report.daily ?? [];
    expect(row?.metadata.costSource).toBe('mixed');
    expect(row?.metadata.requests).toBe(4);
    expect(row?.metadata.reasoningTokens).toBe(15);

    const anthropic = report.meta.providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.costSource).toBe('allocated');
    expect(anthropic?.recordCount).toBe(1);
    expect(anthropic?.totalCost).toBeCloseTo(2.5, 9);

    const openai = report.meta.providers.find((provider) => provider.id === 'openai');
    expect(openai?.status).toBe('skipped');
    expect(openai?.recordCount).toBe(0);
  });

  it('reports unattributed billed cost separately from row totals', () => {
    const report = periodReport();
    expect(report.meta.unattributedCost).toEqual([
      { provider: 'anthropic', cost: 0.0005, description: 'Web search', reason: 'not-allocatable' },
    ]);
  });

  it('carries the window, timezone and price sources in meta', () => {
    const { meta } = periodReport();
    expect(meta).toMatchObject({
      tool: 'aiusage',
      version: VERSION,
      granularity: 'daily',
      range: RANGE,
      timezone: 'UTC',
      costIncluded: true,
      priceSources: ['litellm@2026-07-26'],
      generatedAt: '2026-07-26T12:00:00.000Z',
    });
    expect(meta.notices.map((notice) => notice.code)).toContain('not-configured');
  });

  it('keeps the version in step with package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(manifest.version);
  });
});

describe('canonical model identity', () => {
  function reportWith(records: ReturnType<typeof costedRecord>[]) {
    const collection: Collection = { results: [], diagnostics: [] };
    const costing: CostingResult = { records, unattributed: [], diagnostics: [] };
    const options: ReportOptions = {
      granularity: 'daily',
      range: RANGE,
      timeZone: 'UTC',
      splits: ['model'],
      includeCost: true,
      generatedAt: new Date('2026-07-26T12:00:00Z'),
      priceSources: [],
    };
    const periods = aggregateByPeriod(records, {
      granularity: options.granularity,
      timeZone: options.timeZone,
      range: options.range,
      splits: options.splits,
    });
    return buildPeriodReport(periods, totalsOf(periods), collection, costing, options);
  }

  it('merges an OpenRouter-prefixed id and a first-party id into one modelBreakdowns row', () => {
    const report = reportWith([
      costedRecord({
        provider: 'openrouter',
        bucketStart: '2026-07-10T00:00:00.000Z',
        model: 'anthropic/claude-opus-5',
        costMicros: 2_000_000,
      }),
      costedRecord({
        provider: 'anthropic',
        bucketStart: '2026-07-10T00:00:00.000Z',
        model: 'claude-opus-5',
        costMicros: 1_000_000,
      }),
    ]);
    const [row] = report.daily ?? [];
    expect(row?.modelBreakdowns).toHaveLength(1);
    expect(row?.modelBreakdowns[0]?.modelName).toBe('claude-opus-5');
    expect(row?.modelBreakdowns[0]?.cost).toBeCloseTo(3, 9);

    expect(report.meta.notices.map((n) => n.code)).toContain('model-id-canonicalized');
    const notice = report.meta.notices.find((n) => n.code === 'model-id-canonicalized');
    expect(notice?.message).toContain('claude-opus-5');
    expect(notice?.message).toContain('anthropic/claude-opus-5');
  });

  it('says nothing when no raw model id actually collides with another', () => {
    const report = reportWith([
      costedRecord({
        provider: 'anthropic',
        bucketStart: '2026-07-10T00:00:00.000Z',
        model: 'claude-opus-5',
        costMicros: 1_000_000,
      }),
      costedRecord({
        provider: 'openai',
        bucketStart: '2026-07-10T00:00:00.000Z',
        model: 'gpt-5.6',
        costMicros: 1_000_000,
      }),
    ]);
    expect(report.meta.notices.map((n) => n.code)).not.toContain('model-id-canonicalized');
  });
});

describe('--no-cost', () => {
  it('omits every cost field rather than emitting zeroes', () => {
    const report = periodReport(false);
    const [row] = report.daily ?? [];
    expect(row).not.toHaveProperty('totalCost');
    expect(report.totals).not.toHaveProperty('totalCost');
    expect(row?.modelBreakdowns[0]).not.toHaveProperty('cost');
    expect(report.meta.providers[0]).not.toHaveProperty('totalCost');
    expect(report.meta.costIncluded).toBe(false);
  });
});

describe('dimension reports', () => {
  it('shapes one row per dimension value', () => {
    const { collection, costing, options } = fixtures();
    const buckets = aggregateByDimension(costing.records, 'apiKey');
    const report = buildDimensionReport(
      'apiKey',
      buckets,
      totalsOf(buckets),
      collection,
      costing,
      options,
    );

    expect(report.dimension).toBe('apiKey');
    expect(report.rows.map((row) => [row.name, row.totalTokens])).toEqual([
      ['Prod', 1420],
      ['(no API key reported)', 75],
    ]);
    expect(report.totals.totalTokens).toBe(1495);
  });
});
