/**
 * Price books built from the platforms' own model catalogues — the most
 * authoritative unit prices available, because they are what the platform will
 * actually bill.
 *
 * OpenRouter publishes USD **per token** as decimal strings.
 * Together publishes numbers in its `/v1/models` `pricing` object; see
 * `TOGETHER_PRICE_UNIT` for the unit and its open question.
 */

import type { ProviderId } from '../types.js';
import type { ModelPrice, PriceBook, PriceLookup } from './types.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const TOGETHER_MODELS_URL = 'https://api.together.xyz/v1/models';

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

/**
 * Together's `/v1/models` `pricing` numbers are read as **USD per million
 * tokens**, matching Together's published serverless price sheet (e.g. `0.88`
 * for a model listed at $0.88/1M tokens).
 *
 * UNRESOLVED: the unit is not stated in Together's API reference, and the
 * endpoint requires a key so it cannot be checked without credentials. A price
 * that lands outside `PLAUSIBLE_USD_PER_MTOK` is therefore dropped rather than
 * reported, and `aiusage pricing` labels the source so the assumption is visible
 * at the point of use. Verify against an invoice before relying on it.
 */
export const TOGETHER_PRICE_UNIT = { tokensPerUnit: 1_000_000 } as const;
const PLAUSIBLE_USD_PER_MTOK = { min: 0, max: 500 } as const;

type TogetherModel = {
  id?: string;
  pricing?: { input?: number; output?: number; cached_input?: number };
};

export type TogetherModelsPayload = TogetherModel[] | { data?: TogetherModel[] };

function perMillionToPerToken(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < PLAUSIBLE_USD_PER_MTOK.min || value > PLAUSIBLE_USD_PER_MTOK.max) return null;
  return value / TOGETHER_PRICE_UNIT.tokensPerUnit;
}

export function buildTogetherPriceBook(
  payload: TogetherModelsPayload,
  source = `together:${TOGETHER_MODELS_URL} (unit assumed USD/1M tokens)`,
): PriceBook {
  const models = Array.isArray(payload) ? payload : (payload.data ?? []);
  const byKey = new Map<string, ModelPrice>();

  for (const model of models) {
    if (!model.id || !model.pricing) continue;
    const input = perMillionToPerToken(model.pricing.input);
    const output = perMillionToPerToken(model.pricing.output);
    if (input === null || output === null) continue;
    byKey.set(model.id, {
      inputPerToken: input,
      outputPerToken: output,
      cacheReadPerToken: perMillionToPerToken(model.pricing.cached_input),
      cacheWritePerToken: null,
      longContext: null,
    });
  }

  return {
    sources: [source],
    lookup(_provider: ProviderId, model: string): PriceLookup | null {
      const price = byKey.get(model);
      return price ? { price, matchedKey: model, source } : null;
    },
  };
}
