import { describe, expect, it } from 'vitest';
import { renderReportHtml, renderReportSvg } from '../src/chart/index.js';
import type { DimensionBreakdown, ModelBreakdown, PeriodReport, ReportRow } from '../src/report.js';
import type { TimeOfDayStatistics } from '../src/statistics.js';

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

function report(
  rows: ReportRow[],
  overrides: Partial<PeriodReport['meta']> = {},
  statistics: Partial<PeriodReport['statistics']> = {},
): PeriodReport {
  return {
    daily: rows,
    // No time-of-day statistic by default: these fixtures are daily buckets, and
    // that is exactly the case where the hour panels must not appear.
    statistics: { timeOfDay: null, concentration: null, diagnostics: [], ...statistics },
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
              hourly: false,
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
              hourly: false,
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
              hourly: false,
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

  it('never overprints two dates at the right edge of the axis', () => {
    // 30 periods → a stride of 4, so the stride's last label lands on index 28.
    // Labelling index 29 as well would smear two dates on top of each other.
    const rows = Array.from({ length: 30 }, (_unused, index) =>
      row(`2026-07-${String(index + 1).padStart(2, '0')}`, { anthropic: 1 }),
    );
    const labels = panel(renderReportSvg(report(rows), OPTIONS), 'cost-daily').match(
      />2026-07-\d\d</g,
    );

    expect(labels).toEqual([
      '>2026-07-01<',
      '>2026-07-05<',
      '>2026-07-09<',
      '>2026-07-13<',
      '>2026-07-17<',
      '>2026-07-21<',
      '>2026-07-25<',
      '>2026-07-29<',
    ]);
  });

  it('still labels the final period when the stride leaves room for it', () => {
    // 9 periods → a stride of 2, so index 8 is both the stride's mark and the
    // last period: the window's end stays labelled.
    const rows = Array.from({ length: 9 }, (_unused, index) =>
      row(`2026-07-0${index + 1}`, { anthropic: 1 }),
    );
    const labels = panel(renderReportSvg(report(rows), OPTIONS), 'cost-daily').match(
      />2026-07-\d\d</g,
    );
    expect(labels?.at(-1)).toBe('>2026-07-09<');
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

/** A time-of-day statistic with `cost` concentrated in the hours given. */
function timeOfDay(byHour: Record<number, number>, overrides: Partial<TimeOfDayStatistics> = {}) {
  const hours = Array.from({ length: 24 }, (_unused, hour) => ({
    hour,
    cost: byHour[hour] ?? null,
    tokens: (byHour[hour] ?? 0) * 1000,
    requests: null,
    activeDays: byHour[hour] === undefined ? 0 : 1,
  }));
  const entries = Object.entries(byHour);
  const peak = entries.sort(([, a], [, b]) => b - a)[0];
  return {
    hours,
    week: entries.map(([hour], index) => ({
      weekday: index + 1,
      hour: Number(hour),
      cost: byHour[Number(hour)] ?? null,
      tokens: 1000,
    })),
    sources: ['anthropic' as const],
    coarseSources: [],
    excludedTokens: 0,
    excludedCost: null,
    peakHour: peak ? Number(peak[0]) : null,
    measure: 'cost' as const,
    ...overrides,
  };
}

describe('time-of-day panels', () => {
  it('draws no hour panel at all when no source reported sub-daily buckets', () => {
    const svg = renderReportSvg(report([row('2026-07-25', { openrouter: 2 })]), OPTIONS);
    // A flat 24-bar panel drawn from whole days would be an invented shape.
    expect(svg).not.toContain('data-panel="time-of-day"');
    expect(svg).not.toContain('data-panel="week-hours"');
  });

  it('draws one bar per busy hour on a clock axis, labelling the peak', () => {
    const svg = renderReportSvg(
      report([row('2026-07-25', { anthropic: 9 })], {}, { timeOfDay: timeOfDay({ 9: 6, 22: 3 }) }),
      OPTIONS,
    );

    const hours = panel(svg, 'time-of-day');
    expect(svg).toContain('Cost by hour of day (UTC)');
    // The axis is a clock, not the figure's date axis — which the period panels
    // still carry, so this has to be asserted inside this panel alone.
    expect(hours).toContain('>09:00<');
    expect(hours).toContain('>21:00<');
    expect(hours).not.toContain('2026-07-25');
    // Two busy hours, so two bars — the other 22 slots stay empty.
    expect(hours.match(/<rect/g)?.length).toBe(2);
    // The peak is labelled directly rather than left to a ruler.
    expect(hours).toContain('$6.00');
  });

  it('states which sources the hour panels cover, and what they leave out', () => {
    const svg = renderReportSvg(
      report(
        [row('2026-07-25', { anthropic: 4 })],
        {},
        {
          timeOfDay: timeOfDay(
            { 9: 4 },
            { coarseSources: ['openrouter', 'ccusage'], excludedCost: 6, excludedTokens: 5000 },
          ),
        },
      ),
      OPTIONS,
    );

    expect(svg).toContain('covers only the sources that reported sub-daily buckets');
    expect(svg).toContain('$6.00 and 5,000 tokens from openrouter, ccusage');
    expect(svg).toContain('excluded from the hour panels rather than spread across 24 hours');
  });

  it('separates the hours of the heatmap, so a quiet stretch is not one wide cell', () => {
    const svg = renderReportSvg(
      report([row('2026-07-25', { anthropic: 9 })], {}, { timeOfDay: timeOfDay({ 9: 6, 22: 3 }) }),
      OPTIONS,
    );
    // Seven separators at the three-hourly marks, plus one hairline row per
    // weekday, so an empty run of hours still reads as several hours.
    expect(panel(svg, 'week-hours').match(/<line/g)?.length).toBe(7);
    expect(panel(svg, 'week-hours').match(/<rect[^>]*fill="none"/g)?.length).toBe(7);
  });

  it('says the heatmap’s colour is a rank, so it cannot be read as a magnitude', () => {
    const svg = renderReportSvg(
      report([row('2026-07-25', { anthropic: 9 })], {}, { timeOfDay: timeOfDay({ 9: 6, 22: 3 }) }),
      OPTIONS,
    );
    expect(svg).toContain('data-panel="week-hours"');
    expect(svg).toContain('rank among the busy cells, not its magnitude');
    expect(svg).toContain('>Mon<');
    expect(svg).toContain('>Sun<');
  });
});

describe('project and concentration statistics', () => {
  function withWorkspaces(rows: DimensionBreakdown[]): ReportRow {
    return { ...row('2026-07-25', { anthropic: 4 }), workspaceBreakdowns: rows };
  }

  it('ranks platform workspaces, and keeps unattributed usage as its own row', () => {
    const svg = renderReportSvg(
      report([
        withWorkspaces([
          { ...breakdown('anthropic', 3), id: 'ws_1', name: 'Platform' },
          { ...breakdown('anthropic', 1), id: '(unattributed)', name: '(no workspace reported)' },
        ]),
      ]),
      OPTIONS,
    );

    expect(svg).toContain('data-panel="workspace-rank"');
    expect(svg).toContain('Platform');
    expect(svg).toContain('(no workspace reported)');
    expect(svg).toContain('A &quot;project&quot; here is a platform workspace');
    expect(svg).toContain('keeps its own row in that panel');
  });

  it('draws no project panel when no platform ever named a workspace', () => {
    const svg = renderReportSvg(
      report([
        withWorkspaces([
          { ...breakdown('ccusage', 4), id: '(unattributed)', name: '(no workspace reported)' },
        ]),
      ]),
      OPTIONS,
    );
    // One bar saying "no workspace reported" answers nothing.
    expect(svg).not.toContain('data-panel="workspace-rank"');
  });

  it('states concentration in the caption in periods, not as a bare ratio', () => {
    const svg = renderReportSvg(
      report(
        [row('2026-07-24', { anthropic: 9 }), row('2026-07-25', { anthropic: 1 })],
        {},
        {
          concentration: {
            unit: 'daily',
            measure: 'cost',
            activePeriods: 2,
            topShare: 0.9,
            periodsForHalf: 1,
            topDecileShare: 0.9,
            topDecilePeriods: 1,
          },
        },
      ),
      OPTIONS,
    );

    expect(svg).toContain('90% of spend fell in the single busiest day');
    expect(svg).toContain('half of it in 1 of 2 active days');
  });
});
