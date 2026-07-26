import { describe, expect, it } from 'vitest';
import { renderReportHtml, renderReportSvg } from '../src/chart.js';
import type { DimensionBreakdown, PeriodReport, ReportRow } from '../src/report.js';

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

function row(period: string, costs: Record<string, number>): ReportRow {
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
    modelBreakdowns: [],
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
    // 2 periods × 2 series, and the two panel baselines are lines, not rects.
    expect(svg.match(/<rect/g)?.length).toBe(1 + 4);
    expect(svg.match(/<path/g)?.length).toBe(2);
    // Direct end labels are the secondary encoding for the cumulative panel.
    expect(svg).toContain('anthropic  $7.00');
    expect(svg).toContain('openrouter  $3.00');
  });

  it('carries its own provenance so the figure cannot be over-read alone', () => {
    const svg = renderReportSvg(
      report([row('2026-07-25', { anthropic: 2 })], {
        providers: [
          {
            id: 'together',
            label: 'Together AI',
            status: 'unsupported',
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
    expect(svg).toContain('Together AI (unsupported)');
    expect(svg).toContain('unknown, not zero');
    expect(svg).toContain('$1.50 of billed cost is not token consumption');
    expect(svg).toContain('litellm@2026-07-26');
  });

  it('plots tokens and says so when cost was not collected', () => {
    const svg = renderReportSvg(report([row('2026-07-25', { anthropic: 0 })]), {
      series: 'provider',
      includeCost: false,
    });
    expect(svg).toContain('LLM token usage by provider');
    expect(svg).toContain('Daily tokens');
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
    expect(html).toContain('<td style="text-align:left">2026-07-25</td>');
    expect(html).toContain('some-model');
  });
});
