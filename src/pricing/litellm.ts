/**
 * Prices for platforms that publish no machine-readable price list.
 *
 * OpenAI and Anthropic both bill in their own cost endpoints — that reported
 * cost is what `aiusage` shows for a platform total, and it is authoritative.
 * A unit-price table is still needed to *allocate* that real cost across API
 * keys and accounts (the cost endpoints will not split that far) and to answer
 * `aiusage pricing`. LiteLLM's table is used because it is public, maintained,
 * versioned, and is the same source `ccusage` prices Claude Code usage with.
 */

import { stripDateSuffix, stripVendorPrefix } from '../models.js';
import type { ProviderId } from '../types.js';
import type { ModelPrice, PriceBook, PriceLookup } from './types.js';

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

type LiteLlmEntry = {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
};

export type LiteLlmPayload = Record<string, LiteLlmEntry>;

/**
 * aiusage provider → the `litellm_provider` value that identifies its models.
 *
 * Deliberately partial. The local source (ccusage) has no vendor: an agent log
 * names a model, never who served it, and ccusage has already priced those rows
 * from this same table. Re-pricing them here would either guess a vendor or
 * duplicate its arithmetic, so the local source has no LiteLLM lookup at all.
 */
const LITELLM_PROVIDER: Partial<Record<ProviderId, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  together: 'together_ai',
};

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toModelPrice(entry: LiteLlmEntry): ModelPrice | null {
  const input = numberOrNull(entry.input_cost_per_token);
  const output = numberOrNull(entry.output_cost_per_token);
  // A table row without both sides of the trade is not a usable price.
  if (input === null || output === null) return null;

  const longInput = numberOrNull(entry.input_cost_per_token_above_200k_tokens);
  const longOutput = numberOrNull(entry.output_cost_per_token_above_200k_tokens);

  return {
    inputPerToken: input,
    outputPerToken: output,
    cacheReadPerToken: numberOrNull(entry.cache_read_input_token_cost),
    cacheWritePerToken: numberOrNull(entry.cache_creation_input_token_cost),
    longContext:
      longInput !== null && longOutput !== null
        ? {
            inputPerToken: longInput,
            outputPerToken: longOutput,
            cacheReadPerToken:
              numberOrNull(entry.cache_read_input_token_cost_above_200k_tokens) ??
              numberOrNull(entry.cache_read_input_token_cost),
            cacheWritePerToken:
              numberOrNull(entry.cache_creation_input_token_cost_above_200k_tokens) ??
              numberOrNull(entry.cache_creation_input_token_cost),
          }
        : null,
  };
}

/**
 * Candidate keys for a platform model id, most specific first. Platforms return
 * ids with and without date suffixes and with or without a vendor prefix; the
 * table uses several of those spellings.
 */
export function candidateKeys(model: string, litellmProvider: string): string[] {
  const base = model.trim();
  const withoutVendor = stripVendorPrefix(base);
  const candidates = [
    base,
    `${litellmProvider}/${base}`,
    withoutVendor,
    `${litellmProvider}/${withoutVendor}`,
  ];
  const undated = stripDateSuffix(withoutVendor);
  if (undated !== withoutVendor) {
    candidates.push(undated, `${litellmProvider}/${undated}`);
  }
  return [...new Set(candidates)];
}

export function buildLiteLlmPriceBook(payload: LiteLlmPayload, source: string): PriceBook {
  // Pre-index by provider so the prefix fallback never crosses vendors — an
  // OpenAI id must not accidentally price against an Anthropic row.
  const byProvider = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(payload)) {
    const provider = entry.litellm_provider;
    if (!provider) continue;
    const keys = byProvider.get(provider);
    if (keys) keys.push(key);
    else byProvider.set(provider, [key]);
  }
  for (const keys of byProvider.values()) {
    // Longest first: prefix matching must prefer the most specific row.
    keys.sort((a, b) => b.length - a.length);
  }

  /** The first key that both names this model and carries a usable price. */
  const findKey = (model: string, litellmProvider: string): string | null => {
    for (const candidate of candidateKeys(model, litellmProvider)) {
      const entry = payload[candidate];
      // The vendor must agree: model ids are not globally unique, and pricing an
      // Anthropic model from an OpenAI row would be silently wrong.
      if (entry?.litellm_provider === litellmProvider && toModelPrice(entry)) return candidate;
    }
    const bare = model.includes('/') ? (model.split('/').pop() ?? model) : model;
    for (const key of byProvider.get(litellmProvider) ?? []) {
      if (bare.startsWith(key) && toModelPrice(payload[key] ?? {})) return key;
    }
    return null;
  };

  return {
    sources: [source],
    lookup(provider: ProviderId, model: string): PriceLookup | null {
      const litellmProvider = LITELLM_PROVIDER[provider];
      if (litellmProvider === undefined) return null;
      const matchedKey = findKey(model, litellmProvider);
      if (matchedKey === null) return null;
      const price = toModelPrice(payload[matchedKey] ?? {});
      return price ? { price, matchedKey, source } : null;
    },
  };
}
