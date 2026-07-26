import { describe, expect, it } from 'vitest';
import { createOpenRouterProvider } from '../../src/providers/openrouter.js';
import type { CollectContext } from '../../src/providers/types.js';
import { type StubRoute, stubClient } from '../helpers/http.js';

const NOW = new Date('2026-07-26T12:00:00Z');

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-07-25',
    model: 'anthropic/claude-opus-5',
    model_permaslug: 'anthropic/claude-opus-5-20260723',
    endpoint_id: 'endpoint-1',
    provider_name: 'Anthropic',
    usage: 0.015,
    byok_usage_inference: 0,
    requests: 5,
    prompt_tokens: 50,
    completion_tokens: 125,
    reasoning_tokens: 25,
    ...overrides,
  };
}

function context(routes: StubRoute[], range = { since: '2026-07-01', until: '2026-07-26' }) {
  const { http, fetch } = stubClient(routes);
  const ctx: CollectContext = { http, range, timeZone: 'UTC', concurrency: 2, now: NOW };
  return { ctx, fetch };
}

describe('OpenRouter provider', () => {
  it('splits activity per API key when a management key is configured', async () => {
    const { ctx, fetch } = context([
      {
        when: '/keys',
        body: {
          data: [
            { hash: 'hash-one', name: 'CI key', creator_user_id: 'user_1', workspace_id: 'ws_1' },
            { hash: 'hash-two', label: 'sk-or-v1-…9f2', creator_user_id: 'user_2' },
          ],
        },
      },
      { when: '/activity', and: ['api_key_hash=hash-one'], body: { data: [activityRow()] } },
      {
        when: '/activity',
        and: ['api_key_hash=hash-two'],
        body: { data: [activityRow({ usage: 0.5, model: 'openai/gpt-5.3' })] },
      },
    ]);

    const result = await createOpenRouterProvider({
      apiKey: null,
      managementKey: 'sk-or-v1-management',
    }).collect(ctx);

    expect(result.status).toBe('ok');
    expect(result.capabilities.splitByApiKey).toBe(true);
    expect(result.capabilities.splitByAccount).toBe(true);
    expect(result.capabilities.splitByWorkspace).toBe(true);
    expect(result.records).toHaveLength(2);

    const [first] = result.records;
    expect(first?.apiKey).toEqual({ id: 'hash-one', name: 'CI key' });
    expect(first?.account).toEqual({ id: 'user_1', name: null });
    expect(first?.workspace).toEqual({ id: 'ws_1', name: null });
    // 0.015 USD is reported directly by the platform, so it is not derived.
    expect(first?.reportedCostMicros).toBe(15_000);
    expect(first?.tokens).toEqual({
      input: 50,
      output: 125,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: 25,
    });
    expect(first?.tags.upstreamProvider).toBe('Anthropic');
    // Account attribution is derived from key ownership, and says so.
    expect(first?.tags.accountAttribution).toBe('key-creator');
    expect(fetch.calls.filter((url) => url.includes('/activity'))).toHaveLength(2);
  });

  it('falls back to a single unsplit activity call for an inference key', async () => {
    const { ctx, fetch } = context([{ when: '/activity', body: { data: [activityRow()] } }]);

    const result = await createOpenRouterProvider({
      apiKey: 'sk-or-v1-inference',
      managementKey: null,
    }).collect(ctx);

    expect(result.status).toBe('ok');
    expect(result.capabilities.splitByApiKey).toBe(false);
    expect(result.records[0]?.apiKey).toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toContain('no-management-key');
    expect(fetch.calls.some((url) => url.includes('/keys'))).toBe(false);
  });

  it('drops rows outside the requested window', async () => {
    const { ctx } = context(
      [
        {
          when: '/activity',
          body: {
            data: [activityRow({ date: '2026-06-01' }), activityRow({ date: '2026-07-25' })],
          },
        },
      ],
      { since: '2026-07-20', until: '2026-07-26' },
    );

    const result = await createOpenRouterProvider({ apiKey: 'k', managementKey: null }).collect(
      ctx,
    );
    expect(result.records.map((record) => record.bucketStart)).toEqual([
      '2026-07-25T00:00:00.000Z',
    ]);
  });

  it('warns when the window reaches past the 30-day lookback', async () => {
    const { ctx } = context([{ when: '/activity', body: { data: [] } }], {
      since: '2026-01-01',
      until: '2026-07-26',
    });

    const result = await createOpenRouterProvider({ apiKey: 'k', managementKey: null }).collect(
      ctx,
    );
    expect(result.status).toBe('partial');
    expect(result.diagnostics.map((d) => d.code)).toContain('lookback-truncated');
  });

  it('warns that a non-UTC timezone cannot be honoured', async () => {
    const { http } = stubClient([{ when: '/activity', body: { data: [] } }]);
    const result = await createOpenRouterProvider({ apiKey: 'k', managementKey: null }).collect({
      http,
      range: { since: '2026-07-01', until: '2026-07-26' },
      timeZone: 'Europe/Berlin',
      concurrency: 2,
      now: NOW,
    });
    expect(result.diagnostics.map((d) => d.code)).toContain('timezone-approximation');
  });

  it('keeps BYOK spend out of the reported cost', async () => {
    const { ctx } = context([
      {
        when: '/activity',
        body: { data: [activityRow({ usage: 0, byok_usage_inference: 0.012 })] },
      },
    ]);

    const result = await createOpenRouterProvider({ apiKey: 'k', managementKey: null }).collect(
      ctx,
    );
    expect(result.records[0]?.reportedCostMicros).toBe(0);
    expect(result.records[0]?.extras.byokCostMicros).toBe(12_000);
  });

  it('reports an auth failure as an error rather than empty usage', async () => {
    const { ctx } = context([{ when: '/activity', status: 401, body: { error: 'bad key' } }]);

    const result = await createOpenRouterProvider({ apiKey: 'k', managementKey: null }).collect(
      ctx,
    );
    expect(result.status).toBe('error');
    expect(result.capabilities.usage).toBe(false);
    expect(result.diagnostics.at(-1)?.code).toBe('auth-failed');
  });

  it('degrades to unsplit activity when the keys endpoint is refused', async () => {
    const { ctx } = context([
      { when: '/keys', status: 403, body: { error: 'not a management key' } },
      { when: '/activity', body: { data: [activityRow()] } },
    ]);

    const result = await createOpenRouterProvider({
      apiKey: null,
      managementKey: 'sk-or-v1-not-management',
    }).collect(ctx);

    expect(result.status).toBe('partial');
    expect(result.capabilities.splitByApiKey).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('keys-unavailable');
    expect(result.records).toHaveLength(1);
  });
});
