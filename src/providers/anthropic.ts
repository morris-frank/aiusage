/**
 * Claude Platform (Anthropic).
 *
 * Usage: `GET /v1/organizations/usage_report/messages`, the richest of the four
 * platforms — it splits by model, API key, user account, workspace, service tier
 * and context window, and reports cache creation (5m/1h) and cache reads
 * separately, which maps onto `TokenCounts` without loss.
 *
 * Cost: `GET /v1/organizations/cost_report`, in **cents** as decimal strings,
 * grouped by description (which carries model + token type) and workspace. Token
 * costs are allocated down to keys and accounts; non-token charges (web search,
 * code execution, session fees) are kept unattributed rather than spread over
 * token counts.
 *
 * Requires an Admin API key (`sk-ant-admin…`) or an org-scoped OAuth token.
 */

import type { AnthropicCredentials } from '../config.js';
import { fetchWindow } from '../dates.js';
import { HttpError } from '../http.js';
import { centsStringToMicros } from '../money.js';
import type {
  CostRecord,
  Diagnostic,
  Principal,
  ProviderCapabilities,
  ProviderResult,
  UsageRecord,
} from '../types.js';
import { idCursor, pageCursor, paginate } from './pagination.js';
import type { CollectContext, Provider } from './types.js';

const BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

type CacheCreation = {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
};

type UsageResult = {
  account_id?: string | null;
  api_key_id?: string | null;
  service_account_id?: string | null;
  workspace_id?: string | null;
  model?: string | null;
  context_window?: string | null;
  service_tier?: string | null;
  inference_geo?: string | null;
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: CacheCreation | null;
  output_tokens?: number;
  server_tool_use?: { web_search_requests?: number } | null;
};

type UsageBucket = { starting_at?: string; ending_at?: string; results?: UsageResult[] };
type UsagePage = { data?: UsageBucket[]; has_more?: boolean; next_page?: string | null };

type CostResult = {
  amount?: string;
  currency?: string;
  cost_type?: string | null;
  description?: string | null;
  model?: string | null;
  token_type?: string | null;
  workspace_id?: string | null;
};

type CostBucket = { starting_at?: string; ending_at?: string; results?: CostResult[] };
type CostPage = { data?: CostBucket[]; has_more?: boolean; next_page?: string | null };

type NamedObject = { id?: string; name?: string | null };
type ListPage<T> = { data?: T[]; has_more?: boolean; last_id?: string | null };

/** Ladder of groupings, most detailed first; a 400 falls back a rung. */
const GROUP_BY_LADDER: readonly (readonly string[])[] = [
  ['model', 'api_key_id', 'account_id', 'workspace_id', 'context_window', 'service_tier'],
  ['model', 'api_key_id', 'account_id', 'workspace_id'],
  ['model', 'api_key_id', 'workspace_id'],
  ['model', 'workspace_id'],
  ['model'],
  [],
];

const DECLARED: ProviderCapabilities = {
  usage: true,
  reportedCost: true,
  splitByModel: true,
  splitByApiKey: true,
  splitByAccount: true,
  splitByWorkspace: true,
  livePricing: false,
  maxLookbackDays: null,
};

export function createAnthropicProvider(credentials: AnthropicCredentials): Provider {
  return {
    id: 'anthropic',
    declaredCapabilities: DECLARED,
    collect: (context) => collect(context, credentials),
  };
}

/**
 * Admin API keys authenticate with `x-api-key`; org-scoped OAuth tokens use
 * `Authorization: Bearer`. Both are accepted, chosen by key shape.
 */
export function authHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
  if (key.startsWith('sk-ant-')) headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  return headers;
}

async function collect(
  context: CollectContext,
  credentials: AnthropicCredentials,
): Promise<ProviderResult> {
  const diagnostics: Diagnostic[] = [];
  const headers = authHeaders(credentials.adminKey);
  const bucketWidth = context.timeZone === 'UTC' ? '1d' : '1h';
  const window = fetchWindow(context.range, context.timeZone);

  try {
    const { buckets, groupBy } = await fetchUsage(
      context,
      headers,
      bucketWidth,
      window,
      diagnostics,
    );
    const names = await fetchNames(context, headers, diagnostics);
    const records = toUsageRecords(buckets, names);
    const costRecords = await fetchCosts(context, headers, window, diagnostics);

    const capabilities: ProviderCapabilities = {
      ...DECLARED,
      splitByModel: groupBy.includes('model'),
      splitByApiKey: groupBy.includes('api_key_id'),
      splitByAccount: groupBy.includes('account_id'),
      splitByWorkspace: groupBy.includes('workspace_id'),
      reportedCost: costRecords.length > 0,
    };
    const status = diagnostics.some((d) => d.level === 'warning') ? 'partial' : 'ok';
    return {
      provider: 'anthropic',
      status,
      capabilities,
      records,
      costRecords,
      diagnostics,
      identity: {},
    };
  } catch (error) {
    diagnostics.push(toDiagnostic(error));
    return {
      provider: 'anthropic',
      status: 'error',
      capabilities: { ...DECLARED, usage: false, reportedCost: false },
      records: [],
      costRecords: [],
      diagnostics,
      identity: null,
    };
  }
}

async function fetchUsage(
  context: CollectContext,
  headers: Record<string, string>,
  bucketWidth: string,
  window: { start: Date; end: Date },
  diagnostics: Diagnostic[],
): Promise<{ buckets: UsageBucket[]; groupBy: readonly string[] }> {
  let lastError: unknown;
  for (const groupBy of GROUP_BY_LADDER) {
    try {
      const buckets = await paginateUsage(context, headers, bucketWidth, window, groupBy);
      if (groupBy !== GROUP_BY_LADDER[0]) {
        diagnostics.push({
          provider: 'anthropic',
          level: 'warning',
          code: 'group-by-reduced',
          message: `Anthropic rejected the full grouping; usage is split by ${groupBy.length > 0 ? groupBy.join(', ') : 'nothing'} only.`,
        });
      }
      return { buckets, groupBy };
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('Anthropic usage request failed for every grouping');
}

async function paginateUsage(
  context: CollectContext,
  headers: Record<string, string>,
  bucketWidth: string,
  window: { start: Date; end: Date },
  groupBy: readonly string[],
): Promise<UsageBucket[]> {
  return paginate<UsagePage, UsageBucket>({
    fetchPage: (page) =>
      context.http.json<UsagePage>(`${BASE_URL}/organizations/usage_report/messages`, {
        headers,
        // Anthropic expects repeated `group_by[]` parameters.
        arrayFormat: 'bracket',
        query: {
          starting_at: window.start.toISOString(),
          ending_at: window.end.toISOString(),
          bucket_width: bucketWidth,
          // Daily buckets cap at 31 per page, hourly at 168.
          limit: bucketWidth === '1d' ? 31 : 168,
          ...(groupBy.length > 0 ? { group_by: groupBy } : {}),
          ...(page ? { page } : {}),
        },
      }),
    items: (page) => page.data ?? [],
    nextCursor: pageCursor,
  });
}

function toUsageRecords(buckets: readonly UsageBucket[], names: NameMaps): UsageRecord[] {
  return buckets.flatMap((bucket) => {
    if (!bucket.starting_at || !bucket.ending_at) return [];
    const bucketStart = new Date(bucket.starting_at).toISOString();
    const bucketEnd = new Date(bucket.ending_at).toISOString();
    return (bucket.results ?? []).map((row) => toUsageRecord(row, bucketStart, bucketEnd, names));
  });
}

function toUsageRecord(
  row: UsageResult,
  bucketStart: string,
  bucketEnd: string,
  names: NameMaps,
): UsageRecord {
  const extras: Record<string, number> = {};
  const webSearch = row.server_tool_use?.web_search_requests ?? 0;
  if (webSearch > 0) extras.webSearchRequests = webSearch;
  if (row.cache_creation?.ephemeral_1h_input_tokens) {
    extras.cacheCreation1hTokens = row.cache_creation.ephemeral_1h_input_tokens;
  }

  const tags: Record<string, string> = {};
  if (row.context_window) tags.contextWindow = row.context_window;
  if (row.service_tier) tags.serviceTier = row.service_tier;
  if (row.inference_geo) tags.inferenceGeo = row.inference_geo;
  // A service account is an account for attribution purposes; keep the
  // distinction visible in the tag rather than merging the id spaces.
  if (!row.account_id && row.service_account_id) tags.accountType = 'service_account';

  return {
    provider: 'anthropic',
    bucketStart,
    bucketEnd,
    model: row.model ?? null,
    account: principal(row.account_id ?? row.service_account_id ?? null, names.users),
    apiKey: principal(row.api_key_id, names.apiKeys),
    workspace: principal(row.workspace_id, names.workspaces),
    tokens: {
      input: row.uncached_input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      cacheCreation:
        (row.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
        (row.cache_creation?.ephemeral_1h_input_tokens ?? 0),
      cacheRead: row.cache_read_input_tokens ?? 0,
      reasoning: 0,
    },
    // The usage report counts tokens, not requests.
    requests: null,
    reportedCostMicros: null,
    extras,
    tags,
  };
}

async function fetchCosts(
  context: CollectContext,
  headers: Record<string, string>,
  window: { start: Date; end: Date },
  diagnostics: Diagnostic[],
): Promise<CostRecord[]> {
  const records: CostRecord[] = [];
  let nonUsdSeen = false;

  try {
    const buckets = await paginate<CostPage, CostBucket>({
      fetchPage: (page) =>
        context.http.json<CostPage>(`${BASE_URL}/organizations/cost_report`, {
          headers,
          arrayFormat: 'bracket',
          query: {
            starting_at: window.start.toISOString(),
            ending_at: window.end.toISOString(),
            // The cost report supports daily buckets only.
            bucket_width: '1d',
            limit: 31,
            group_by: ['description', 'workspace_id'],
            ...(page ? { page } : {}),
          },
        }),
      items: (page) => page.data ?? [],
      nextCursor: pageCursor,
    });

    for (const bucket of buckets) {
      if (!bucket.starting_at || !bucket.ending_at) continue;
      for (const row of bucket.results ?? []) {
        const record = toCostRecord(row, bucket.starting_at, bucket.ending_at);
        // Converting currencies would invent an exchange rate. Refuse.
        if (record === 'non-usd') nonUsdSeen = true;
        else if (record !== null) records.push(record);
      }
    }
  } catch (error) {
    diagnostics.push({
      provider: 'anthropic',
      level: 'warning',
      code: 'costs-unavailable',
      message: `Anthropic billed cost could not be read (${describe(error)}); costs shown for Anthropic are derived from token prices.`,
    });
    return [];
  }

  if (nonUsdSeen) {
    diagnostics.push({
      provider: 'anthropic',
      level: 'warning',
      code: 'non-usd-cost',
      message:
        'Some Anthropic cost rows are not denominated in USD and were skipped rather than converted.',
    });
  }
  return records;
}

/** `'non-usd'` distinguishes "refused to convert" from "nothing to record". */
function toCostRecord(
  row: CostResult,
  startingAt: string,
  endingAt: string,
): CostRecord | 'non-usd' | null {
  if (row.amount === undefined) return null;
  if ((row.currency ?? 'USD').toUpperCase() !== 'USD') return 'non-usd';
  const amountMicros = centsStringToMicros(row.amount);
  if (amountMicros === null) return null;

  return {
    provider: 'anthropic',
    bucketStart: new Date(startingAt).toISOString(),
    bucketEnd: new Date(endingAt).toISOString(),
    model: row.model ?? null,
    workspace: row.workspace_id ? { id: row.workspace_id, name: null } : null,
    amountMicros,
    description: row.description ?? row.cost_type ?? null,
    // Only token charges belong on token counts.
    allocatable: row.cost_type === 'tokens' && Boolean(row.model),
  };
}

type NameMaps = {
  users: Map<string, string>;
  apiKeys: Map<string, string>;
  workspaces: Map<string, string>;
};

async function fetchNames(
  context: CollectContext,
  headers: Record<string, string>,
  diagnostics: Diagnostic[],
): Promise<NameMaps> {
  const [users, apiKeys, workspaces] = await Promise.all([
    listNamed(context, headers, `${BASE_URL}/organizations/users`, diagnostics),
    listNamed(context, headers, `${BASE_URL}/organizations/api_keys`, diagnostics),
    listNamed(context, headers, `${BASE_URL}/organizations/workspaces`, diagnostics),
  ]);
  return { users, apiKeys, workspaces };
}

async function listNamed(
  context: CollectContext,
  headers: Record<string, string>,
  url: string,
  diagnostics: Diagnostic[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  try {
    const items = await paginate<ListPage<NamedObject>, NamedObject>({
      fetchPage: (afterId) =>
        context.http.json<ListPage<NamedObject>>(url, {
          headers,
          query: { limit: 1000, ...(afterId ? { after_id: afterId } : {}) },
        }),
      items: (page) => page.data ?? [],
      nextCursor: idCursor,
    });
    for (const item of items) {
      if (item.id && item.name) found.set(item.id, item.name);
    }
  } catch (error) {
    diagnostics.push({
      provider: 'anthropic',
      level: 'info',
      code: 'names-unavailable',
      message: `Could not resolve names from ${url.replace(BASE_URL, '')} (${describe(error)}); ids are shown instead.`,
    });
  }
  return found;
}

function principal(id: string | null | undefined, names: Map<string, string>): Principal | null {
  if (!id) return null;
  return { id, name: names.get(id) ?? null };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDiagnostic(error: unknown): Diagnostic {
  if (error instanceof HttpError && error.isAuthFailure) {
    return {
      provider: 'anthropic',
      level: 'error',
      code: 'auth-failed',
      message: `Anthropic rejected the credentials (HTTP ${error.status}). /v1/organizations/* needs an Admin API key (sk-ant-admin…), not a normal API key.`,
    };
  }
  return {
    provider: 'anthropic',
    level: 'error',
    code: 'collect-failed',
    message: `Anthropic usage could not be collected: ${describe(error)}`,
  };
}

export { DECLARED as ANTHROPIC_CAPABILITIES };
