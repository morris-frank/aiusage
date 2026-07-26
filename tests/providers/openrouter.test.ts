import { describe, expect, it } from 'vitest';
import type { OpenRouterKey } from '../../src/config.js';
import { createOpenRouterProvider } from '../../src/providers/openrouter.js';
import type { CollectContext } from '../../src/providers/types.js';
import { type StubRoute, stubClient } from '../helpers/http.js';

const NOW = new Date('2026-07-26T12:00:00Z');

/**
 * `/activity` reports its date as `"YYYY-MM-DD HH:mm:ss"` (observed 2026-07-26),
 * not the bare date the reference implies. Fixtures use the real shape.
 */
function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-07-25 00:00:00',
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

function managementKey(label = 'management'): OpenRouterKey {
  return { label, secret: `sk-or-v1-${label}`, declaredKind: 'management', labelled: false };
}

function inferenceKey(label = 'inference'): OpenRouterKey {
  return { label, secret: `sk-or-v1-${label}`, declaredKind: 'inference', labelled: false };
}

/**
 * `/v1/keys` must be listed before `/v1/key`: routes match on substring in order,
 * and the probe path is a prefix of the listing path.
 */
function keysRoute(data: unknown[]): StubRoute {
  return { when: '/v1/keys', body: { data } };
}

function probeRoute(management: boolean, label = 'sk-or-v1-abc...xyz'): StubRoute {
  return { when: '/v1/key', body: { data: { label, is_management_key: management } } };
}

function context(routes: StubRoute[], range = { since: '2026-07-01', until: '2026-07-26' }) {
  const { http, fetch } = stubClient(routes);
  const ctx: CollectContext = { http, range, timeZone: 'UTC', concurrency: 2, now: NOW };
  return { ctx, fetch };
}

describe('OpenRouter provider', () => {
  it('splits activity per API key when a management key is configured', async () => {
    const { ctx, fetch } = context([
      keysRoute([
        { hash: 'hash-one', name: 'CI key', creator_user_id: 'user_1', workspace_id: 'ws_1' },
        { hash: 'hash-two', label: 'sk-or-v1-…9f2', creator_user_id: 'user_2' },
      ]),
      probeRoute(true),
      { when: '/activity', and: ['api_key_hash=hash-one'], body: { data: [activityRow()] } },
      {
        when: '/activity',
        and: ['api_key_hash=hash-two'],
        body: { data: [activityRow({ usage: 0.5, model: 'openai/gpt-5.3' })] },
      },
    ]);

    const result = await createOpenRouterProvider({ keys: [managementKey()] }).collect(ctx);

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

  it('reads the timestamped activity date as a UTC day instead of dropping the row', async () => {
    const { ctx } = context([
      probeRoute(false),
      { when: '/activity', body: { data: [activityRow({ date: '2026-07-26 00:00:00' })] } },
    ]);

    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect(ctx);
    // The window ends on 2026-07-26: a timestamped date must still land inside it.
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.bucketStart).toBe('2026-07-26T00:00:00.000Z');
    expect(result.records[0]?.bucketEnd).toBe('2026-07-27T00:00:00.000Z');
  });

  it('reports rows whose date it cannot read as missing, not as zero', async () => {
    const { ctx } = context([
      probeRoute(false),
      {
        when: '/activity',
        body: { data: [activityRow({ date: 'last tuesday' }), activityRow()] },
      },
    ]);

    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect(ctx);
    expect(result.records).toHaveLength(1);
    expect(result.status).toBe('partial');
    expect(result.diagnostics.map((d) => d.code)).toContain('bucket-unparseable');
  });

  it('falls back to a single unsplit activity call for an inference key', async () => {
    const { ctx, fetch } = context([
      probeRoute(false, 'sk-or-v1-7a4...dda'),
      { when: '/activity', body: { data: [activityRow()] } },
    ]);

    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect(ctx);

    expect(result.status).toBe('ok');
    // The masked label is the only key identifier OpenRouter returns here, so it
    // is used as the id — and tagged as masked rather than passed off as a hash.
    expect(result.records[0]?.apiKey).toEqual({ id: 'sk-or-v1-7a4...dda', name: 'inference' });
    expect(result.records[0]?.tags.apiKeyIdSource).toBe('masked-label');
    expect(result.capabilities.splitByAccount).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('no-management-key');
    expect(fetch.calls.some((url) => url.includes('/v1/keys'))).toBe(false);
  });

  it('uses a management key that was set as an inference key, and says so', async () => {
    const { ctx } = context([
      keysRoute([{ hash: 'hash-one', name: 'CI key', workspace_id: 'ws_1' }]),
      probeRoute(true),
      { when: '/activity', body: { data: [activityRow()] } },
    ]);

    const result = await createOpenRouterProvider({ keys: [inferenceKey('api')] }).collect(ctx);

    expect(result.diagnostics.map((d) => d.code)).toContain('key-kind-mismatch');
    expect(result.capabilities.splitByApiKey).toBe(true);
    expect(result.records[0]?.apiKey?.id).toBe('hash-one');
  });

  it('collects several workspaces from one management key each, without double counting', async () => {
    const { http, fetch } = stubClient([
      // Each workspace's management key sees its own keys; the second also sees
      // the first workspace's key, which must not be collected twice.
      {
        when: '/v1/keys',
        and: ['offset=0'],
        times: 1,
        body: { data: [{ hash: 'hash-a', name: 'acme key', workspace_id: 'ws_a' }] },
      },
      {
        when: '/v1/keys',
        and: ['offset=0'],
        times: 1,
        body: {
          data: [
            { hash: 'hash-a', name: 'acme key', workspace_id: 'ws_a' },
            { hash: 'hash-b', name: 'beta key', workspace_id: 'ws_b' },
          ],
        },
      },
      probeRoute(true),
      { when: '/activity', and: ['api_key_hash=hash-a'], body: { data: [activityRow()] } },
      {
        when: '/activity',
        and: ['api_key_hash=hash-b'],
        body: { data: [activityRow({ usage: 0.02 })] },
      },
    ]);

    const result = await createOpenRouterProvider({
      keys: [
        { label: 'acme', secret: 'sk-or-v1-acme', declaredKind: 'management', labelled: true },
        { label: 'beta', secret: 'sk-or-v1-beta', declaredKind: 'management', labelled: true },
      ],
    }).collect({
      http,
      range: { since: '2026-07-01', until: '2026-07-26' },
      timeZone: 'UTC',
      concurrency: 2,
      now: NOW,
    });

    expect(result.records).toHaveLength(2);
    expect(result.records.map((record) => record.apiKey?.id).sort()).toEqual(['hash-a', 'hash-b']);
    expect(result.diagnostics.map((d) => d.code)).toContain('key-scope-overlap');
    // One activity call per distinct key hash, not per (key × credential).
    expect(fetch.calls.filter((url) => url.includes('/activity'))).toHaveLength(2);
  });

  it('names a workspace after the labelled key that is scoped to it', async () => {
    const { ctx } = context([
      keysRoute([{ hash: 'hash-a', name: 'acme key', workspace_id: 'ws_a' }]),
      probeRoute(true),
      { when: '/activity', body: { data: [activityRow()] } },
    ]);

    const result = await createOpenRouterProvider({
      keys: [
        { label: 'acme', secret: 'sk-or-v1-acme', declaredKind: 'management', labelled: true },
      ],
    }).collect(ctx);

    expect(result.records[0]?.workspace).toEqual({ id: 'ws_a', name: 'acme' });
    // A name this tool derived is never presented as one OpenRouter reported.
    expect(result.records[0]?.tags.workspaceNameSource).toBe('credential-label');
  });

  it('drops rows outside the requested window', async () => {
    const { ctx } = context(
      [
        probeRoute(false),
        {
          when: '/activity',
          body: {
            data: [
              activityRow({ date: '2026-06-01 00:00:00' }),
              activityRow({ date: '2026-07-25 00:00:00' }),
            ],
          },
        },
      ],
      { since: '2026-07-20', until: '2026-07-26' },
    );

    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect(ctx);
    expect(result.records.map((record) => record.bucketStart)).toEqual([
      '2026-07-25T00:00:00.000Z',
    ]);
  });

  it('warns when the window reaches past the 30-day lookback', async () => {
    const { ctx } = context([probeRoute(false), { when: '/activity', body: { data: [] } }], {
      since: '2026-01-01',
      until: '2026-07-26',
    });

    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect(ctx);
    expect(result.status).toBe('partial');
    expect(result.diagnostics.map((d) => d.code)).toContain('lookback-truncated');
  });

  it('warns that a non-UTC timezone cannot be honoured', async () => {
    const { http } = stubClient([probeRoute(false), { when: '/activity', body: { data: [] } }]);
    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect({
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
      probeRoute(false),
      {
        when: '/activity',
        body: { data: [activityRow({ usage: 0, byok_usage_inference: 0.012 })] },
      },
    ]);

    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect(ctx);
    expect(result.records[0]?.reportedCostMicros).toBe(0);
    expect(result.records[0]?.extras.byokCostMicros).toBe(12_000);
  });

  it('reports an auth failure as an error rather than empty usage', async () => {
    const { ctx } = context([{ when: '/v1/key', status: 401, body: { error: 'bad key' } }]);

    const result = await createOpenRouterProvider({ keys: [inferenceKey()] }).collect(ctx);
    expect(result.status).toBe('error');
    expect(result.capabilities.usage).toBe(false);
    expect(result.diagnostics.at(-1)?.code).toBe('auth-failed');
  });

  it('degrades to unsplit activity when the keys endpoint is refused', async () => {
    const { ctx } = context([
      { when: '/v1/keys', status: 403, body: { error: 'refused' } },
      probeRoute(true),
      { when: '/activity', body: { data: [activityRow()] } },
    ]);

    const result = await createOpenRouterProvider({ keys: [managementKey()] }).collect(ctx);

    expect(result.status).toBe('partial');
    expect(result.diagnostics.map((d) => d.code)).toContain('keys-unavailable');
    expect(result.records).toHaveLength(1);
  });
});
