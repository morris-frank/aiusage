import { describe, expect, it } from 'vitest';
import { createOpenAIProvider } from '../../src/providers/openai.js';
import type { CollectContext } from '../../src/providers/types.js';
import { type StubRoute, stubClient } from '../helpers/http.js';

const NOW = new Date('2026-07-26T12:00:00Z');
const RANGE = { since: '2026-07-24', until: '2026-07-25' };

const USAGE_BUCKET = {
  object: 'bucket',
  start_time: Date.parse('2026-07-25T00:00:00Z') / 1000,
  end_time: Date.parse('2026-07-26T00:00:00Z') / 1000,
  results: [
    {
      input_tokens: 1000,
      input_cached_tokens: 400,
      input_cache_write_tokens: 100,
      output_tokens: 250,
      num_model_requests: 12,
      project_id: 'proj_1',
      user_id: 'user_1',
      api_key_id: 'key_1',
      model: 'gpt-5.3',
      batch: false,
      service_tier: 'default',
    },
  ],
};

const NAME_ROUTES: StubRoute[] = [
  { when: '/organization/users', body: { data: [{ id: 'user_1', name: 'Ada' }], has_more: false } },
  {
    when: '/organization/projects/proj_1/api_keys',
    body: { data: [{ id: 'key_1', name: 'CI key' }], has_more: false },
  },
  {
    when: '/organization/projects',
    body: { data: [{ id: 'proj_1', name: 'Research' }], has_more: false },
  },
];

function context(routes: StubRoute[]) {
  const { http, fetch } = stubClient(routes);
  const ctx: CollectContext = { http, range: RANGE, timeZone: 'UTC', concurrency: 2, now: NOW };
  return { ctx, fetch };
}

describe('OpenAI provider', () => {
  it('normalises cache-inclusive input counts and resolves names', async () => {
    const { ctx } = context([
      { when: '/organization/usage/completions', body: { data: [USAGE_BUCKET], has_more: false } },
      ...NAME_ROUTES,
      {
        when: '/organization/costs',
        body: {
          data: [
            {
              start_time: USAGE_BUCKET.start_time,
              end_time: USAGE_BUCKET.end_time,
              results: [
                {
                  amount: { value: 0.06, currency: 'usd' },
                  line_item: 'gpt-5.3, input',
                  project_id: 'proj_1',
                },
              ],
            },
          ],
          has_more: false,
        },
      },
    ]);

    const result = await createOpenAIProvider({ adminKey: 'sk-admin-x', orgId: null }).collect(ctx);

    expect(result.status).toBe('ok');
    const [record] = result.records;
    // input_tokens includes the 400 cached; uncached input is the difference.
    expect(record?.tokens).toEqual({
      input: 600,
      output: 250,
      cacheCreation: 100,
      cacheRead: 400,
      reasoning: 0,
    });
    expect(record?.requests).toBe(12);
    expect(record?.account).toEqual({ id: 'user_1', name: 'Ada' });
    expect(record?.apiKey).toEqual({ id: 'key_1', name: 'CI key' });
    expect(record?.workspace).toEqual({ id: 'proj_1', name: 'Research' });
    // The usage endpoint carries no money at all.
    expect(record?.reportedCostMicros).toBeNull();

    expect(result.costRecords).toEqual([
      {
        provider: 'openai',
        bucketStart: '2026-07-25T00:00:00.000Z',
        bucketEnd: '2026-07-26T00:00:00.000Z',
        model: null,
        workspace: { id: 'proj_1', name: null },
        amountMicros: 60_000,
        description: 'gpt-5.3, input',
        allocatable: true,
      },
    ]);
  });

  it('prefers an explicit uncached input count when the API sends one', async () => {
    const bucket = {
      ...USAGE_BUCKET,
      results: [{ ...USAGE_BUCKET.results[0], input_uncached_tokens: 555 }],
    };
    const { ctx } = context([
      { when: '/organization/usage/completions', body: { data: [bucket], has_more: false } },
      ...NAME_ROUTES,
      { when: '/organization/costs', body: { data: [], has_more: false } },
    ]);

    const result = await createOpenAIProvider({ adminKey: 'sk-admin-x', orgId: null }).collect(ctx);
    expect(result.records[0]?.tokens.input).toBe(555);
  });

  it('steps down the group-by ladder when the API rejects the full grouping', async () => {
    const { ctx, fetch } = context([
      {
        when: '/organization/usage/completions',
        and: ['group_by=user_id'],
        status: 400,
        body: { error: { message: 'grouping not supported' } },
      },
      { when: '/organization/usage/completions', body: { data: [USAGE_BUCKET], has_more: false } },
      ...NAME_ROUTES,
      { when: '/organization/costs', body: { data: [], has_more: false } },
    ]);

    const result = await createOpenAIProvider({ adminKey: 'sk-admin-x', orgId: null }).collect(ctx);

    expect(result.status).toBe('partial');
    expect(result.capabilities.splitByAccount).toBe(false);
    expect(result.capabilities.splitByApiKey).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain('group-by-reduced');
    expect(fetch.calls.filter((url) => url.includes('usage/completions'))).toHaveLength(2);
  });

  it('follows pagination until the API says it is done', async () => {
    const second = { ...USAGE_BUCKET, start_time: USAGE_BUCKET.start_time - 86_400 };
    const { ctx } = context([
      {
        when: '/organization/usage/completions',
        body: { data: [USAGE_BUCKET], has_more: true, next_page: 'page-2' },
        times: 1,
      },
      {
        when: '/organization/usage/completions',
        and: ['page=page-2'],
        body: { data: [second], has_more: false },
      },
      ...NAME_ROUTES,
      { when: '/organization/costs', body: { data: [], has_more: false } },
    ]);

    const result = await createOpenAIProvider({ adminKey: 'sk-admin-x', orgId: null }).collect(ctx);
    expect(result.records).toHaveLength(2);
  });

  it('refuses to convert a non-USD cost row', async () => {
    const { ctx } = context([
      { when: '/organization/usage/completions', body: { data: [], has_more: false } },
      ...NAME_ROUTES,
      {
        when: '/organization/costs',
        body: {
          data: [
            {
              start_time: USAGE_BUCKET.start_time,
              end_time: USAGE_BUCKET.end_time,
              results: [{ amount: { value: 1, currency: 'eur' }, project_id: 'proj_1' }],
            },
          ],
          has_more: false,
        },
      },
    ]);

    const result = await createOpenAIProvider({ adminKey: 'sk-admin-x', orgId: null }).collect(ctx);
    expect(result.costRecords).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toContain('non-usd-cost');
  });

  it('explains that an admin key is required when the API says 401', async () => {
    const { ctx } = context([
      { when: '/organization/usage/completions', status: 401, body: { error: 'no' } },
    ]);

    const result = await createOpenAIProvider({ adminKey: 'sk-proj-x', orgId: null }).collect(ctx);
    expect(result.status).toBe('error');
    expect(result.diagnostics.at(-1)?.message).toContain('admin key');
  });

  it('requests hourly buckets when grouping in a non-UTC timezone', async () => {
    const { http, fetch } = stubClient([
      { when: '/organization/usage/completions', body: { data: [], has_more: false } },
      ...NAME_ROUTES,
      { when: '/organization/costs', body: { data: [], has_more: false } },
    ]);
    await createOpenAIProvider({ adminKey: 'sk-admin-x', orgId: null }).collect({
      http,
      range: RANGE,
      timeZone: 'Asia/Tokyo',
      concurrency: 2,
      now: NOW,
    });

    expect(fetch.calls[0]).toContain('bucket_width=1h');
  });
});
