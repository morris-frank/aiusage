/**
 * Price books built from the platforms' own model catalogues — the most
 * authoritative unit prices available, because they are what the platform will
 * actually bill.
 *
 * OpenRouter publishes USD **per token** as decimal strings, and is the only
 * platform here with a machine-readable catalogue; the rest are priced from
 * `litellm.ts`.
 */

import type { ProviderId } from '../types.js';
import type { ModelPrice, PriceBook, PriceLookup } from './types.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

type OpenRouterModel = {
  id?: string;
  canonical_slug?: string;
  pricing?: Record<string, string | undefined>;
};

export type OpenRouterModelsPayload = { data?: OpenRouterModel[] };

function parsePerToken(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  // OpenRouter uses "-1" for "priced dynamically / not applicable".
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function buildOpenRouterPriceBook(
  payload: OpenRouterModelsPayload,
  source = `openrouter:${OPENROUTER_MODELS_URL}`,
): PriceBook {
  const byKey = new Map<string, ModelPrice>();

  for (const model of payload.data ?? []) {
    const pricing = model.pricing;
    if (!pricing) continue;
    const input = parsePerToken(pricing.prompt);
    const output = parsePerToken(pricing.completion);
    if (input === null || output === null) continue;

    const price: ModelPrice = {
      inputPerToken: input,
      outputPerToken: output,
      cacheReadPerToken: parsePerToken(pricing.input_cache_read),
      cacheWritePerToken: parsePerToken(pricing.input_cache_write),
      longContext: null,
    };
    // Activity rows report both the slug and the permaslug; index both.
    for (const key of [model.id, model.canonical_slug]) {
      if (key) byKey.set(key, price);
    }
  }

  return {
    sources: [source],
    lookup(_provider: ProviderId, model: string): PriceLookup | null {
      const direct = byKey.get(model);
      if (direct) return { price: direct, matchedKey: model, source };
      return null;
    },
  };
}
