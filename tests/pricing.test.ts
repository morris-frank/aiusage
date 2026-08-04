import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.js';
import { PriceCache } from '../src/pricing/cache.js';
import { createCompositePriceBook, loadPriceBook } from '../src/pricing/index.js';
import {
  buildLiteLlmPriceBook,
  candidateKeys,
  type LiteLlmPayload,
} from '../src/pricing/litellm.js';
import { buildOpenRouterPriceBook } from '../src/pricing/remote.js';
import { stubFetch } from './helpers/http.js';

const LITELLM: LiteLlmPayload = {
  'claude-opus-4-6': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 0.00000625,
    input_cost_per_token_above_200k_tokens: 0.00001,
    output_cost_per_token_above_200k_tokens: 0.00005,
  },
  'gpt-5.3-codex': {
    litellm_provider: 'openai',
    input_cost_per_token: 0.00000125,
    output_cost_per_token: 0.00001,
  },
  'broken-model': { litellm_provider: 'openai', input_cost_per_token: 0.001 },
};

describe('candidateKeys', () => {
  it('offers the spellings platforms actually return', () => {
    expect(candidateKeys('claude-opus-4-6-20260205', 'anthropic')).toEqual([
      'claude-opus-4-6-20260205',
      'anthropic/claude-opus-4-6-20260205',
      'claude-opus-4-6',
      'anthropic/claude-opus-4-6',
    ]);
    expect(candidateKeys('anthropic/claude-opus-5', 'openrouter')).toContain('claude-opus-5');
  });
});

describe('LiteLLM price book', () => {
  const book = buildLiteLlmPriceBook(LITELLM, 'litellm@test');

  it('matches an exact key', () => {
    const found = book.lookup('anthropic', 'claude-opus-4-6');
    expect(found?.price.inputPerToken).toBe(0.000005);
    expect(found?.price.cacheReadPerToken).toBe(5e-7);
    expect(found?.source).toBe('litellm@test');
  });

  it('carries the long-context tier when the table has one', () => {
    const found = book.lookup('anthropic', 'claude-opus-4-6');
    expect(found?.price.longContext).toEqual({
      inputPerToken: 0.00001,
      outputPerToken: 0.00005,
      cacheReadPerToken: 5e-7,
      cacheWritePerToken: 0.00000625,
    });
  });

  it('falls back to a prefix match within the same vendor', () => {
    const found = book.lookup('openai', 'gpt-5.3-codex-2026-05-01');
    expect(found?.matchedKey).toBe('gpt-5.3-codex');
  });

  it('never prices one vendor from another vendor’s row', () => {
    expect(book.lookup('anthropic', 'gpt-5.3-codex')).toBeNull();
    expect(book.lookup('openai', 'claude-opus-4-6')).toBeNull();
  });

  it('skips rows that are missing half the price', () => {
    expect(book.lookup('openai', 'broken-model')).toBeNull();
  });

  it('returns null for a model it has never heard of', () => {
    expect(book.lookup('openai', 'totally-made-up')).toBeNull();
  });
});

describe('OpenRouter price book', () => {
  const book = buildOpenRouterPriceBook({
    data: [
      {
        id: 'anthropic/claude-opus-5',
        canonical_slug: 'anthropic/claude-opus-5-20260723',
        pricing: {
          prompt: '0.00001',
          completion: '0.00005',
          input_cache_read: '0.000001',
          input_cache_write: '0.0000125',
        },
      },
      { id: 'dynamic/model', pricing: { prompt: '-1', completion: '-1' } },
    ],
  });

  it('reads per-token decimal strings and indexes both slugs', () => {
    expect(book.lookup('openrouter', 'anthropic/claude-opus-5')?.price).toEqual({
      inputPerToken: 0.00001,
      outputPerToken: 0.00005,
      cacheReadPerToken: 0.000001,
      cacheWritePerToken: 0.0000125,
      longContext: null,
    });
    expect(book.lookup('openrouter', 'anthropic/claude-opus-5-20260723')).not.toBeNull();
  });

  it('ignores models priced dynamically', () => {
    expect(book.lookup('openrouter', 'dynamic/model')).toBeNull();
  });
});

describe('composite price book', () => {
  it('prefers the platform catalogue over the third-party table', () => {
    const platform = buildOpenRouterPriceBook({
      data: [{ id: 'shared-model', pricing: { prompt: '0.000001', completion: '0.000002' } }],
    });
    const fallback = buildLiteLlmPriceBook(
      {
        'shared-model': {
          litellm_provider: 'openrouter',
          input_cost_per_token: 0.9,
          output_cost_per_token: 0.9,
        },
      },
      'litellm@test',
    );
    const composite = createCompositePriceBook({ openrouter: [platform, fallback] });

    expect(composite.lookup('openrouter', 'shared-model')?.price.inputPerToken).toBe(0.000001);
    expect(composite.sources).toHaveLength(2);
  });

  it('knows nothing about a provider it was not given a book for', () => {
    expect(createCompositePriceBook({}).lookup('openai', 'gpt-5.3')).toBeNull();
  });
});

describe('PriceCache', () => {
  it('serves a fresh entry without refetching, and refetches a stale one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-cache-'));
    let fetches = 0;
    const cache = new PriceCache({
      dir,
      maxAgeMs: 1000,
      now: () => new Date('2026-07-26T00:00:00Z'),
    });

    const first = await cache.resolve(
      'table',
      async () => {
        fetches += 1;
        return { value: 1 };
      },
      { offline: false },
    );
    expect(first?.payload).toEqual({ value: 1 });

    await cache.resolve(
      'table',
      async () => {
        fetches += 1;
        return { value: 2 };
      },
      { offline: false },
    );
    expect(fetches).toBe(1);

    const later = new PriceCache({ dir, maxAgeMs: 1, now: () => new Date('2026-07-27T00:00:00Z') });
    const refreshed = await later.resolve(
      'table',
      async () => {
        fetches += 1;
        return { value: 3 };
      },
      { offline: false },
    );
    expect(refreshed?.payload).toEqual({ value: 3 });
    expect(fetches).toBe(2);
  });

  it('serves any cached age when offline, and nothing when there is no cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-cache-'));
    await writeFile(
      join(dir, 'table.json'),
      JSON.stringify({ fetchedAt: '2020-01-01T00:00:00Z', payload: { value: 'ancient' } }),
    );
    const cache = new PriceCache({ dir });

    const stale = await cache.resolve('table', async () => ({ value: 'fresh' }), { offline: true });
    expect(stale?.payload).toEqual({ value: 'ancient' });

    const missing = await cache.resolve('absent', async () => ({ value: 'fresh' }), {
      offline: true,
    });
    expect(missing).toBeNull();
  });

  it('falls back to a stale entry when the refresh fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-cache-'));
    await writeFile(
      join(dir, 'table.json'),
      JSON.stringify({ fetchedAt: '2020-01-01T00:00:00Z', payload: { value: 'ancient' } }),
    );
    const cache = new PriceCache({ dir, maxAgeMs: 1 });

    const resolved = await cache.resolve(
      'table',
      async () => {
        throw new Error('network down');
      },
      { offline: false },
    );
    expect(resolved?.payload).toEqual({ value: 'ancient' });
  });
});

describe('loadPriceBook', () => {
  it('warns instead of silently pricing nothing when offline with no cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-cache-'));
    const { diagnostics, priceBook } = await loadPriceBook({
      http: new HttpClient({ fetchImpl: stubFetch([]) }),
      cacheDir: dir,
      offline: true,
      providers: ['openai'],
      credentials: { openrouter: null, openai: null, anthropic: null },
    });

    expect(priceBook.lookup('openai', 'gpt-5.3')).toBeNull();
    expect(diagnostics.map((d) => d.code)).toContain('pricing-offline-miss');
  });

  it('loads the LiteLLM table and the OpenRouter catalogue when they are wanted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-cache-'));
    const fetchImpl = stubFetch([
      { when: 'model_prices_and_context_window.json', body: LITELLM },
      {
        when: 'openrouter.ai/api/v1/models',
        body: { data: [{ id: 'openai/gpt-5.3', pricing: { prompt: '0.1', completion: '0.2' } }] },
      },
    ]);

    const { priceBook } = await loadPriceBook({
      http: new HttpClient({ fetchImpl }),
      cacheDir: dir,
      offline: false,
      providers: ['openrouter', 'anthropic'],
      credentials: { openrouter: null, openai: null, anthropic: null },
    });

    expect(priceBook.lookup('openrouter', 'openai/gpt-5.3')?.price.inputPerToken).toBe(0.1);
    expect(priceBook.lookup('anthropic', 'claude-opus-4-6')?.price.outputPerToken).toBe(0.000025);
  });
});
