import { describe, expect, it } from 'vitest';
import { createTogetherProvider } from '../../src/providers/together.js';
import type { CollectContext } from '../../src/providers/types.js';
import { type StubRoute, stubClient } from '../helpers/http.js';

const NOW = new Date('2026-07-26T12:00:00Z');

function context(routes: StubRoute[]) {
  const { http, fetch } = stubClient(routes);
  const ctx: CollectContext = {
    http,
    range: { since: '2026-07-01', until: '2026-07-26' },
    timeZone: 'UTC',
    concurrency: 2,
    now: NOW,
  };
  return { ctx, fetch };
}

describe('Together provider', () => {
  it('reports usage as unsupported and never as zero', async () => {
    const { ctx } = context([
      {
        when: '/whoami',
        body: {
          api_key_id: 'key_1',
          project_id: 'proj_1',
          project_name: 'Trials',
          organization_id: 'org_1',
          organization_name: 'Soilytix',
          user_id: 'user_1',
        },
      },
    ]);

    const result = await createTogetherProvider({ apiKey: 'together-key' }).collect(ctx);

    expect(result.status).toBe('unsupported');
    expect(result.records).toEqual([]);
    expect(result.costRecords).toEqual([]);
    expect(result.capabilities.usage).toBe(false);
    // Pricing is the part Together *can* answer.
    expect(result.capabilities.livePricing).toBe(true);
    expect(result.identity).toEqual({
      organizationId: 'org_1',
      organizationName: 'Soilytix',
      projectId: 'proj_1',
      projectName: 'Trials',
      apiKeyId: 'key_1',
      userId: 'user_1',
    });

    const notice = result.diagnostics.find((d) => d.code === 'usage-api-unavailable');
    expect(notice?.level).toBe('warning');
    expect(notice?.message).toContain('no usage or cost API');
  });

  it('surfaces a rejected key as an error', async () => {
    const { ctx } = context([{ when: '/whoami', status: 401, body: { error: 'Missing API key' } }]);

    const result = await createTogetherProvider({ apiKey: 'bad' }).collect(ctx);
    expect(result.status).toBe('error');
    expect(result.capabilities.livePricing).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('auth-failed');
  });
});
