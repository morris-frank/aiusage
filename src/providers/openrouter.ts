/**
 * OpenRouter.
 *
 * Usage comes from `GET /api/v1/activity`, which returns one row per
 * (UTC date × model × serving provider) with token counts, request counts and
 * the credits actually spent — so OpenRouter cost is *reported*, never derived.
 *
 * Two credential tiers, and the difference is visible in the returned
 * capabilities rather than papered over:
 *   - inference key → that key's own activity, no key/account split;
 *   - management key → `GET /api/v1/keys`, then one activity call per key hash,
 *     which is the only grain OpenRouter will attribute activity at.
 *
 * Account attribution is therefore *derived from key ownership*
 * (`creator_user_id`), tagged as such on every record. OpenRouter does not
 * attribute an activity row to the member who made the request.
 */

import { mapWithConcurrency } from '../concurrency.js';
import type { OpenRouterCredentials } from '../config.js';
import { addDays, dayEndUtc, dayStartUtc, toDateString } from '../dates.js';
import { HttpError } from '../http.js';
import { usdToMicros } from '../money.js';
import type {
  Diagnostic,
  Principal,
  ProviderCapabilities,
  ProviderResult,
  UsageRecord,
} from '../types.js';
import type { CollectContext, Provider } from './types.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

/** `/activity` covers the last 30 *completed* UTC days. */
export const OPENROUTER_LOOKBACK_DAYS = 30;

type ActivityRow = {
  date?: string;
  model?: string;
  model_permaslug?: string;
  endpoint_id?: string;
  provider_name?: string;
  usage?: number;
  byok_usage_inference?: number;
  requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
};

type ActivityResponse = { data?: ActivityRow[] };

type KeyRow = {
  hash?: string;
  name?: string | null;
  label?: string | null;
  disabled?: boolean;
  created_at?: string;
  creator_user_id?: string | null;
  workspace_id?: string | null;
};

type KeysResponse = { data?: KeyRow[] };

const DECLARED: ProviderCapabilities = {
  usage: true,
  reportedCost: true,
  splitByModel: true,
  splitByApiKey: true,
  splitByAccount: true,
  splitByWorkspace: true,
  livePricing: true,
  maxLookbackDays: OPENROUTER_LOOKBACK_DAYS,
};

export function createOpenRouterProvider(credentials: OpenRouterCredentials): Provider {
  return {
    id: 'openrouter',
    declaredCapabilities: DECLARED,
    collect: (context) => collect(context, credentials),
  };
}

async function collect(
  context: CollectContext,
  credentials: OpenRouterCredentials,
): Promise<ProviderResult> {
  const diagnostics: Diagnostic[] = [];
  const managementKey = credentials.managementKey;
  const readKey = managementKey ?? credentials.apiKey;

  if (!readKey) {
    return result(
      'skipped',
      { ...DECLARED, usage: false },
      [],
      [
        {
          provider: 'openrouter',
          level: 'info',
          code: 'no-credentials',
          message: 'Set OPENROUTER_API_KEY (or OPENROUTER_MANAGEMENT_KEY) to include OpenRouter.',
        },
      ],
    );
  }

  warnAboutLookback(context, diagnostics);

  if (!managementKey) {
    diagnostics.push({
      provider: 'openrouter',
      level: 'info',
      code: 'no-management-key',
      message:
        'Using an inference key: only this key’s own activity is visible and it cannot be split by API key or account. Set OPENROUTER_MANAGEMENT_KEY for org-wide splits.',
    });
  }

  const keys = managementKey ? await listKeys(context, managementKey, diagnostics) : null;

  try {
    const records =
      keys && keys.length > 0
        ? await collectPerKey(context, managementKey ?? readKey, keys, diagnostics)
        : await collectUnscoped(context, readKey);

    const keyList = keys ?? [];
    const capabilities: ProviderCapabilities = {
      ...DECLARED,
      splitByApiKey: keyList.length > 0,
      splitByAccount: keyList.some((key) => key.creator_user_id),
      splitByWorkspace: keyList.some((key) => key.workspace_id),
    };
    const status = diagnostics.some((d) => d.level === 'warning') ? 'partial' : 'ok';
    return result(status, capabilities, records, diagnostics);
  } catch (error) {
    diagnostics.push(toDiagnostic(error));
    return result('error', { ...DECLARED, usage: false }, [], diagnostics);
  }
}

function warnAboutLookback(context: CollectContext, diagnostics: Diagnostic[]): void {
  const earliest = addDays(toDateString(context.now), -OPENROUTER_LOOKBACK_DAYS);
  if (context.range.since < earliest) {
    diagnostics.push({
      provider: 'openrouter',
      level: 'warning',
      code: 'lookback-truncated',
      message: `OpenRouter /activity only covers the last ${OPENROUTER_LOOKBACK_DAYS} completed UTC days; rows before ${earliest} are not available.`,
    });
  }
  if (context.timeZone !== 'UTC') {
    diagnostics.push({
      provider: 'openrouter',
      level: 'warning',
      code: 'timezone-approximation',
      message: `OpenRouter reports whole UTC days only, so rows are grouped by UTC day even though --timezone ${context.timeZone} was requested.`,
    });
  }
}

async function listKeys(
  context: CollectContext,
  managementKey: string,
  diagnostics: Diagnostic[],
): Promise<KeyRow[] | null> {
  const keys: KeyRow[] = [];
  const pageSize = 100;
  try {
    for (let offset = 0; ; offset += pageSize) {
      const response = await context.http.json<KeysResponse>(`${BASE_URL}/keys`, {
        headers: authHeaders(managementKey),
        query: { include_disabled: true, offset },
      });
      const page = response.data ?? [];
      keys.push(...page.filter((key) => typeof key.hash === 'string'));
      if (page.length < pageSize) break;
    }
    return keys;
  } catch (error) {
    diagnostics.push({
      provider: 'openrouter',
      level: 'warning',
      code: 'keys-unavailable',
      message: `Could not list OpenRouter API keys (${describe(error)}); falling back to unsplit activity.`,
    });
    return null;
  }
}

async function collectPerKey(
  context: CollectContext,
  readKey: string,
  keys: KeyRow[],
  diagnostics: Diagnostic[],
): Promise<UsageRecord[]> {
  const perKey = await mapWithConcurrency(keys, context.concurrency, async (key) => {
    const hash = key.hash;
    if (!hash) return [];
    try {
      const response = await context.http.json<ActivityResponse>(`${BASE_URL}/activity`, {
        headers: authHeaders(readKey),
        query: { api_key_hash: hash },
      });
      return toRecords(response.data ?? [], context, {
        apiKey: { id: hash, name: key.name ?? key.label ?? null },
        account: key.creator_user_id ? { id: key.creator_user_id, name: null } : null,
        workspace: key.workspace_id ? { id: key.workspace_id, name: null } : null,
      });
    } catch (error) {
      diagnostics.push({
        provider: 'openrouter',
        level: 'warning',
        code: 'activity-key-failed',
        message: `Activity for key ${key.name ?? hash.slice(0, 8)} could not be read (${describe(error)}); its usage is missing from this report.`,
      });
      return [];
    }
  });
  return perKey.flat();
}

async function collectUnscoped(context: CollectContext, readKey: string): Promise<UsageRecord[]> {
  const response = await context.http.json<ActivityResponse>(`${BASE_URL}/activity`, {
    headers: authHeaders(readKey),
  });
  return toRecords(response.data ?? [], context, { apiKey: null, account: null, workspace: null });
}

type Attribution = {
  apiKey: Principal | null;
  account: Principal | null;
  workspace: Principal | null;
};

function toRecords(
  rows: readonly ActivityRow[],
  context: CollectContext,
  attribution: Attribution,
): UsageRecord[] {
  return rows
    .filter(
      (row): row is ActivityRow & { date: string } =>
        typeof row.date === 'string' &&
        row.date >= context.range.since &&
        row.date <= context.range.until,
    )
    .map((row) => toRecord(row, attribution));
}

function toRecord(row: ActivityRow & { date: string }, attribution: Attribution): UsageRecord {
  const extras: Record<string, number> = {};
  if (typeof row.reasoning_tokens === 'number') extras.reasoningTokens = row.reasoning_tokens;
  // BYOK spend leaves OpenRouter's credit balance untouched, so it is tracked
  // separately instead of being folded into the reported cost.
  if (typeof row.byok_usage_inference === 'number' && row.byok_usage_inference > 0) {
    extras.byokCostMicros = usdToMicros(row.byok_usage_inference);
  }

  const tags: Record<string, string> = {};
  if (row.provider_name) tags.upstreamProvider = row.provider_name;
  if (row.model_permaslug) tags.modelPermaslug = row.model_permaslug;
  if (attribution.account) tags.accountAttribution = 'key-creator';

  return {
    provider: 'openrouter',
    bucketStart: dayStartUtc(row.date).toISOString(),
    bucketEnd: dayEndUtc(row.date).toISOString(),
    model: row.model ?? null,
    account: attribution.account,
    apiKey: attribution.apiKey,
    workspace: attribution.workspace,
    tokens: {
      input: row.prompt_tokens ?? 0,
      output: row.completion_tokens ?? 0,
      // OpenRouter does not report prompt caching in activity rows; leaving
      // these at zero is the measurement, not an assumption of no caching.
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: row.reasoning_tokens ?? 0,
    },
    requests: row.requests ?? null,
    reportedCostMicros: typeof row.usage === 'number' ? usdToMicros(row.usage) : null,
    extras,
    tags,
  };
}

function authHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDiagnostic(error: unknown): Diagnostic {
  if (error instanceof HttpError && error.isAuthFailure) {
    return {
      provider: 'openrouter',
      level: 'error',
      code: 'auth-failed',
      message: `OpenRouter rejected the credentials (HTTP ${error.status}). Check OPENROUTER_API_KEY / OPENROUTER_MANAGEMENT_KEY.`,
    };
  }
  return {
    provider: 'openrouter',
    level: 'error',
    code: 'collect-failed',
    message: `OpenRouter usage could not be collected: ${describe(error)}`,
  };
}

function result(
  status: ProviderResult['status'],
  capabilities: ProviderCapabilities,
  records: UsageRecord[],
  diagnostics: Diagnostic[],
): ProviderResult {
  return {
    provider: 'openrouter',
    status,
    capabilities,
    records,
    // OpenRouter reports spend on every activity row, so there is no coarser
    // cost grain to reconcile against.
    costRecords: [],
    diagnostics,
    identity: null,
  };
}

export { DECLARED as OPENROUTER_CAPABILITIES };
