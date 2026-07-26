import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CliEnvironment, run } from '../src/cli.js';

/**
 * The CLI is driven end to end with no credentials and `--offline`, so nothing
 * in this file touches the network: every provider is skipped and the pricing
 * loader reads an empty temp cache.
 */
async function environment(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'aiusage-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliEnvironment = {
    argv,
    env: { AIUSAGE_CACHE_DIR: cacheDir, NO_COLOR: '1', ...env },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: new Date('2026-07-26T12:00:00Z'),
    isTty: false,
  };
  return { cli, out, err };
}

let offline: string[];
beforeEach(() => {
  offline = ['--offline'];
});

describe('invocation errors', () => {
  it('rejects an unknown command with exit code 2', async () => {
    const { cli, err } = await environment(['sessions']);
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('Unknown command "sessions"');
  });

  it('rejects an unknown flag with exit code 2', async () => {
    const { cli, err } = await environment(['--nope']);
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('--nope');
  });

  it('rejects a malformed date', async () => {
    const { cli, err } = await environment(['--since', '2026-13-40']);
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('Invalid since');
  });

  it('rejects an inverted window', async () => {
    const { cli, err } = await environment(['--since', '20260726', '--until', '20260701']);
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('is after');
  });

  it('rejects --days combined with an explicit window', async () => {
    const { cli, err } = await environment(['--days', '7', '--since', '20260701']);
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('--days cannot be combined');
  });

  it('rejects an unknown provider and an unknown split', async () => {
    const provider = await environment(['--provider', 'bedrock']);
    expect(await run(provider.cli)).toBe(2);
    expect(provider.err.join('\n')).toContain('Unknown provider');

    const split = await environment(['--split', 'sessions']);
    expect(await run(split.cli)).toBe(2);
    expect(split.err.join('\n')).toContain('Unknown split');
  });

  it('rejects an unknown timezone', async () => {
    const { cli, err } = await environment(['--timezone', 'Mars/Olympus']);
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('Unknown timezone');
  });

  it('rejects a non-positive --days', async () => {
    const { cli, err } = await environment(['--days', '0']);
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('positive integer');
  });

  it('reports a bad environment value without touching the network', async () => {
    const { cli, err } = await environment([], { AIUSAGE_CONCURRENCY: 'lots' });
    expect(await run(cli)).toBe(2);
    expect(err.join('\n')).toContain('AIUSAGE_CONCURRENCY');
  });
});

describe('help and version', () => {
  it('prints usage for --help and exits 0', async () => {
    const { cli, out } = await environment(['--help']);
    expect(await run(cli)).toBe(0);
    expect(out.join('\n')).toContain('aiusage [daily] [options]');
    expect(out.join('\n')).toContain('OPENROUTER_MANAGEMENT_KEY');
  });

  it('prints the version for --version', async () => {
    const { cli, out } = await environment(['--version']);
    expect(await run(cli)).toBe(0);
    expect(out.join('\n')).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('no credentials configured', () => {
  it('reports every platform as skipped rather than reporting zero usage', async () => {
    const { cli, out } = await environment(['--json', ...offline]);
    expect(await run(cli)).toBe(0);

    const report = JSON.parse(out.join('\n'));
    expect(report.daily).toEqual([]);
    expect(report.totals.totalTokens).toBe(0);
    expect(
      report.meta.providers.map((provider: { id: string; status: string }) => [
        provider.id,
        provider.status,
      ]),
    ).toEqual([
      ['openrouter', 'skipped'],
      ['together', 'skipped'],
      ['openai', 'skipped'],
      ['anthropic', 'skipped'],
    ]);
    const notices = report.meta.notices.map((notice: { code: string }) => notice.code);
    expect(notices).toContain('not-configured');
    // "unknown, not zero" has to be said out loud somewhere.
    expect(JSON.stringify(report.meta.notices)).toContain('unknown, not zero');
  });

  it('explains itself in the table output too', async () => {
    const { cli, out } = await environment([...offline]);
    expect(await run(cli)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('No usage found between 2026-06-27 and 2026-07-26');
    expect(text).toContain('OpenRouter');
    expect(text).toContain('Together AI');
  });
});

describe('window selection', () => {
  it('defaults to the trailing 30 days', async () => {
    const { cli, out } = await environment(['--json', ...offline]);
    await run(cli);
    expect(JSON.parse(out.join('\n')).meta.range).toEqual({
      since: '2026-06-27',
      until: '2026-07-26',
    });
  });

  it('honours --days', async () => {
    const { cli, out } = await environment(['--json', '--days', '7', ...offline]);
    await run(cli);
    expect(JSON.parse(out.join('\n')).meta.range).toEqual({
      since: '2026-07-20',
      until: '2026-07-26',
    });
  });

  it('accepts both date spellings', async () => {
    const { cli, out } = await environment([
      '--json',
      '--since',
      '20260701',
      '--until',
      '2026-07-15',
      ...offline,
    ]);
    await run(cli);
    expect(JSON.parse(out.join('\n')).meta.range).toEqual({
      since: '2026-07-01',
      until: '2026-07-15',
    });
  });
});

describe('commands', () => {
  it('emits weekly and monthly under their own top-level key', async () => {
    for (const granularity of ['weekly', 'monthly'] as const) {
      const { cli, out } = await environment([granularity, '--json', ...offline]);
      expect(await run(cli)).toBe(0);
      const report = JSON.parse(out.join('\n'));
      expect(report[granularity]).toEqual([]);
      expect(report.meta.granularity).toBe(granularity);
    }
  });

  it('emits dimension reports for models, keys, accounts and workspaces', async () => {
    const expected = {
      models: 'model',
      keys: 'apiKey',
      accounts: 'account',
      workspaces: 'workspace',
    };
    for (const [command, dimension] of Object.entries(expected)) {
      const { cli, out } = await environment([command, '--json', ...offline]);
      expect(await run(cli)).toBe(0);
      const report = JSON.parse(out.join('\n'));
      expect(report.dimension).toBe(dimension);
      expect(report.rows).toEqual([]);
    }
  });

  it('shows the capability matrix for providers', async () => {
    const json = await environment(['providers', '--json', ...offline]);
    expect(await run(json.cli)).toBe(0);
    const report = JSON.parse(json.out.join('\n'));
    expect(report.providers).toHaveLength(4);

    const table = await environment(['providers', ...offline]);
    await run(table.cli);
    const text = table.out.join('\n');
    expect(text).toContain('Provider');
    expect(text).toContain('Lookback');
  });

  it('tells the user how to price a model when there is no usage to price', async () => {
    const { cli, err } = await environment(['pricing', ...offline]);
    expect(await run(cli)).toBe(0);
    expect(err.join('\n')).toContain('--model');
  });

  it('refuses to price when cost is switched off', async () => {
    const { cli, err } = await environment([
      'pricing',
      '--no-cost',
      '--model',
      'claude-opus-4-6',
      '--provider',
      'anthropic',
      ...offline,
    ]);
    expect(await run(cli)).toBe(0);
    expect(err.join('\n')).toContain('--no-cost disables pricing');
  });
});

describe('cost flags', () => {
  it('drops cost from the payload with --no-cost', async () => {
    const { cli, out } = await environment(['--json', '--no-cost', ...offline]);
    await run(cli);
    const report = JSON.parse(out.join('\n'));
    expect(report.totals).not.toHaveProperty('totalCost');
    expect(report.meta.costIncluded).toBe(false);
  });

  it('warns that --offline cannot price without a cache', async () => {
    const { cli, out } = await environment(['--json', ...offline]);
    await run(cli);
    const codes = JSON.parse(out.join('\n')).meta.notices.map(
      (notice: { code: string }) => notice.code,
    );
    expect(codes).toContain('pricing-offline-miss');
  });
});

describe('splits', () => {
  it('accepts a comma-separated list and a repeated flag alike', async () => {
    const comma = await environment(['--json', '--split', 'model,apiKey', ...offline]);
    await run(comma.cli);
    const repeated = await environment([
      '--json',
      '--split',
      'model',
      '--split',
      'apiKey',
      ...offline,
    ]);
    await run(repeated.cli);
    expect(JSON.parse(comma.out.join('\n')).daily).toEqual(
      JSON.parse(repeated.out.join('\n')).daily,
    );
  });

  it('restricts the run to the requested providers', async () => {
    const { cli, out } = await environment([
      '--json',
      '--provider',
      'openai,anthropic',
      ...offline,
    ]);
    await run(cli);
    expect(
      JSON.parse(out.join('\n')).meta.providers.map((provider: { id: string }) => provider.id),
    ).toEqual(['openai', 'anthropic']);
  });
});
