import type { ProviderId } from '../types.js';

/**
 * Unit prices in **USD per token**, matching how every upstream price source
 * expresses them. Conversion to micro-USD happens once, when a cost is computed.
 *
 * A null cache price means "this source does not publish one", not "free" — the
 * cost path then falls back to the uncached input price and says so.
 */
export type ModelPrice = {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number | null;
  cacheWritePerToken: number | null;
  /**
   * Long-context tier, where the platform charges more above a token threshold
   * (Anthropic's 200k+ context window). Applied only when a usage record is
   * explicitly tagged as being in that tier.
   */
  longContext: {
    inputPerToken: number;
    outputPerToken: number;
    cacheReadPerToken: number | null;
    cacheWritePerToken: number | null;
  } | null;
};

export type PriceLookup = {
  price: ModelPrice;
  /** The key the price source was matched on — provenance, shown in `pricing`. */
  matchedKey: string;
  /** e.g. `litellm@2026-07-26`, `openrouter:/api/v1/models`. */
  source: string;
};

export interface PriceBook {
  lookup(provider: ProviderId, model: string): PriceLookup | null;
  /** Human-readable list of the sources actually loaded, for the report meta. */
  readonly sources: readonly string[];
}

/** A price book that knows nothing — used when `--no-cost` or all loads fail. */
export const EMPTY_PRICE_BOOK: PriceBook = {
  lookup: () => null,
  sources: [],
};
