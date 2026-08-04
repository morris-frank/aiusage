/**
 * Assembles the price book for a run.
 *
 * Per provider the sources are tried most-authoritative first: a platform's own
 * catalogue, then LiteLLM's table. Every lookup carries the source it matched,
 * so a cost derived from a third-party table is never indistinguishable from one
 * the platform published itself.
 */

import type { Credentials } from '../config.js';
import type { HttpClient } from '../http.js';
import type { Diagnostic, ProviderId } from '../types.js';
import { PriceCache } from './cache.js';
import { buildLiteLlmPriceBook, LITELLM_PRICES_URL, type LiteLlmPayload } from './litellm.js';
import {
  buildOpenRouterPriceBook,
  OPENROUTER_MODELS_URL,
  type OpenRouterModelsPayload,
} from './remote.js';
import { EMPTY_PRICE_BOOK, type PriceBook, type PriceLookup } from './types.js';

export type { ModelPrice, PriceBook, PriceLookup } from './types.js';
export { EMPTY_PRICE_BOOK } from './types.js';

export function createCompositePriceBook(
  booksByProvider: Partial<Record<ProviderId, PriceBook[]>>,
): PriceBook {
  const sources = new Set<string>();
  for (const books of Object.values(booksByProvider)) {
    for (const book of books ?? []) for (const source of book.sources) sources.add(source);
  }

  return {
    sources: [...sources],
    lookup(provider: ProviderId, model: string): PriceLookup | null {
      for (const book of booksByProvider[provider] ?? []) {
        const found = book.lookup(provider, model);
        if (found) return found;
      }
      return null;
    },
  };
}

export type LoadPriceBookOptions = {
  http: HttpClient;
  cacheDir: string;
  offline: boolean;
  /** Only load sources these providers need. */
  providers: readonly ProviderId[];
  credentials: Credentials;
  now?: () => Date;
};

export type LoadedPriceBook = {
  priceBook: PriceBook;
  diagnostics: Diagnostic[];
};

export async function loadPriceBook(options: LoadPriceBookOptions): Promise<LoadedPriceBook> {
  const cache = new PriceCache(
    options.now === undefined
      ? { dir: options.cacheDir }
      : { dir: options.cacheDir, now: options.now },
  );
  const diagnostics: Diagnostic[] = [];
  const wanted = new Set(options.providers);

  const litellm = await loadSource<LiteLlmPayload>({
    cache,
    name: 'litellm-prices',
    offline: options.offline,
    fetcher: () => options.http.json<LiteLlmPayload>(LITELLM_PRICES_URL),
    diagnostics,
    label: 'LiteLLM price table',
  });
  const litellmBook = litellm
    ? buildLiteLlmPriceBook(litellm.payload, `litellm@${litellm.fetchedAt.slice(0, 10)}`)
    : EMPTY_PRICE_BOOK;

  let openrouterBook = EMPTY_PRICE_BOOK;
  if (wanted.has('openrouter')) {
    const models = await loadSource<OpenRouterModelsPayload>({
      cache,
      name: 'openrouter-models',
      offline: options.offline,
      fetcher: () => options.http.json<OpenRouterModelsPayload>(OPENROUTER_MODELS_URL),
      diagnostics,
      label: 'OpenRouter model catalogue',
      provider: 'openrouter',
    });
    if (models) openrouterBook = buildOpenRouterPriceBook(models.payload);
  }

  return {
    diagnostics,
    priceBook: createCompositePriceBook({
      openrouter: [openrouterBook, litellmBook],
      openai: [litellmBook],
      anthropic: [litellmBook],
    }),
  };
}

type LoadSourceOptions<T> = {
  cache: PriceCache;
  name: string;
  offline: boolean;
  fetcher: () => Promise<T>;
  diagnostics: Diagnostic[];
  label: string;
  provider?: ProviderId;
};

async function loadSource<T>(
  options: LoadSourceOptions<T>,
): Promise<{ payload: T; fetchedAt: string } | null> {
  try {
    const resolved = await options.cache.resolve(options.name, options.fetcher, {
      offline: options.offline,
    });
    if (resolved) return { payload: resolved.payload, fetchedAt: resolved.fetchedAt };
    options.diagnostics.push({
      provider: options.provider ?? null,
      level: 'warning',
      code: 'pricing-offline-miss',
      message: `${options.label} is not cached, so --offline cannot price from it. Run once without --offline.`,
    });
    return null;
  } catch (error) {
    options.diagnostics.push({
      provider: options.provider ?? null,
      level: 'warning',
      code: 'pricing-load-failed',
      message: `${options.label} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}
