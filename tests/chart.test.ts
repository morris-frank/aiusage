import { describe, expect, it } from 'vitest';
import { renderReportHtml, renderReportSvg } from '../src/chart/index.js';
import type { DimensionBreakdown, ModelBreakdown, PeriodReport, ReportRow } from '../src/report.js';

function breakdown(name: string, cost: number, tokens = 1000): DimensionBreakdown {
  return {
    id: name,
    name,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: tokens,
    cost,
    costSource: 'reported',
    providers: [name],
    models: [],
    agents: [name],
    requests: null,
  };
}

function modelBreakdown(
  modelName: string,
  provider: string,
  cost: number,
  tokens = 1000,
  agents: string[] = [provider],
): ModelBreakdown {
  return {
    modelName,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost,
    costSource: 'reported',
    provider,
    agents,
    requests: null,
  };
}

function row(
  period: string,
  costs: Record<string, number>,
  models: ModelBreakdown[] = [],
): ReportRow {
  const total = Object.values(costs).reduce((sum, one) => sum + one, 0);
  return {
    agent: 'all',
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 1000,
    metadata: {
      agents: Object.keys(costs),
      providers: Object.keys(costs),
      costSource: 'reported',
      requests: null,
      reasoningTokens: 0,
    },
    modelBreakdowns: models,
    modelsUsed: ['some-model'],
    outputTokens: 0,
    period,
    totalCost: total,
    totalTokens: 1000,
    providerBreakdowns: Object.entries(costs).map(([name, cost]) => breakdown(name, cost)),
  };
}

function report(rows: ReportRow[], overrides: Partial<PeriodReport['meta']> = {}): PeriodReport {
  return {
    daily: rows,
    totals: {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: rows.length * 1000,
      outputTokens: 0,
      totalCost: rows.reduce((sum, one) => sum + (one.totalCost ?? 0), 0),
      totalTokens: rows.length * 1000,
      requests: null,
      costSource: 'reported',
    },
    meta: {
      tool: 'aiusage',
      version: '0.1.0',
      generatedAt: '2026-07-26T12:00:00.000Z',
      granularity: 'daily',
      range: { since: '2026-07-24', until: '2026-07-25' },
      timezone: 'UTC',
      costIncluded: true,
      priceSources: ['litellm@2026-07-26'],
      providers: [],
      unattributedCost: [],
      notices: [],
      ...overrides,
    },
  };
}

const OPTIONS = { series: 'provider' as const, includeCost: true };

/** Cache-read: the lightest stop of the sequential ramp the mix panel uses. */
const TOKEN_CLASS_COLOUR = '#CFE3A3';

/** A panel's own markup, so an assertion cannot accidentally match another panel. */
function panel(svg: string, id: string): string {
  const found = new RegExp(`<g data-panel="${id}">([\\s\\S]*?)</g>`).exec(svg);
  return found?.[1] ?? '';
}

describe('report figure', () => {
  it('draws one stacked segment per series per period, plus a cumulative line each', () => {
    const svg = renderReportSvg(
      report([
        row('2026-07-24', { openrouter: 1, anthropic: 3 }),
        row('2026-07-25', { openrouter: 2, anthropic: 4 }),
      ]),
      OPTIONS,
    );

    expect(svg.startsWith('<svg')).toBe(true);
    // 2 periods × 2 series in the stacked cost panel.
    expect(panel(svg, 'cost-daily').match(/<rect/g)?.length).toBe(4);
    // One line per series; the vendor marks in the end labels are paths too, so
    // the line width is what distinguishes them.
    expect(panel(svg, 'cost-cumulative').match(/stroke-width="1.6"/g)?.length).toBe(2);
    // Direct end labels are the secondary encoding for the cumulative panel.
    expect(svg).toContain('anthropic  $7.00');
    expect(svg).toContain('openrouter  $3.00');
  });

  it('plots tokens alongside cost, and the token mix as shares', () => {
    const svg = renderReportSvg(
      report([
        row('2026-07-24', { openrouter: 1, anthropic: 3 }),
        row('2026-07-25', { openrouter: 2, anthropic: 4 }),
      ]),
      OPTIONS,
    );

    // Cost and tokens are different questions, so they get their own panels.
    expect(svg).toContain('data-panel="tokens-daily"');
    expect(svg).toContain('>Daily tokens<');
    expect(panel(svg, 'tokens-daily').match(/<rect/g)?.length).toBe(4);

    // The mix panel is normalised: absolute tokens are already above it.
    const mix = panel(svg, 'token-mix');
    expect(svg).toContain('>Token mix<');
    expect(mix).toContain('>100%<');
    expect(mix).toContain(TOKEN_CLASS_COLOUR);
  });

  it('drops the cost panels rather than faking them when cost was not collected', () => {
    const svg = renderReportSvg(report([row('2026-07-25', { anthropic: 0 })]), {
      series: 'provider',
      includeCost: false,
    });
    expect(svg).not.toContain('data-panel="cost-daily"');
    expect(svg).toContain('data-panel="tokens-daily"');
    expect(svg).toContain('data-panel="tokens-cumulative"');
    expect(svg).toContain('data-panel="token-mix"');
  });

  it('marks each series with a vendor glyph, and stays neutral when the name says nothing', () => {
    const svg = renderReportSvg(
      report([row('2026-07-25', { anthropic: 3, 'some-key-7f2': 1 })]),
      OPTIONS,
    );
    // Anthropic's mark is an SVG path; an unidentifiable series gets the ring,
    // rather than a mark that would claim a vendor the name does not name.
    expect(svg).toMatch(/<path d="M/);
    expect(svg).toMatch(/<circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+" fill="none"/);
  });

  it('carries its own provenance so the figure cannot be over-read alone', () => {
    const svg = renderReportSvg(
      report([row('2026-07-25', { anthropic: 2 })], {
        providers: [
          {
            id: 'openrouter',
            label: 'OpenRouter',
            status: 'error',
            capabilities: {
              usage: false,
              reportedCost: false,
              splitByModel: false,
              splitByApiKey: false,
              splitByAccount: false,
              splitByWorkspace: false,
              livePricing: true,
              maxLookbackDays: null,
            },
            identity: null,
            recordCount: 0,
            costSource: 'unavailable',
          },
        ],
        unattributedCost: [
          {
            provider: 'anthropic',
            cost: 1.5,
            description: 'Web search',
            reason: 'not-allocatable',
          },
        ],
      }),
      OPTIONS,
    );

    expect(svg).toContain('Cost provenance: reported');
    expect(svg).toContain('OpenRouter (error)');
    expect(svg).toContain('unknown, not zero');
    expect(svg).toContain('$1.50 of billed cost is not token consumption');
    expect(svg).toContain('litellm@2026-07-26');
  });

  it('says in the caption when cost was not collected', () => {
    const svg = renderReportSvg(report([row('2026-07-25', { anthropic: 0 })]), {
      series: 'provider',
      includeCost: false,
    });
    expect(svg).toContain('LLM token usage by provider');
    expect(svg).toContain('--no-cost');
  });

  it('renders an empty window without dividing by zero', () => {
    const svg = renderReportSvg(report([]), OPTIONS);
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('no series could be drawn');
  });

  it('escapes series names into the SVG', () => {
    const svg = renderReportSvg(report([row('2026-07-25', { 'a & <b>': 5 })]), OPTIONS);
    expect(svg).toContain('a &amp; &lt;b&gt;');
    expect(svg).not.toContain('<b>');
  });

  it('wraps the figure in a printable white page with the period table', () => {
    const html = renderReportHtml(report([row('2026-07-25', { anthropic: 2 })]), OPTIONS);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<svg');
    // Reports are white surfaces in this visual language; bone prints muddy.
    expect(html).toContain('background: #fff');
    expect(html).toContain('class="left period">2026-07-25<');
    expect(html).toContain('some-model');
    expect(html).toContain('<figcaption>');
    expect(html).toContain('<caption>One row per day with usage.');
    expect(html).toContain('<th scope="col"');
  });

  it('gives the table the shape of its numbers, and a provenance badge per row', () => {
    const html = renderReportHtml(
      report([row('2026-07-24', { anthropic: 1 }), row('2026-07-25', { anthropic: 3 })]),
      OPTIONS,
    );
    // A cost bar proportional to the largest row, so the table reads at a glance.
    expect(html).toContain('class="bar" style="width:100.0%"');
    expect(html).toContain('class="bar" style="width:33.3%"');
    // The four-segment token mix
    expect(html).toContain('class="mix"');
    // Vendor marks travel with the row, and models are chips rather than prose.
    expect(html).toContain('class="marks"');
    expect(html).toContain('class="chip">some-model<');
  });

  it('lists every source with what it actually answered', () => {
    const html = renderReportHtml(
      report([row('2026-07-25', { anthropic: 2 })], {
        providers: [
          {
            id: 'openrouter',
            label: 'OpenRouter',
            status: 'partial',
            capabilities: {
              usage: true,
              reportedCost: true,
              splitByModel: false,
              splitByApiKey: false,
              splitByAccount: false,
              splitByWorkspace: false,
              livePricing: true,
              maxLookbackDays: 30,
            },
            identity: null,
            recordCount: 0,
            costSource: 'unavailable',
          },
        ],
      }),
      OPTIONS,
    );
    expect(html).toContain('OpenRouter');
    expect(html).toContain('class="badge partial"');
    expect(html).toContain('no splits');
    expect(html).toContain('unknown, not zero');
  });

  it('keeps skipped sources and diagnostics visible because absent is not zero', () => {
    const html = renderReportHtml(
      report([row('2026-07-25', { anthropic: 2 })], {
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            status: 'skipped',
            capabilities: {
              usage: false,
              reportedCost: false,
              splitByModel: false,
              splitByApiKey: false,
              splitByAccount: false,
              splitByWorkspace: false,
              livePricing: false,
              maxLookbackDays: null,
            },
            identity: null,
            recordCount: 0,
            costSource: 'unavailable',
          },
        ],
        notices: [
          {
            provider: 'openai',
            level: 'info',
            code: 'not-configured',
            message: 'OpenAI is not configured — usage is unknown, not zero.',
          },
        ],
      }),
      OPTIONS,
    );

    expect(html).toContain('OpenAI');
    expect(html).toContain('class="badge skipped"');
    expect(html).toContain('<h2>Notices</h2>');
    expect(html).toContain('not-configured');
  });

  it('describes the SVG and its provenance for screen-reader users', () => {
    const svg = renderReportSvg(report([row('2026-07-25', { anthropic: 2 })]), OPTIONS);
    expect(svg).toContain('aria-labelledby="aiusage-chart-title aiusage-chart-desc"');
    expect(svg).toContain('<desc id="aiusage-chart-desc">');
    expect(svg).toContain('Cost provenance and incomplete-source status');
  });

  it('ranks models by cost, coloured by provider rather than by model', () => {
    const svg = renderReportSvg(
      report([
        row('2026-07-25', { openrouter: 3, openai: 1 }, [
          modelBreakdown('minimax/minimax-m3', 'openrouter', 2),
          modelBreakdown('gpt-4o-mini-2024-07-18', 'openai', 1),
        ]),
      ]),
      OPTIONS,
    );

    // The vendor marks' own nested <g> groups make the naive `panel()` helper
    // stop early, so assert against the full document instead.
    expect(svg).toContain('data-panel="model-rank"');
    expect(svg).toContain('minimax/minimax-m3');
    expect(svg).toContain('gpt-4o-mini-2024-07-18');
  });

  it('does not draw a ranking panel for zero or one model — there is nothing to rank', () => {
    const svg = renderReportSvg(
      report([
        row('2026-07-25', { openrouter: 1 }, [modelBreakdown('solo-model', 'openrouter', 1)]),
      ]),
      OPTIONS,
    );
    expect(svg).not.toContain('data-panel="model-rank"');
  });

  it('folds the tail beyond the top models into a disclosed "Other" row, never a silent cut', () => {
    const models = Array.from({ length: 10 }, (_unused, index) =>
      modelBreakdown(`model-${index}`, 'openrouter', 10 - index),
    );
    const svg = renderReportSvg(report([row('2026-07-25', { openrouter: 55 }, models)]), OPTIONS);

    expect(svg).toContain('Other 2 models');
    expect(svg).toContain('groups the 2 lowest-total models as &quot;Other 2 models&quot;');
  });

  it('marks a model run under more than one agent with the neutral ring, not either colour', () => {
    const svg = renderReportSvg(
      report([
        row('2026-07-25', { openrouter: 2, anthropic: 1 }, [
          modelBreakdown('anthropic/claude-haiku-4.5', 'openrouter', 2),
          modelBreakdown('anthropic/claude-haiku-4.5', 'anthropic', 1),
          modelBreakdown('gpt-4o-mini-2024-07-18', 'openai', 1),
        ]),
      ]),
      OPTIONS,
    );

    expect(svg).toContain('anthropic/claude-haiku-4.5 †');
    expect(svg).toContain('run under more than one agent');
    expect(svg).toContain('anthropic/claude-haiku-4.5 was run');
  });
});
