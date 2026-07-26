/**
 * Runs the configured providers and returns their raw results.
 *
 * Providers are independent hosts, so they run concurrently, and one platform
 * failing never fails the run: its result comes back with `status: 'error'` and a
 * diagnostic, and the report says so. A provider without credentials is present
 * in the output as `skipped` — an absent platform must be visible, because a
 * missing platform total is not a zero.
 */

import { CREDENTIAL_ENV_VARS, configuredProviders, type RuntimeConfig } from './config.js';
import { HttpClient } from './http.js';
import { createProviders, DECLARED_CAPABILITIES } from './providers/index.js';
import type { CollectContext } from './providers/types.js';
import {
  type DateRange,
  type Diagnostic,
  NO_CAPABILITIES,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type ProviderId,
  type ProviderResult,
} from './types.js';

export type CollectOptions = {
  config: RuntimeConfig;
  range: DateRange;
  timeZone: string;
  /** Restrict the run to these providers; defaults to every configured one. */
  only?: readonly ProviderId[];
  http?: HttpClient;
  now?: Date;
};

export type Collection = {
  results: ProviderResult[];
  diagnostics: Diagnostic[];
};

export function createHttpClient(config: RuntimeConfig): HttpClient {
  return new HttpClient({
    timeoutMs: config.timeoutMs,
    secrets: config.secrets,
    userAgent: 'aiusage (+https://github.com/morris-frank/aiusage)',
  });
}

export async function collectUsage(options: CollectOptions): Promise<Collection> {
  const http = options.http ?? createHttpClient(options.config);
  const now = options.now ?? new Date();
  const requested = new Set(options.only ?? PROVIDER_IDS);
  const configured = new Set(configuredProviders(options.config.credentials));

  const context: CollectContext = {
    http,
    range: options.range,
    timeZone: options.timeZone,
    concurrency: options.config.concurrency,
    now,
  };

  const providers = createProviders(options.config.credentials).filter((provider) =>
    requested.has(provider.id),
  );
  const collected = await Promise.all(providers.map((provider) => provider.collect(context)));

  const results: ProviderResult[] = [];
  for (const id of PROVIDER_IDS) {
    if (!requested.has(id)) continue;
    const found = collected.find((result) => result.provider === id);
    results.push(found ?? skippedResult(id, configured.has(id)));
  }

  return { results, diagnostics: results.flatMap((result) => result.diagnostics) };
}

function skippedResult(provider: ProviderId, configured: boolean): ProviderResult {
  const message = configured
    ? `${PROVIDER_LABELS[provider]} was configured but produced no result.`
    : `${PROVIDER_LABELS[provider]} is not configured — set ${CREDENTIAL_ENV_VARS[provider].join(' or ')} to include it. Its usage is unknown, not zero.`;

  return {
    provider,
    status: 'skipped',
    capabilities: configured ? DECLARED_CAPABILITIES[provider] : NO_CAPABILITIES,
    records: [],
    costRecords: [],
    diagnostics: [{ provider, level: 'info', code: 'not-configured', message }],
    identity: null,
  };
}
