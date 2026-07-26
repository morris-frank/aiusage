import { describe, expect, it } from 'vitest';
import { authHeaders, createAnthropicProvider } from '../../src/providers/anthropic.js';
import type { CollectContext } from '../../src/providers/types.js';
import { type StubRoute, stubClient } from '../helpers/http.js';

const NOW = new Date('2026-07-26T12:00:00Z');
const RANGE = { since: '2026-07-24', until: '2026-07-25' };

const USAGE_BUCKET = {
  starting_at: '2026-07-25T00:00:00Z',
  ending_at: '2026-07-26T00:00:00Z',
  results: [
    {
      account_id: 'user_01',
      api_key_id: 'apikey_01',
      workspace_id: 'wrkspc_01',
      model: 'claude-opus-4-6',
      context_window: '0-200k',
      service_tier: 'standard',
      inference_geo: 'global',
      uncached_input_tokens: 1500,
      cache_read_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1000 },
      output_tokens: 500,
      server_tool_use: { web_search_requests: 10 },
    },
  ],
};

const NAME_ROUTES: StubRoute[] = [
  {
    when: '/organizations/users',
    body: { data: [{ id: 'user_01', name: 'Grace' }], has_more: false },
  },
  {
    when: '/organizations/api_keys',
    body: { data: [{ id: 'apikey_01', name: 'Prod key' }], has_more: false },
  },
  {
    when: '/organizations/workspaces',
    body: { data: [{ id: 'wrkspc_01', name: 'Platform' }], has_more: false },
  },
];

function context(routes: StubRoute[], timeZone = 'UTC') {
  const { http, fetch } = stubClient(routes);
  const ctx: CollectContext = { http, range: RANGE, timeZone, concurrency: 2, now: NOW };
  return { ctx, fetch };
}

describe('Anthropic auth', () => {
  it('uses x-api-key for admin keys and bearer for OAuth tokens', () => {
    expect(authHeaders('sk-ant-admin01-abc')).toEqual({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-admin01-abc',
    });
    expect(authHeaders('oauth-token-value')).toEqual({
      'anthropic-version': '2023-06-01',
      authorization: 'Bearer oauth-token-value',
    });
  });
});

describe('Anthropic provider', () => {
  it('maps the usage report onto normalised token counts', async () => {
    const { ctx, fetch } = context([
      { when: '/usage_report/messages', body: { data: [USAGE_BUCKET], has_more: false } },
      ...NAME_ROUTES,
      { when: '/cost_report', body: { data: [], has_more: false } },
    ]);

    const result = await createAnthropicProvider({ adminKey: 'sk-ant-admin01-x' }).collect(ctx);

    expect(result.status).toBe('ok');
    const [record] = result.records;
    // 5-minute and 1-hour cache writes are both cache creation.
    expect(record?.tokens).toEqual({
      input: 1500,
      output: 500,
      cacheCreation: 1500,
      cacheRead: 200,
      reasoning: 0,
    });
    expect(record?.account).toEqual({ id: 'user_01', name: 'Grace' });
    expect(record?.apiKey).toEqual({ id: 'apikey_01', name: 'Prod key' });
    expect(record?.workspace).toEqual({ id: 'wrkspc_01', name: 'Platform' });
    expect(record?.tags).toEqual({
      contextWindow: '0-200k',
      serviceTier: 'standard',
      inferenceGeo: 'global',
    });
    expect(record?.extras).toEqual({ webSearchRequests: 10, cacheCreation1hTokens: 1000 });
    // Anthropic's usage report counts tokens, not requests.
    expect(record?.requests).toBeNull();
    // group_by must be sent in bracket form.
    expect(fetch.calls[0]).toContain('group_by%5B%5D=model');
  });

  it('reads cost in cents and only allocates token charges', async () => {
    const { ctx } = context([
      { when: '/usage_report/messages', body: { data: [USAGE_BUCKET], has_more: false } },
      ...NAME_ROUTES,
      {
        when: '/cost_report',
        body: {
          data: [
            {
              starting_at: '2026-07-25T00:00:00Z',
              ending_at: '2026-07-26T00:00:00Z',
              results: [
                {
                  amount: '123.78912',
                  currency: 'USD',
                  cost_type: 'tokens',
                  description: 'Claude Opus 4.6 Usage - Input Tokens',
                  model: 'claude-opus-4-6',
                  token_type: 'uncached_input_tokens',
                  workspace_id: 'wrkspc_01',
                },
                {
                  amount: '50',
                  currency: 'USD',
                  cost_type: 'web_search',
                  description: 'Web search requests',
                  model: null,
                  workspace_id: 'wrkspc_01',
                },
              ],
            },
          ],
          has_more: false,
        },
      },
    ]);

    const result = await createAnthropicProvider({ adminKey: 'sk-ant-admin01-x' }).collect(ctx);

    expect(result.costRecords).toHaveLength(2);
    const [tokens, webSearch] = result.costRecords;
    expect(tokens?.amountMicros).toBe(1_237_891);
    expect(tokens?.allocatable).toBe(true);
    expect(tokens?.model).toBe('claude-opus-4-6');
    // A web-search charge is not token consumption, so it must not be spread
    // across token counts.
    expect(webSearch?.allocatable).toBe(false);
    expect(webSearch?.amountMicros).toBe(500_000);
  });

  it('marks a service-account principal instead of merging id spaces', async () => {
    const bucket = {
      ...USAGE_BUCKET,
      results: [{ ...USAGE_BUCKET.results[0], account_id: null, service_account_id: 'svac_01' }],
    };
    const { ctx } = context([
      { when: '/usage_report/messages', body: { data: [bucket], has_more: false } },
      ...NAME_ROUTES,
      { when: '/cost_report', body: { data: [], has_more: false } },
    ]);

    const result = await createAnthropicProvider({ adminKey: 'sk-ant-admin01-x' }).collect(ctx);
    expect(result.records[0]?.account?.id).toBe('svac_01');
    expect(result.records[0]?.tags.accountType).toBe('service_account');
  });

  it('reduces the grouping when the API rejects it', async () => {
    const { ctx } = context([
      {
        when: '/usage_report/messages',
        and: ['group_by%5B%5D=service_tier'],
        status: 400,
        body: { error: { message: 'too many groups' } },
      },
      { when: '/usage_report/messages', body: { data: [USAGE_BUCKET], has_more: false } },
      ...NAME_ROUTES,
      { when: '/cost_report', body: { data: [], has_more: false } },
    ]);

    const result = await createAnthropicProvider({ adminKey: 'sk-ant-admin01-x' }).collect(ctx);
    expect(result.status).toBe('partial');
    expect(result.diagnostics.map((d) => d.code)).toContain('group-by-reduced');
    expect(result.records).toHaveLength(1);
  });

  it('still returns token usage when the cost report fails', async () => {
    const { ctx } = context([
      { when: '/usage_report/messages', body: { data: [USAGE_BUCKET], has_more: false } },
      ...NAME_ROUTES,
      { when: '/cost_report', status: 403, body: { error: 'forbidden' } },
    ]);

    const result = await createAnthropicProvider({ adminKey: 'sk-ant-admin01-x' }).collect(ctx);
    expect(result.records).toHaveLength(1);
    expect(result.costRecords).toHaveLength(0);
    expect(result.capabilities.reportedCost).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('costs-unavailable');
  });

  it('asks for hourly buckets when the report is grouped outside UTC', async () => {
    const { ctx, fetch } = context(
      [
        { when: '/usage_report/messages', body: { data: [], has_more: false } },
        ...NAME_ROUTES,
        { when: '/cost_report', body: { data: [], has_more: false } },
      ],
      'Europe/Berlin',
    );

    await createAnthropicProvider({ adminKey: 'sk-ant-admin01-x' }).collect(ctx);
    expect(fetch.calls[0]).toContain('bucket_width=1h');
    // The cost report only supports daily buckets, whatever the timezone.
    expect(fetch.calls.find((url) => url.includes('cost_report'))).toContain('bucket_width=1d');
  });
});
