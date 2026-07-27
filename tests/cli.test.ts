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
async function environment(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
  overrides: Partial<CliEnvironment> = {},
) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'aiusage-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const written: { path: string; content: string }[] = [];
  const cli: CliEnvironment = {
    argv,
    env: { AIUSAGE_CACHE_DIR: cacheDir, NO_COLOR: '1', ...env },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: new Date('2026-07-26T12:00:00Z'),
    isTty: false,
    homeDir: '/home/tester',
    writeFile: (path, content) => written.push({ path, content }),
    ...overrides,
  };
  return { cli, out, err, written };
}

/** A ccusage that never runs: its JSON is handed straight back. */
function ccusageRunner(payload: unknown): NonNullable<CliEnvironment['runCommand']> {
  return async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
}

const CCUSAGE_PAYLOAD = {
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
      ['ccusage', 'skipped'],
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

  it('defaults report to a 90-day window, not the usual 30', async () => {
    const { cli, out } = await environment(['report', '--json', '--no-local', ...offline]);
    await run(cli);
    expect(JSON.parse(out.join('\n')).meta.range).toEqual({
      since: '2026-04-28',
      until: '2026-07-26',
    });
  });

  it('still honours an explicit --days for report, over the 90-day default', async () => {
    const { cli, out } = await environment([
      'report',
      '--json',
      '--no-local',
      '--days',
      '7',
      ...offline,
    ]);
    await run(cli);
    expect(JSON.parse(out.join('\n')).meta.range).toEqual({
      since: '2026-07-20',
      until: '2026-07-26',
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
    expect(report.providers).toHaveLength(5);

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

describe('the local source and the figure', () => {
  it('fuses local agent usage into the report only when asked', async () => {
    const without = await environment(['--json', ...offline]);
    await run(without.cli);
    const skipped = JSON.parse(without.out.join('\n'));
    expect(skipped.daily).toEqual([]);
    expect(JSON.stringify(skipped.meta.notices)).toContain('pass --local');

    const { cli, out } = await environment(
      ['--json', '--local', ...offline],
      {},
      {
        runCommand: ccusageRunner(CCUSAGE_PAYLOAD),
      },
    );
    expect(await run(cli)).toBe(0);
    const report = JSON.parse(out.join('\n'));

    expect(report.daily).toHaveLength(1);
    expect(report.daily[0].period).toBe('2026-07-25');
    expect(report.totals.totalCost).toBeCloseTo(4.75, 6);
    // ccusage calculated this cost, so the report says `imported`, not `reported`.
    expect(report.totals.costSource).toBe('imported');
    expect(report.daily[0].metadata.agents).toEqual(['claude', 'codex']);
  });

  it('groups local usage by agent', async () => {
    const { cli, out } = await environment(
      ['agents', '--json', '--local', ...offline],
      {},
      {
        runCommand: ccusageRunner(CCUSAGE_PAYLOAD),
      },
    );
    expect(await run(cli)).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.dimension).toBe('agent');
    expect(report.rows.map((row: { id: string; cost: number }) => [row.id, row.cost])).toEqual([
      ['claude', 3.5],
      ['codex', 1.25],
    ]);
  });

  it('writes the figure to a file, with the series it was asked for', async () => {
    const { cli, err, written } = await environment(
      ['report', '--local', '--split', 'agent', '--out', 'figure.svg', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    expect(err.join('\n')).toContain('Wrote figure.svg');
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe('figure.svg');
    expect(written[0]?.content.startsWith('<svg')).toBe(true);
    expect(written[0]?.content).toContain('LLM spend by agent');
    expect(written[0]?.content).toContain('claude');
  });

  it('does not render an empty figure when --split model is the only split requested', async () => {
    // The figure never stacks by model (see chart/figure.ts) and falls back to
    // agent — which only has data to draw if 'agent' actually made it into
    // the requested splits. An explicit `--split model` alone used to leave
    // that fallback empty.
    const { cli, out } = await environment(
      ['report', '--local', '--split', 'model', '--print', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    const svg = out.join('\n');
    expect(svg).toContain('<rect');
    expect(svg.match(/<rect/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it('defaults the report figure to agent, never the literal ccusage id as a data label', async () => {
    const { cli, out } = await environment(
      ['report', '--local', '--print', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    const svg = out.join('\n');
    expect(svg).toContain('LLM spend by agent');
    expect(svg).toContain('claude');
    expect(svg).toContain('codex');
    // "ccusage" still legitimately names the tool in the caption's provenance
    // prose ("...restated from ccusage's own calculation..."); it must not
    // appear as its own legend/chart data label (an isolated text node).
    expect(svg).not.toMatch(/>ccusage</);
  });

  it('emits the figure on stdout, as HTML when asked', async () => {
    // --print is the escape hatch: without it, --local defaults to a file.
    const { cli, out } = await environment(
      ['report', '--local', '--format', 'html', '--print', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    expect(out.join('\n').startsWith('<!doctype html>')).toBe(true);
  });

  it('emits the figure on stdout by default when --no-local opts out of local fusion', async () => {
    const { cli, out } = await environment([
      'report',
      '--format',
      'html',
      '--no-local',
      ...offline,
    ]);
    expect(await run(cli)).toBe(0);
    expect(out.join('\n').startsWith('<!doctype html>')).toBe(true);
  });

  it('implies --local for report, with a 90-day default window', async () => {
    const { cli, out, err, written } = await environment(
      ['report', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    expect(out).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(
      '/home/tester/Downloads/aiusage-report-2026-04-28-to-2026-07-26.html',
    );
    expect(written[0]?.content.startsWith('<!doctype html>')).toBe(true);
    expect(err.join('\n')).toContain('Wrote /home/tester/Downloads/');
  });

  it('--no-local drops local fusion for report even though it is the default', async () => {
    const { cli, out } = await environment(['report', '--no-local', '--print', ...offline]);
    expect(await run(cli)).toBe(0);
    // No runCommand injected: if --no-local did not work, this would try to
    // spawn a real ccusage process and fail the run.
    expect(out.join('\n').startsWith('<svg')).toBe(true);
  });

  it('honours an explicit --format svg for the --local default file', async () => {
    const { cli, written } = await environment(
      ['report', '--local', '--format', 'svg', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    expect(written[0]?.path.endsWith('.svg')).toBe(true);
    expect(written[0]?.content.startsWith('<svg')).toBe(true);
  });

  it('--print overrides the --local default and goes back to stdout', async () => {
    const { cli, out, written } = await environment(
      ['report', '--local', '--print', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    expect(written).toHaveLength(0);
    expect(out.join('\n').startsWith('<svg')).toBe(true);
  });

  it('an explicit --out still wins over the --local default', async () => {
    const { cli, written } = await environment(
      ['report', '--local', '--out', 'figure.svg', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    expect(written[0]?.path).toBe('figure.svg');
  });

  it('--json with --local still goes to stdout, not the ~/Downloads default', async () => {
    const { cli, out, written } = await environment(
      ['report', '--local', '--json', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    expect(written).toHaveLength(0);
    expect(() => JSON.parse(out.join('\n'))).not.toThrow();
  });

  it('still emits the numbers behind the figure with --json, split by agent not the literal ccusage id', async () => {
    const { cli, out } = await environment(
      ['report', '--local', '--json', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(cli)).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.daily[0].agentBreakdowns.map((row: { id: string }) => row.id)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('takes a report grain from --granularity, and nowhere else', async () => {
    const good = await environment(
      ['report', '--granularity', 'monthly', '--json', '--local', ...offline],
      {},
      { runCommand: ccusageRunner(CCUSAGE_PAYLOAD) },
    );
    expect(await run(good.cli)).toBe(0);
    expect(JSON.parse(good.out.join('\n')).monthly[0].period).toBe('2026-07');

    const bad = await environment(['daily', '--granularity', 'monthly']);
    expect(await run(bad.cli)).toBe(2);
    expect(bad.err.join('\n')).toContain('--granularity only applies');
  });

  it('reports a missing ccusage as an error exit, not as no local usage', async () => {
    const { cli, out } = await environment(
      ['--json', '--local', ...offline],
      {},
      {
        runCommand: async () => {
          throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        },
      },
    );
    expect(await run(cli)).toBe(1);
    const report = JSON.parse(out.join('\n'));
    expect(report.meta.notices.map((notice: { code: string }) => notice.code)).toContain(
      'local-tool-unavailable',
    );
  });
});
