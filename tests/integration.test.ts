import { describe, expect, it } from 'vitest';
import {
  aggregateByDimension,
  aggregateByPeriod,
  applyCosts,
  buildDimensionReport,
  buildPeriodReport,
  collectUsage,
  createCompositePriceBook,
  type RuntimeConfig,
  totalsOf,
} from '../src/index.js';
import { buildLiteLlmPriceBook } from '../src/pricing/litellm.js';
import { type StubRoute, stubClient } from './helpers/http.js';

/**
 * End to end over all four platforms at once: collect → cost → aggregate →
 * report, with every HTTP call answered from fixtures. This is the test that
 * would catch a break in the seam between the layers.
 */

const NOW = new Date('2026-07-26T12:00:00Z');
const RANGE = { since: '2026-07-24', until: '2026-07-25' };
const DAY = {
  start: Date.parse('2026-07-25T00:00:00Z') / 1000,
  end: Date.parse('2026-07-26T00:00:00Z') / 1000,
};

const CONFIG: RuntimeConfig = {
  credentials: {
    openrouter: { apiKey: null, managementKey: 'sk-or-v1-management' },
    together: { apiKey: 'together-key' },
    openai: { adminKey: 'sk-admin-key', orgId: null },
    anthropic: { adminKey: 'sk-ant-admin01-key' },
  },
  cacheDir: '/nonexistent',
  timeoutMs: 1000,
  concurrency: 4,
  secrets: ['sk-admin-key', 'sk-ant-admin01-key'],
};

const ROUTES: StubRoute[] = [
  // ── OpenRouter: management key → per-key activity, cost reported per row.
  {
    when: 'openrouter.ai/api/v1/keys',
    body: {
      data: [{ hash: 'hash-a', name: 'Agents key', creator_user_id: 'or_user_1' }],
    },
  },
  {
    when: 'openrouter.ai/api/v1/activity',
    body: {
      data: [
        {
          date: '2026-07-25',
          model: 'anthropic/claude-opus-5',
          provider_name: 'Anthropic',
          usage: 0.25,
          byok_usage_inference: 0,
          requests: 4,
          prompt_tokens: 2000,
          completion_tokens: 400,
          reasoning_tokens: 100,
        },
      ],
    },
  },
  // ── Together: identity only; no usage API exists.
  { when: 'api.together.xyz/v1/whoami', body: { organization_id: 'org_1', project_id: 'proj_t' } },
  // ── OpenAI: tokens per key/user/project, money per project-day.
  {
    when: 'api.openai.com/v1/organization/usage/completions',
    body: {
      data: [
        {
          start_time: DAY.start,
          end_time: DAY.end,
          results: [
            {
              input_tokens: 10_000,
              input_cached_tokens: 2000,
              output_tokens: 1000,
              num_model_requests: 20,
              project_id: 'proj_1',
              user_id: 'oai_user_1',
              api_key_id: 'oai_key_1',
              model: 'gpt-5.3',
            },
            {
              input_tokens: 5000,
              input_cached_tokens: 0,
              output_tokens: 500,
              num_model_requests: 10,
              project_id: 'proj_1',
              user_id: 'oai_user_2',
              api_key_id: 'oai_key_2',
              model: 'gpt-5.3',
            },
          ],
        },
      ],
      has_more: false,
    },
  },
  {
    when: 'api.openai.com/v1/organization/users',
    body: {
      data: [
        { id: 'oai_user_1', name: 'Ada' },
        { id: 'oai_user_2', name: 'Linus' },
      ],
      has_more: false,
    },
  },
  {
    when: 'api.openai.com/v1/organization/projects/proj_1/api_keys',
    body: {
      data: [
        { id: 'oai_key_1', name: 'Batch key' },
        { id: 'oai_key_2', name: 'Notebook key' },
      ],
      has_more: false,
    },
  },
  {
    when: 'api.openai.com/v1/organization/projects',
    body: { data: [{ id: 'proj_1', name: 'Research' }], has_more: false },
  },
  {
    when: 'api.openai.com/v1/organization/costs',
    body: {
      data: [
        {
          start_time: DAY.start,
          end_time: DAY.end,
          results: [
            {
              amount: { value: 3, currency: 'usd' },
              line_item: 'gpt-5.3, input',
              project_id: 'proj_1',
            },
          ],
        },
      ],
      has_more: false,
    },
  },
  // ── Anthropic: the fullest split, plus billed cost per model-day.
  {
    when: 'api.anthropic.com/v1/organizations/usage_report/messages',
    body: {
      data: [
        {
          starting_at: '2026-07-25T00:00:00Z',
          ending_at: '2026-07-26T00:00:00Z',
          results: [
            {
              account_id: 'ant_user_1',
              api_key_id: 'ant_key_1',
              workspace_id: 'ws_1',
              model: 'claude-opus-4-6',
              context_window: '0-200k',
              uncached_input_tokens: 20_000,
              cache_read_input_tokens: 5000,
              cache_creation: { ephemeral_5m_input_tokens: 1000 },
              output_tokens: 2000,
            },
            {
              account_id: 'ant_user_2',
              api_key_id: 'ant_key_2',
              workspace_id: 'ws_1',
              model: 'claude-opus-4-6',
              context_window: '0-200k',
              uncached_input_tokens: 60_000,
              cache_read_input_tokens: 0,
              cache_creation: null,
              output_tokens: 6000,
            },
          ],
        },
      ],
      has_more: false,
    },
  },
  {
    when: 'api.anthropic.com/v1/organizations/users',
    body: {
      data: [
        { id: 'ant_user_1', name: 'Grace' },
        { id: 'ant_user_2', name: 'Alan' },
      ],
      has_more: false,
    },
  },
  {
    when: 'api.anthropic.com/v1/organizations/api_keys',
    body: {
      data: [
        { id: 'ant_key_1', name: 'Dashboard key' },
        { id: 'ant_key_2', name: 'Pipeline key' },
      ],
      has_more: false,
    },
  },
  {
    when: 'api.anthropic.com/v1/organizations/workspaces',
    body: { data: [{ id: 'ws_1', name: 'Platform' }], has_more: false },
  },
  {
    when: 'api.anthropic.com/v1/organizations/cost_report',
    body: {
      data: [
        {
          starting_at: '2026-07-25T00:00:00Z',
          ending_at: '2026-07-26T00:00:00Z',
          results: [
            {
              amount: '4000',
              currency: 'USD',
              cost_type: 'tokens',
              description: 'Claude Opus 4.6 Usage - Input Tokens',
              model: 'claude-opus-4-6',
              workspace_id: 'ws_1',
            },
            {
              amount: '100',
              currency: 'USD',
              cost_type: 'web_search',
              description: 'Web search requests',
              model: null,
              workspace_id: 'ws_1',
            },
          ],
        },
      ],
      has_more: false,
    },
  },
];

const PRICE_BOOK = (() => {
  const litellm = buildLiteLlmPriceBook(
    {
      'gpt-5.3': {
        litellm_provider: 'openai',
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 1.25e-7,
      },
      'claude-opus-4-6': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 5e-7,
        cache_creation_input_token_cost: 0.00000625,
      },
    },
    'litellm@test',
  );
  return createCompositePriceBook({
    openrouter: [litellm],
    together: [litellm],
    openai: [litellm],
    anthropic: [litellm],
  });
})();

async function pipeline() {
  const { http } = stubClient(ROUTES);
  const collection = await collectUsage({
    config: CONFIG,
    range: RANGE,
    timeZone: 'UTC',
    http,
    now: NOW,
  });
  const costing = applyCosts(collection.results, PRICE_BOOK);
  return { collection, costing };
}

describe('the whole pipeline over four platforms', () => {
  it('collects every platform that has a usage API, in a stable order', async () => {
    const { collection } = await pipeline();
    expect(collection.results.map((result) => [result.provider, result.status])).toEqual([
      ['openrouter', 'ok'],
      ['together', 'unsupported'],
      ['openai', 'ok'],
      ['anthropic', 'ok'],
    ]);
  });

  it('keeps each platform’s cost provenance distinct', async () => {
    const { costing } = await pipeline();
    const sources = new Map(costing.records.map((record) => [record.provider, record.costSource]));
    // OpenRouter bills per activity row…
    expect(sources.get('openrouter')).toBe('reported');
    // …while OpenAI and Anthropic bill coarser than they measure.
    expect(sources.get('openai')).toBe('allocated');
    expect(sources.get('anthropic')).toBe('allocated');
  });

  it('allocates each platform’s billed total exactly, and no further', async () => {
    const { costing } = await pipeline();
    const totalFor = (provider: string) =>
      costing.records
        .filter((record) => record.provider === provider)
        .reduce((sum, record) => sum + (record.costMicros ?? 0), 0);

    expect(totalFor('openrouter')).toBe(250_000); // $0.25 reported
    expect(totalFor('openai')).toBe(3_000_000); // $3.00 billed for the project-day
    expect(totalFor('anthropic')).toBe(40_000_000); // 4000 cents of token cost

    // The web-search charge is real money that is not token consumption.
    expect(costing.unattributed).toEqual([
      {
        provider: 'anthropic',
        amountMicros: 1_000_000,
        description: 'Web search requests',
        reason: 'not-allocatable',
      },
    ]);
  });

  it('answers "which user spent what" across platforms', async () => {
    const { collection, costing } = await pipeline();
    const buckets = aggregateByDimension(costing.records, 'account');
    const report = buildDimensionReport(
      'account',
      buckets,
      totalsOf(buckets),
      collection,
      costing,
      {
        granularity: 'daily',
        range: RANGE,
        timeZone: 'UTC',
        splits: [],
        includeCost: true,
        generatedAt: NOW,
        priceSources: ['litellm@test'],
      },
    );

    expect(report.rows.map((row) => [row.name, Number(row.cost?.toFixed(4))])).toEqual([
      // Anthropic's $40 of token cost, split by derived cost: Alan's 60k input +
      // 6k output derive $0.45 against Grace's $0.15875 (she also has cache
      // tokens), so Alan takes 0.45/0.60875 of the billed total.
      ['Alan', 29.5688],
      ['Grace', 10.4312],
      // OpenAI's $3 project-day total, split the same way: $0.02025 vs $0.01125.
      ['Ada', 1.9286],
      ['Linus', 1.0714],
      // OpenRouter reports its own $0.25 directly.
      ['or_user_1', 0.25],
    ]);
    // Every user's money is accounted for.
    expect(Number(report.totals.totalCost?.toFixed(4))).toBe(43.25);
  });

  it('answers "which API key spent what", with names', async () => {
    const { costing } = await pipeline();
    const buckets = aggregateByDimension(costing.records, 'apiKey');
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'Pipeline key',
      'Dashboard key',
      'Batch key',
      'Notebook key',
      'Agents key',
    ]);
  });

  it('produces a ccusage-shaped daily report with every platform folded in', async () => {
    const { collection, costing } = await pipeline();
    const periods = aggregateByPeriod(costing.records, {
      granularity: 'daily',
      timeZone: 'UTC',
      range: RANGE,
      splits: ['model', 'apiKey', 'account', 'provider'],
    });
    const report = buildPeriodReport(periods, totalsOf(periods), collection, costing, {
      granularity: 'daily',
      range: RANGE,
      timeZone: 'UTC',
      splits: ['model', 'apiKey', 'account', 'provider'],
      includeCost: true,
      generatedAt: NOW,
      priceSources: ['litellm@test'],
    });

    expect(report.daily).toHaveLength(1);
    const [row] = report.daily ?? [];
    expect(row?.period).toBe('2026-07-25');
    expect(row?.agent).toBe('all');
    expect(row?.metadata.providers).toEqual(['anthropic', 'openai', 'openrouter']);
    // Uncached input only: 2000 (OpenRouter) + 8000 + 5000 (OpenAI, the 2000
    // cached tokens counted separately) + 20000 + 60000 (Anthropic).
    expect(row?.inputTokens).toBe(95_000);
    expect(row?.outputTokens).toBe(9900);
    expect(row?.cacheCreationTokens).toBe(1000);
    expect(row?.cacheReadTokens).toBe(7000);
    expect(row?.metadata.requests).toBe(34);
    expect(row?.metadata.costSource).toBe('mixed');
    expect(row?.modelsUsed).toEqual(['anthropic/claude-opus-5', 'claude-opus-4-6', 'gpt-5.3']);
    expect(row?.providerBreakdowns?.map((entry) => entry.id)).toEqual([
      'anthropic',
      'openai',
      'openrouter',
    ]);
    expect(Number(report.totals.totalCost?.toFixed(2))).toBe(43.25);

    // Together is present, visibly unsupported, and contributes no rows.
    const together = report.meta.providers.find((provider) => provider.id === 'together');
    expect(together?.status).toBe('unsupported');
    expect(report.meta.notices.map((notice) => notice.code)).toContain('usage-api-unavailable');
  });

  it('carries on when one platform fails', async () => {
    const broken = ROUTES.map((route) =>
      route.when === 'api.openai.com/v1/organization/usage/completions'
        ? { ...route, status: 401, body: { error: 'not an admin key' } }
        : route,
    );
    const { http } = stubClient(broken);
    const collection = await collectUsage({
      config: CONFIG,
      range: RANGE,
      timeZone: 'UTC',
      http,
      now: NOW,
    });

    expect(collection.results.find((result) => result.provider === 'openai')?.status).toBe('error');
    expect(collection.results.find((result) => result.provider === 'anthropic')?.status).toBe('ok');
    const costing = applyCosts(collection.results, PRICE_BOOK);
    expect(costing.records.some((record) => record.provider === 'anthropic')).toBe(true);
  });

  it('restricts the run when asked for one platform', async () => {
    const { http } = stubClient(ROUTES);
    const collection = await collectUsage({
      config: CONFIG,
      range: RANGE,
      timeZone: 'UTC',
      only: ['anthropic'],
      http,
      now: NOW,
    });
    expect(collection.results.map((result) => result.provider)).toEqual(['anthropic']);
  });
});
