/**
 * OpenAI Platform.
 *
 * Usage: `GET /v1/organization/usage/completions`, grouped by model, API key,
 * project and user — the finest grain OpenAI exposes. Token counts only.
 * Cost: `GET /v1/organization/costs`, which is real billed money but is *not*
 * grouped by model or user; it comes back as line items per project per day.
 *
 * So OpenAI records carry no per-record reported cost. The billed daily
 * project totals are returned as `costRecords`, and `cost.ts` allocates them
 * across models and keys by derived unit cost — labelled `allocated`, so a
 * per-key figure is never mistaken for something OpenAI itself reported.
 *
 * Only *completions* usage is collected. Embeddings, images, audio and moderation
 * usage have their own endpoints and are not included, so their cost shows up as
 * unattributed in reconciliation rather than being silently spread over tokens.
 *
 * Requires an **admin** key: project keys get 401 on `/v1/organization/*`.
 */

import type { OpenAICredentials } from '../config.js';
import { fetchWindow, unixSeconds } from '../dates.js';
import { HttpError } from '../http.js';
import { usdToMicros } from '../money.js';
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

const BASE_URL = 'https://api.openai.com/v1';

type UsageResult = {
  input_tokens?: number;
  input_cached_tokens?: number;
  input_cache_write_tokens?: number;
  input_uncached_tokens?: number;
  input_audio_tokens?: number;
  input_image_tokens?: number;
  output_tokens?: number;
  output_audio_tokens?: number;
  output_image_tokens?: number;
  num_model_requests?: number;
  project_id?: string | null;
  user_id?: string | null;
  api_key_id?: string | null;
  model?: string | null;
  batch?: boolean | null;
  service_tier?: string | null;
};

type UsageBucket = {
  start_time?: number;
  end_time?: number;
  results?: UsageResult[];
};

type UsagePage = {
  data?: UsageBucket[];
  has_more?: boolean;
  next_page?: string | null;
};

type CostResult = {
  amount?: { value?: number; currency?: string };
  line_item?: string | null;
  project_id?: string | null;
  api_key_id?: string | null;
};

type CostPage = {
  data?: { start_time?: number; end_time?: number; results?: CostResult[] }[];
  has_more?: boolean;
  next_page?: string | null;
};

type NamedObject = { id?: string; name?: string | null };
type ListPage<T> = { data?: T[]; has_more?: boolean; last_id?: string | null };

/**
 * Group-by ladder. OpenAI rejects the whole request if a grouping is not
 * permitted, so each rung is tried in turn and the achieved grain is reported
 * back in the run's capabilities.
 */
const GROUP_BY_LADDER: readonly (readonly string[])[] = [
  ['model', 'api_key_id', 'project_id', 'user_id'],
  ['model', 'api_key_id', 'project_id'],
  ['model', 'project_id'],
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

export function createOpenAIProvider(credentials: OpenAICredentials): Provider {
  return {
    id: 'openai',
    declaredCapabilities: DECLARED,
    collect: (context) => collect(context, credentials),
  };
}

async function collect(
  context: CollectContext,
  credentials: OpenAICredentials,
): Promise<ProviderResult> {
  const diagnostics: Diagnostic[] = [];
  const headers: Record<string, string> = { authorization: `Bearer ${credentials.adminKey}` };
  if (credentials.orgId) headers['openai-organization'] = credentials.orgId;

  // Hourly buckets are the only way to group into a non-UTC day correctly.
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
      splitByAccount: groupBy.includes('user_id'),
      splitByWorkspace: groupBy.includes('project_id'),
      reportedCost: costRecords.length > 0,
    };
    diagnostics.push({
      provider: 'openai',
      level: 'info',
      code: 'completions-only',
      message:
        'Only completions usage is collected; embeddings, images, audio and moderation usage are not, so their billed cost appears as unattributed.',
    });

    const status = diagnostics.some((d) => d.level === 'warning') ? 'partial' : 'ok';
    return {
      provider: 'openai',
      status,
      capabilities,
      records,
      costRecords,
      diagnostics,
      identity: credentials.orgId ? { organizationId: credentials.orgId } : {},
    };
  } catch (error) {
    diagnostics.push(toDiagnostic(error));
    return {
      provider: 'openai',
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
          provider: 'openai',
          level: 'warning',
          code: 'group-by-reduced',
          message: `OpenAI rejected the full grouping; usage is split by ${groupBy.length > 0 ? groupBy.join(', ') : 'nothing'} only.`,
        });
      }
      return { buckets, groupBy };
    } catch (error) {
      // Only a rejected *grouping* is worth retrying with less; anything else
      // (auth, rate limit, network) must surface as-is.
      if (!(error instanceof HttpError) || error.status !== 400) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('OpenAI usage request failed for every grouping');
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
      context.http.json<UsagePage>(`${BASE_URL}/organization/usage/completions`, {
        headers,
        query: {
          start_time: unixSeconds(window.start),
          end_time: unixSeconds(window.end),
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
    if (bucket.start_time === undefined || bucket.end_time === undefined) return [];
    const bucketStart = new Date(bucket.start_time * 1000).toISOString();
    const bucketEnd = new Date(bucket.end_time * 1000).toISOString();
    return (bucket.results ?? []).map((row) => toUsageRecord(row, bucketStart, bucketEnd, names));
  });
}

function toUsageRecord(
  row: UsageResult,
  bucketStart: string,
  bucketEnd: string,
  names: NameMaps,
): UsageRecord {
  const cacheRead = row.input_cached_tokens ?? 0;
  // `input_tokens` includes cached input; prefer the explicit uncached count.
  const uncached = row.input_uncached_tokens ?? Math.max((row.input_tokens ?? 0) - cacheRead, 0);

  const extras: Record<string, number> = {};
  for (const [key, value] of [
    ['inputAudioTokens', row.input_audio_tokens],
    ['inputImageTokens', row.input_image_tokens],
    ['outputAudioTokens', row.output_audio_tokens],
    ['outputImageTokens', row.output_image_tokens],
  ] as const) {
    if (typeof value === 'number' && value > 0) extras[key] = value;
  }

  const tags: Record<string, string> = {};
  if (typeof row.batch === 'boolean') tags.batch = String(row.batch);
  if (row.service_tier) tags.serviceTier = row.service_tier;

  return {
    provider: 'openai',
    bucketStart,
    bucketEnd,
    model: row.model ?? null,
    account: principal(row.user_id, names.users),
    apiKey: principal(row.api_key_id, names.apiKeys),
    workspace: principal(row.project_id, names.projects),
    tokens: {
      input: uncached,
      output: row.output_tokens ?? 0,
      cacheCreation: row.input_cache_write_tokens ?? 0,
      cacheRead,
      reasoning: 0,
    },
    requests: row.num_model_requests ?? null,
    // The usage endpoint carries no money; see `costRecords`.
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
    const buckets = await paginate<CostPage, NonNullable<CostPage['data']>[number]>({
      fetchPage: (page) =>
        context.http.json<CostPage>(`${BASE_URL}/organization/costs`, {
          headers,
          query: {
            start_time: unixSeconds(window.start),
            end_time: unixSeconds(window.end),
            // The costs endpoint supports daily buckets only.
            bucket_width: '1d',
            limit: 180,
            group_by: ['project_id', 'line_item'],
            ...(page ? { page } : {}),
          },
        }),
      items: (page) => page.data ?? [],
      nextCursor: pageCursor,
    });

    for (const bucket of buckets) {
      if (bucket.start_time === undefined || bucket.end_time === undefined) continue;
      for (const row of bucket.results ?? []) {
        const record = toCostRecord(row, bucket.start_time, bucket.end_time);
        // Converting currencies would invent an exchange rate. Refuse.
        if (record === 'non-usd') nonUsdSeen = true;
        else if (record !== null) records.push(record);
      }
    }
  } catch (error) {
    diagnostics.push({
      provider: 'openai',
      level: 'warning',
      code: 'costs-unavailable',
      message: `OpenAI billed cost could not be read (${describe(error)}); costs shown for OpenAI are derived from token prices.`,
    });
    return [];
  }

  if (nonUsdSeen) {
    diagnostics.push({
      provider: 'openai',
      level: 'warning',
      code: 'non-usd-cost',
      message:
        'Some OpenAI cost rows are not denominated in USD and were skipped rather than converted.',
    });
  }
  return records;
}

/** `'non-usd'` distinguishes "refused to convert" from "nothing to record". */
function toCostRecord(
  row: CostResult,
  startTime: number,
  endTime: number,
): CostRecord | 'non-usd' | null {
  const value = row.amount?.value;
  if (typeof value !== 'number') return null;
  if ((row.amount?.currency ?? 'usd').toLowerCase() !== 'usd') return 'non-usd';

  return {
    provider: 'openai',
    bucketStart: new Date(startTime * 1000).toISOString(),
    bucketEnd: new Date(endTime * 1000).toISOString(),
    // Line items name a model in prose, not a model id — parsing that string
    // would be a guess, so cost stays at project-day grain.
    model: null,
    workspace: row.project_id ? { id: row.project_id, name: null } : null,
    amountMicros: usdToMicros(value),
    description: row.line_item ?? null,
    // Line items are opaque prose, so every OpenAI cost row is treated as
    // allocatable: the platform total stays right, and per-model / per-key
    // figures are labelled `allocated`.
    allocatable: true,
  };
}

type NameMaps = {
  users: Map<string, string>;
  projects: Map<string, string>;
  apiKeys: Map<string, string>;
};

/**
 * Ids are what usage rows carry; names are what a report needs to be readable.
 * Every lookup is best-effort — a failed name fetch degrades labels, never data.
 */
async function fetchNames(
  context: CollectContext,
  headers: Record<string, string>,
  diagnostics: Diagnostic[],
): Promise<NameMaps> {
  const users = await listNamed(context, headers, `${BASE_URL}/organization/users`, diagnostics);
  const projects = await listNamed(
    context,
    headers,
    `${BASE_URL}/organization/projects`,
    diagnostics,
  );

  const apiKeys = new Map<string, string>();
  for (const projectId of projects.keys()) {
    const keys = await listNamed(
      context,
      headers,
      `${BASE_URL}/organization/projects/${projectId}/api_keys`,
      diagnostics,
    );
    for (const [id, name] of keys) apiKeys.set(id, name);
  }
  return { users, projects, apiKeys };
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
      fetchPage: (after) =>
        context.http.json<ListPage<NamedObject>>(url, {
          headers,
          query: { limit: 100, ...(after ? { after } : {}) },
        }),
      items: (page) => page.data ?? [],
      nextCursor: idCursor,
    });
    for (const item of items) {
      if (item.id && item.name) found.set(item.id, item.name);
    }
  } catch (error) {
    diagnostics.push({
      provider: 'openai',
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
      provider: 'openai',
      level: 'error',
      code: 'auth-failed',
      message: `OpenAI rejected the credentials (HTTP ${error.status}). /v1/organization/* needs an admin key (sk-admin-…), not a project key.`,
    };
  }
  return {
    provider: 'openai',
    level: 'error',
    code: 'collect-failed',
    message: `OpenAI usage could not be collected: ${describe(error)}`,
  };
}

export { DECLARED as OPENAI_CAPABILITIES };
