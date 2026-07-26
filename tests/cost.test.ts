import { describe, expect, it } from 'vitest';
import { applyCosts, deriveCost } from '../src/cost.js';
import type { PriceBook } from '../src/pricing/index.js';
import { costRecord, providerResult, usageRecord } from './helpers/records.js';

/** $1/Mtok input, $10/Mtok output, cache read a tenth of input. */
const PRICES: PriceBook = {
  sources: ['test-prices'],
  lookup: (_provider, model) =>
    model === 'no-price'
      ? null
      : {
          matchedKey: model,
          source: 'test-prices',
          price: {
            inputPerToken: 0.000001,
            outputPerToken: 0.00001,
            cacheReadPerToken: 0.0000001,
            cacheWritePerToken: 0.00000125,
            longContext: {
              inputPerToken: 0.000002,
              outputPerToken: 0.00002,
              cacheReadPerToken: 0.0000002,
              cacheWritePerToken: 0.0000025,
            },
          },
        },
};

describe('deriveCost', () => {
  it('prices every token class', () => {
    const record = usageRecord({
      tokens: { input: 1000, output: 100, cacheCreation: 200, cacheRead: 5000, reasoning: 0 },
    });
    // 1000×1e-6 + 100×1e-5 + 200×1.25e-6 + 5000×1e-7 = 0.00275 USD
    expect(deriveCost(record, PRICES)?.micros).toBe(2750);
  });

  it('uses the long-context tier only when the record is tagged as such', () => {
    const tokens = { input: 1000, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 };
    expect(deriveCost(usageRecord({ tokens }), PRICES)?.micros).toBe(1000);
    expect(
      deriveCost(usageRecord({ tokens, tags: { contextWindow: '200k-1M' } }), PRICES)?.micros,
    ).toBe(2000);
  });

  it('falls back to the uncached rate when no cache price is published', () => {
    const book: PriceBook = {
      sources: [],
      lookup: () => ({
        matchedKey: 'm',
        source: 's',
        price: {
          inputPerToken: 0.000001,
          outputPerToken: 0,
          cacheReadPerToken: null,
          cacheWritePerToken: null,
          longContext: null,
        },
      }),
    };
    const record = usageRecord({
      tokens: { input: 0, output: 0, cacheCreation: 100, cacheRead: 100, reasoning: 0 },
    });
    expect(deriveCost(record, book)?.micros).toBe(200);
  });

  it('returns null without a model or a price', () => {
    expect(deriveCost(usageRecord({ model: null }), PRICES)).toBeNull();
    expect(deriveCost(usageRecord({ model: 'no-price' }), PRICES)).toBeNull();
  });
});

describe('applyCosts', () => {
  it('keeps a platform-reported cost and never re-derives it', () => {
    const result = providerResult('openrouter', [
      usageRecord({ provider: 'openrouter', reportedCostMicros: 15_000 }),
    ]);

    const { records } = applyCosts([result], PRICES);
    expect(records[0]?.costMicros).toBe(15_000);
    expect(records[0]?.costSource).toBe('reported');
    expect(records[0]?.priceSource).toBeNull();
  });

  it('derives a cost when the platform reports none', () => {
    const { records } = applyCosts([providerResult('anthropic', [usageRecord()])], PRICES);
    expect(records[0]?.costSource).toBe('calculated');
    expect(records[0]?.priceSource).toBe('test-prices');
  });

  it('allocates a billed model-day total across the keys inside it, exactly', () => {
    const shared = { model: 'claude-opus-4-6', workspace: { id: 'ws_1', name: null } };
    const result = providerResult(
      'anthropic',
      [
        usageRecord({
          ...shared,
          apiKey: { id: 'key_a', name: 'A' },
          tokens: { input: 1000, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 },
        }),
        usageRecord({
          ...shared,
          apiKey: { id: 'key_b', name: 'B' },
          tokens: { input: 3000, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 },
        }),
      ],
      [costRecord({ ...shared, amountMicros: 1_000_000 })],
    );

    const { records, unattributed } = applyCosts([result], PRICES);
    expect(records.map((record) => record.costMicros)).toEqual([250_000, 750_000]);
    expect(records.every((record) => record.costSource === 'allocated')).toBe(true);
    expect(records.reduce((sum, record) => sum + (record.costMicros ?? 0), 0)).toBe(1_000_000);
    expect(unattributed).toEqual([]);
  });

  it('allocates a project-day total that carries no model', () => {
    const workspace = { id: 'proj_1', name: null };
    const result = providerResult(
      'openai',
      [
        usageRecord({ provider: 'openai', model: 'gpt-5.3', workspace }),
        usageRecord({ provider: 'openai', model: 'gpt-5.3-mini', workspace }),
      ],
      [costRecord({ provider: 'openai', model: null, workspace, amountMicros: 900 })],
    );

    const { records } = applyCosts([result], PRICES);
    expect(records.reduce((sum, record) => sum + (record.costMicros ?? 0), 0)).toBe(900);
    expect(records.every((record) => record.costSource === 'allocated')).toBe(true);
  });

  it('reports a non-token charge separately instead of smearing it over tokens', () => {
    const result = providerResult(
      'anthropic',
      [usageRecord()],
      [
        costRecord({
          model: null,
          allocatable: false,
          description: 'Web search',
          amountMicros: 500,
        }),
      ],
    );

    const { records, unattributed } = applyCosts([result], PRICES);
    expect(records[0]?.costSource).toBe('calculated');
    expect(unattributed).toEqual([
      {
        provider: 'anthropic',
        amountMicros: 500,
        description: 'Web search',
        reason: 'not-allocatable',
      },
    ]);
  });

  it('flags billed cost that matches no collected usage', () => {
    const result = providerResult(
      'openai',
      [],
      [costRecord({ provider: 'openai', model: null, amountMicros: 2_500_000 })],
    );

    const { unattributed, diagnostics } = applyCosts([result], PRICES);
    expect(unattributed[0]?.reason).toBe('no-matching-usage');
    const warning = diagnostics.find((d) => d.code === 'cost-unattributed');
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('2.50 USD');
  });

  it('marks a record unavailable rather than pricing it at zero', () => {
    const { records, diagnostics } = applyCosts(
      [providerResult('openai', [usageRecord({ provider: 'openai', model: 'no-price' })])],
      PRICES,
    );
    expect(records[0]?.costMicros).toBeNull();
    expect(records[0]?.costSource).toBe('unavailable');
    expect(diagnostics.map((d) => d.code)).toContain('price-missing');
  });

  it('still splits a billed total when no price is available to weight by', () => {
    const result = providerResult(
      'openai',
      [
        usageRecord({
          provider: 'openai',
          model: 'no-price',
          apiKey: { id: 'a', name: null },
          tokens: { input: 100, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 },
        }),
        usageRecord({
          provider: 'openai',
          model: 'no-price',
          apiKey: { id: 'b', name: null },
          tokens: { input: 300, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 },
        }),
      ],
      [costRecord({ provider: 'openai', model: null, amountMicros: 400 })],
    );

    const { records } = applyCosts([result], PRICES);
    // Weighted by tokens, because that is the only signal left.
    expect(records.map((record) => record.costMicros)).toEqual([100, 300]);
  });
});
