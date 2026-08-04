import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/providers/ccusage.js';
import { createCcusageProvider, localOverlapDiagnostic } from '../../src/providers/ccusage.js';
import type { CollectContext } from '../../src/providers/types.js';
import { stubClient } from '../helpers/http.js';

const NOW = new Date('2026-07-26T12:00:00Z');

function context(timeZone = 'UTC', range = { since: '2026-07-24', until: '2026-07-26' }) {
  const { http } = stubClient([]);
  const ctx: CollectContext = {
    http,
    range,
    timeZone,
    hourlyBuckets: false,
    concurrency: 2,
    now: NOW,
  };
  return ctx;
}

const PAYLOAD = {
  daily: [
    {
      period: '2026-07-25',
      agent: 'all',
      agents: [
        {
          agent: 'claude',
          modelBreakdowns: [
            {
              modelName: 'claude-opus-5',
              inputTokens: 100,
              outputTokens: 2000,
              cacheCreationTokens: 5000,
              cacheReadTokens: 90_000,
              cost: 3.5,
            },
          ],
        },
        {
          agent: 'codex',
          modelBreakdowns: [
            {
              modelName: 'gpt-5.6-terra',
              inputTokens: 4000,
              outputTokens: 500,
              cacheCreationTokens: 0,
              cacheReadTokens: 20_000,
              cost: 1.25,
            },
          ],
        },
      ],
      metadata: { agents: ['claude', 'codex'] },
    },
  ],
};

function runner(
  payload: unknown,
  record?: { command: string; args: readonly string[] }[],
): CommandRunner {
  return async (command, args) => {
    record?.push({ command, args });
    return { code: 0, stdout: JSON.stringify(payload), stderr: '' };
  };
}

const CONFIG = { command: null, offline: false, timeoutMs: 1000 };

describe('local agent source (ccusage)', () => {
  it('records one row per agent and model, attributed to the agent', async () => {
    const provider = createCcusageProvider(CONFIG, runner(PAYLOAD));
    const result = await provider.collect(context());

    expect(result.status).toBe('ok');
    expect(result.records).toHaveLength(2);
    expect(result.records.map((record) => [record.tags.agent, record.model])).toEqual([
      ['claude', 'claude-opus-5'],
      ['codex', 'gpt-5.6-terra'],
    ]);
    expect(result.identity?.agents).toBe('claude,codex');
  });

  it('labels its cost `imported`, never as a platform-reported amount', async () => {
    const provider = createCcusageProvider(CONFIG, runner(PAYLOAD));
    const result = await provider.collect(context());

    expect(result.records[0]?.reportedCostMicros).toBe(3_500_000);
    // The distinction that matters: ccusage calculated this, no platform billed it.
    expect(result.records[0]?.costBasis).toBe('imported');
    expect(result.capabilities.reportedCost).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('cost-imported');
  });

  it('asks ccusage for the window and timezone the report is being built in', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const provider = createCcusageProvider(CONFIG, runner(PAYLOAD, calls));
    await provider.collect(context('Europe/Berlin', { since: '2026-07-01', until: '2026-07-26' }));

    expect(calls[0]?.command).toBe('ccusage');
    expect(calls[0]?.args).toEqual([
      'daily',
      '--json',
      '--by-agent',
      '--since',
      '2026-07-01',
      '--until',
      '2026-07-26',
      '-z',
      'Europe/Berlin',
    ]);
  });

  it('treats a ccusage date as a local day, not as UTC midnight', async () => {
    const provider = createCcusageProvider(CONFIG, runner(PAYLOAD));
    // 2026-07-25 in New York starts at 04:00Z; grouping the row by UTC midnight
    // would file a whole day of local usage under the day before.
    const result = await provider.collect(
      context('America/New_York', { since: '2026-07-24', until: '2026-07-26' }),
    );
    expect(result.records[0]?.bucketStart).toBe('2026-07-25T04:00:00.000Z');
    expect(result.records[0]?.bucketEnd).toBe('2026-07-26T04:00:00.000Z');
  });

  it('records models unattributed when ccusage reports no per-agent rows', async () => {
    const provider = createCcusageProvider(
      CONFIG,
      runner({
        daily: [
          {
            period: '2026-07-25',
            modelBreakdowns: [{ modelName: 'claude-opus-5', inputTokens: 10, cost: 0.5 }],
            metadata: { agents: ['claude'] },
          },
        ],
      }),
    );
    const result = await provider.collect(context());
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.tags.agent).toBeUndefined();
    expect(result.identity?.agents).toBe('claude');
  });

  it('reports an unavailable ccusage as an error rather than as no local usage', async () => {
    const missing: CommandRunner = async () => {
      const error = new Error('spawn ccusage ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    };
    const result = await createCcusageProvider(
      { command: ['ccusage'], offline: false, timeoutMs: 1000 },
      missing,
    ).collect(context());

    expect(result.status).toBe('error');
    expect(result.records).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('local-tool-unavailable');
    expect(result.diagnostics[0]?.message).toContain('ENOENT');
  });

  it('falls back to the next invocation when the first is not installed', async () => {
    const calls: string[] = [];
    const runFallback: CommandRunner = async (command) => {
      calls.push(command);
      if (command === 'ccusage') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return { code: 0, stdout: JSON.stringify(PAYLOAD), stderr: '' };
    };
    const result = await createCcusageProvider(CONFIG, runFallback).collect(context());
    expect(calls).toEqual(['ccusage', 'npx']);
    expect(result.status).toBe('ok');
  });

  it('never reaches for npx when offline', async () => {
    const calls: string[] = [];
    const runOffline: CommandRunner = async (command) => {
      calls.push(command);
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    };
    const result = await createCcusageProvider(
      { command: null, offline: true, timeoutMs: 1000 },
      runOffline,
    ).collect(context());
    expect(calls).toEqual(['ccusage']);
    expect(result.status).toBe('error');
  });

  it('rejects output that is not a ccusage payload', async () => {
    const result = await createCcusageProvider(
      { command: ['ccusage'], offline: false, timeoutMs: 1000 },
      runner({ error: 'unsupported flag' }),
    ).collect(context());
    expect(result.status).toBe('error');
    expect(result.diagnostics[0]?.message).toContain('not ccusage JSON');
  });

  it('never claims hourly buckets: `daily` rows are whole local days', async () => {
    const result = await createCcusageProvider(
      { command: ['ccusage'], offline: false, timeoutMs: 1000 },
      runner(PAYLOAD),
    ).collect({ ...context(), hourlyBuckets: true });

    expect(result.status).toBe('ok');
    expect(result.capabilities.hourly).toBe(false);
    // The bucket a day's rows carry is a full local day, which is precisely why
    // the time-of-day statistic must exclude them.
    const [record] = result.records;
    expect(Date.parse(record?.bucketEnd ?? '') - Date.parse(record?.bucketStart ?? '')).toBe(
      86_400_000,
    );
  });

  it('says out loud that local and platform rows can be the same traffic', () => {
    const diagnostic = localOverlapDiagnostic(['Claude Platform']);
    expect(diagnostic.level).toBe('warning');
    expect(diagnostic.code).toBe('local-overlap-possible');
    expect(diagnostic.message).toContain('counted twice');
  });
});
