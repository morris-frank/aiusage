/**
 * Runs the configured providers and returns their raw results.
 *
 * Providers are independent hosts, so they run concurrently, and one platform
 * failing never fails the run: its result comes back with `status: 'error'` and a
 * diagnostic, and the report says so. A provider without credentials is present
 * in the output as `skipped` — an absent platform must be visible, because a
 * missing platform total is not a zero.
 */

import {
  type BilledVia,
  CREDENTIAL_ENV_VARS,
  configuredProviders,
  type LocalSourceConfig,
  type RuntimeConfig,
} from './config.js';
import { addDays, dayStartUtc, toDateString } from './dates.js';
import { HttpClient } from './http.js';
import type { CommandRunner } from './providers/ccusage.js';
import { localOverlapDiagnostic } from './providers/ccusage.js';
import { createProviders, DECLARED_CAPABILITIES } from './providers/index.js';
import type { CollectContext } from './providers/types.js';
import {
  type DateRange,
  type Diagnostic,
  isLocalProvider,
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
  /**
   * Ask every platform that can for sub-daily buckets. Only the time-of-day
   * statistics need them, and they cost extra pages, so this is opt-in.
   */
  hourlyBuckets?: boolean;
  http?: HttpClient;
  now?: Date;
  /** Include local agent usage (ccusage). Null leaves it out entirely. */
  local?: LocalSourceConfig | null;
  /** Injected process runner for the local source, so tests spawn nothing. */
  localRunner?: CommandRunner;
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
    hourlyBuckets: options.hourlyBuckets ?? false,
    concurrency: options.config.concurrency,
    now,
  };

  const providers = createProviders(
    options.config.credentials,
    options.local ?? null,
    options.localRunner,
  ).filter((provider) => requested.has(provider.id));
  const collected = await Promise.all(providers.map((provider) => provider.collect(context)));

  const results: ProviderResult[] = [];
  for (const id of PROVIDER_IDS) {
    if (!requested.has(id)) continue;
    const found = collected.find((result) => result.provider === id);
    results.push(found ?? skippedResult(id, configured.has(id)));
  }

  removeBilledLocalUsage(results, options.config.localBilledVia, now);
  attributeBilledAgents(results, options.config.localBilledVia);
  warnAboutLocalOverlap(results);
  return { results, diagnostics: results.flatMap((result) => result.diagnostics) };
}

/**
 * An agent the operator declared billed through a platform is in that
 * platform's rows already — its local rows are the same traffic seen twice, and
 * the platform's are the billed ones. They are dropped only when that platform
 * actually reported in this run, and only for days inside its lookback: before
 * that, the local rows are all there is.
 */
function removeBilledLocalUsage(
  results: readonly ProviderResult[],
  billedVia: ReadonlyMap<string, BilledVia>,
  now: Date,
): void {
  const local = results.find((result) => isLocalProvider(result.provider));
  if (!local || billedVia.size === 0) return;

  const removed = new Map<string, { platform: ProviderId; tokens: number }>();
  local.records = local.records.filter((record) => {
    const agent = record.tags.agent;
    const platform = agent === undefined ? undefined : billedVia.get(agent)?.platform;
    if (!agent || !platform) return true;
    const billed = results.find((result) => result.provider === platform);
    if (!billed || billed.records.length === 0) return true;
    const lookback = billed.capabilities.maxLookbackDays;
    if (
      lookback !== null &&
      record.bucketStart < dayStartUtc(addDays(toDateString(now), -lookback)).toISOString()
    ) {
      return true;
    }
    const { input, output, cacheCreation, cacheRead } = record.tokens;
    const tokens = (removed.get(agent)?.tokens ?? 0) + input + output + cacheCreation + cacheRead;
    removed.set(agent, { platform, tokens });
    return false;
  });
  for (const [agent, { platform, tokens }] of removed) {
    local.diagnostics.push({
      provider: local.provider,
      level: 'info',
      code: 'local-overlap-removed',
      message: `${tokens} local ${agent} tokens are left out: AIUSAGE_LOCAL_BILLED_VIA says ${agent} is billed through ${PROVIDER_LABELS[platform]}, whose rows already count them.`,
    });
  }
}

/**
 * The platform rows that replaced an agent's local rows still belong to that
 * agent: rows on the API key the operator named for it are tagged with it, so
 * the agent split shows `pi` rather than the platform that billed it.
 */
function attributeBilledAgents(
  results: readonly ProviderResult[],
  billedVia: ReadonlyMap<string, BilledVia>,
): void {
  for (const [agent, { platform, apiKeyName }] of billedVia) {
    if (apiKeyName === null) continue;
    for (const record of results.find((result) => result.provider === platform)?.records ?? []) {
      if (record.apiKey?.name !== apiKeyName) continue;
      record.tags.agent = agent;
      record.tags.agentAttribution = 'operator-mapped-key';
    }
  }
}

/**
 * Local rows and platform rows can describe the same traffic. The warning lives
 * on the local result so it travels with the source that caused it.
 */
function warnAboutLocalOverlap(results: readonly ProviderResult[]): void {
  const local = results.find((result) => isLocalProvider(result.provider));
  if (!local || local.records.length === 0) return;

  const platforms = results
    .filter((result) => !isLocalProvider(result.provider) && result.records.length > 0)
    .map((result) => PROVIDER_LABELS[result.provider]);
  if (platforms.length === 0) return;
  local.diagnostics.push(localOverlapDiagnostic(platforms));
}

function skippedResult(provider: ProviderId, configured: boolean): ProviderResult {
  const message = isLocalProvider(provider)
    ? `${PROVIDER_LABELS[provider]} is not included — pass --local to add ccusage’s rows to this report. Local agent usage is unknown, not zero.`
    : configured
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
