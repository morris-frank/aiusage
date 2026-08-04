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
 * A management key is scoped to **one workspace**, so credentials are a list:
 * one key per workspace (`OPENROUTER_MANAGEMENT_KEY_<LABEL>`). Every key is
 * probed with `GET /api/v1/key` first, because which env var a key was pasted
 * into is a claim, and the platform is the authority.
 *
 * Account attribution is therefore *derived from key ownership*
 * (`creator_user_id`), tagged as such on every record. OpenRouter does not
 * attribute an activity row to the member who made the request.
 */

import { mapWithConcurrency } from '../concurrency.js';
import type { OpenRouterCredentials, OpenRouterKey } from '../config.js';
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
  /**
   * A UTC day. Observed 2026-07-26 as `"2026-07-25 00:00:00"` rather than the
   * bare `YYYY-MM-DD` the reference implies, so it is always normalised.
   */
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
  /** Masked form of the key itself, e.g. `sk-or-v1-7a4...dda`. */
  label?: string | null;
  disabled?: boolean;
  created_at?: string;
  creator_user_id?: string | null;
  workspace_id?: string | null;
};

type KeysResponse = { data?: KeyRow[] };

/**
 * `GET /api/v1/key` describes the calling key itself. `is_management_key` /
 * `is_provisioning_key` were observed on 2026-07-26; both are treated as
 * optional, and their absence leaves the env var's claim standing.
 */
type KeyProbeResponse = {
  data?: {
    label?: string;
    is_management_key?: boolean;
    is_provisioning_key?: boolean;
    limit_remaining?: number | null;
  };
};

const DECLARED: ProviderCapabilities = {
  usage: true,
  reportedCost: true,
  splitByModel: true,
  splitByApiKey: true,
  splitByAccount: true,
  splitByWorkspace: true,
  livePricing: true,
  // `/activity` returns one row per UTC *day* and takes no bucket-width
  // parameter (checked against the reference 2026-08-04), so OpenRouter usage
  // cannot be placed inside a day at all — not even when asked.
  hourly: false,
  maxLookbackDays: OPENROUTER_LOOKBACK_DAYS,
};

export function createOpenRouterProvider(credentials: OpenRouterCredentials): Provider {
  return {
    id: 'openrouter',
    declaredCapabilities: DECLARED,
    collect: (context) => collect(context, credentials),
  };
}

/** A credential after the platform has told us what it actually is. */
type Probed = {
  credential: OpenRouterKey;
  kind: 'management' | 'inference';
  /** Masked key label, when the probe returned one. */
  maskedLabel: string | null;
};

async function collect(
  context: CollectContext,
  credentials: OpenRouterCredentials,
): Promise<ProviderResult> {
  const diagnostics: Diagnostic[] = [];

  if (credentials.keys.length === 0) {
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

  const probes = await mapWithConcurrency(credentials.keys, context.concurrency, (credential) =>
    probeKey(context, credential),
  );
  const usable: Probed[] = [];
  for (const probe of probes) {
    diagnostics.push(...probe.diagnostics);
    if (probe.probed) usable.push(probe.probed);
  }

  if (usable.length === 0) {
    return result('error', { ...DECLARED, usage: false }, [], diagnostics);
  }

  if (!usable.some((probe) => probe.kind === 'management')) {
    diagnostics.push({
      provider: 'openrouter',
      level: 'info',
      code: 'no-management-key',
      message:
        'Using inference keys only: each key sees just its own activity, and usage cannot be split by account. Set OPENROUTER_MANAGEMENT_KEY (one per workspace) for org-wide splits.',
    });
  }

  const enumerated = await enumerateKeys(context, usable, diagnostics);
  const workspaceNames = nameWorkspacesFromLabels(enumerated);

  const perKey = await mapWithConcurrency(enumerated, context.concurrency, (entry) =>
    collectKeyActivity(context, entry, workspaceNames),
  );

  // An inference credential whose key a management credential already enumerated
  // would be counted twice, so it only makes its own call when it is unseen. A
  // management credential that enumerated nothing (refused, or an empty
  // workspace) falls back to its own activity rather than contributing nothing.
  const enumeratedLabels = new Set(
    enumerated.map((entry) => entry.row.label).filter((label): label is string => Boolean(label)),
  );
  const enumeratedVia = new Set(enumerated.map((entry) => entry.via.credential.label));
  const inference = usable.filter((probe) => probe.kind === 'inference');
  const standalone = [
    ...inference.filter(
      (probe) => !(probe.maskedLabel !== null && enumeratedLabels.has(probe.maskedLabel)),
    ),
    ...usable.filter(
      (probe) => probe.kind === 'management' && !enumeratedVia.has(probe.credential.label),
    ),
  ];
  const covered =
    inference.length - standalone.filter((probe) => probe.kind === 'inference').length;
  if (covered > 0) {
    diagnostics.push({
      provider: 'openrouter',
      level: 'info',
      code: 'key-already-enumerated',
      message: `${covered} inference key(s) are also visible through a management key; their activity is read once, not twice.`,
    });
  }

  const unscoped = await mapWithConcurrency(standalone, context.concurrency, (probe) =>
    collectUnscoped(context, probe),
  );

  const records: UsageRecord[] = [];
  for (const outcome of [...perKey, ...unscoped]) {
    records.push(...outcome.records);
    diagnostics.push(...outcome.diagnostics);
  }

  const capabilities: ProviderCapabilities = {
    ...DECLARED,
    splitByApiKey: records.some((record) => record.apiKey !== null),
    splitByAccount: enumerated.some((entry) => entry.row.creator_user_id),
    splitByWorkspace: enumerated.some((entry) => entry.row.workspace_id),
  };
  const failed = diagnostics.some((diagnostic) => diagnostic.level === 'error');
  const status = failed
    ? 'error'
    : diagnostics.some((diagnostic) => diagnostic.level === 'warning')
      ? 'partial'
      : 'ok';
  return result(status, capabilities, records, diagnostics);
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

async function probeKey(
  context: CollectContext,
  credential: OpenRouterKey,
): Promise<{ probed: Probed | null; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  try {
    const response = await context.http.json<KeyProbeResponse>(`${BASE_URL}/key`, {
      headers: authHeaders(credential.secret),
    });
    const data = response.data ?? {};
    const isManagement = data.is_management_key === true || data.is_provisioning_key === true;
    const kind: Probed['kind'] =
      data.is_management_key === undefined && data.is_provisioning_key === undefined
        ? credential.declaredKind
        : isManagement
          ? 'management'
          : 'inference';

    if (kind !== credential.declaredKind) {
      diagnostics.push({
        provider: 'openrouter',
        level: kind === 'management' ? 'info' : 'warning',
        code: 'key-kind-mismatch',
        message:
          kind === 'management'
            ? `The key labelled "${credential.label}" is a management key even though it was set as an inference key; using it to enumerate keys.`
            : `The key labelled "${credential.label}" was set as a management key but OpenRouter reports it is not; it can only report its own activity.`,
      });
    }
    return {
      probed: { credential, kind, maskedLabel: data.label ?? null },
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      error instanceof HttpError && error.isAuthFailure
        ? {
            provider: 'openrouter',
            level: 'error',
            code: 'auth-failed',
            message: `OpenRouter rejected the key labelled "${credential.label}" (HTTP ${error.status}); its usage is missing from this report.`,
          }
        : {
            provider: 'openrouter',
            level: 'error',
            code: 'collect-failed',
            message: `The key labelled "${credential.label}" could not be verified (${describe(error)}); its usage is missing from this report.`,
          },
    );
    return { probed: null, diagnostics };
  }
}

/** A key row, plus which credential is allowed to read its activity. */
type Enumerated = { row: KeyRow & { hash: string }; via: Probed };

async function enumerateKeys(
  context: CollectContext,
  probes: readonly Probed[],
  diagnostics: Diagnostic[],
): Promise<Enumerated[]> {
  const management = probes.filter((probe) => probe.kind === 'management');
  const pages = await mapWithConcurrency(management, context.concurrency, (probe) =>
    listKeys(context, probe),
  );

  const enumerated: Enumerated[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const page of pages) {
    diagnostics.push(...page.diagnostics);
    for (const row of page.rows) {
      // Two management keys can see the same workspace; the first to report a
      // hash owns it, or its activity would be added twice.
      if (seen.has(row.hash)) {
        duplicates += 1;
        continue;
      }
      seen.add(row.hash);
      enumerated.push({ row, via: page.probe });
    }
  }
  if (duplicates > 0) {
    diagnostics.push({
      provider: 'openrouter',
      level: 'info',
      code: 'key-scope-overlap',
      message: `${duplicates} API key(s) are visible to more than one management key; each is counted once.`,
    });
  }
  return enumerated;
}

async function listKeys(
  context: CollectContext,
  probe: Probed,
): Promise<{ probe: Probed; rows: (KeyRow & { hash: string })[]; diagnostics: Diagnostic[] }> {
  const rows: (KeyRow & { hash: string })[] = [];
  const pageSize = 100;
  try {
    for (let offset = 0; ; offset += pageSize) {
      const response = await context.http.json<KeysResponse>(`${BASE_URL}/keys`, {
        headers: authHeaders(probe.credential.secret),
        query: { include_disabled: true, offset },
      });
      const page = response.data ?? [];
      for (const row of page) {
        if (typeof row.hash === 'string') rows.push({ ...row, hash: row.hash });
      }
      if (page.length < pageSize) break;
    }
    return { probe, rows, diagnostics: [] };
  } catch (error) {
    return {
      probe,
      rows: [],
      diagnostics: [
        {
          provider: 'openrouter',
          level: 'warning',
          code: 'keys-unavailable',
          message: `Could not list the API keys for "${probe.credential.label}" (${describe(error)}); its workspace is missing from the per-key split.`,
        },
      ],
    };
  }
}

/**
 * A workspace id is all OpenRouter gives us — there is no workspace-name API. A
 * *labelled* management key that sees exactly one workspace names it, since that
 * label is the operator's own name for the workspace they scoped the key to.
 */
function nameWorkspacesFromLabels(enumerated: readonly Enumerated[]): Map<string, string> {
  const byCredential = new Map<string, { label: string; workspaces: Set<string> }>();
  for (const entry of enumerated) {
    if (!entry.via.credential.labelled) continue;
    const workspaceId = entry.row.workspace_id;
    if (!workspaceId) continue;
    const key = entry.via.credential.label;
    const found = byCredential.get(key) ?? { label: key, workspaces: new Set<string>() };
    found.workspaces.add(workspaceId);
    byCredential.set(key, found);
  }

  const names = new Map<string, string>();
  for (const { label, workspaces } of byCredential.values()) {
    if (workspaces.size !== 1) continue;
    const [workspaceId] = workspaces;
    if (workspaceId && !names.has(workspaceId)) names.set(workspaceId, label);
  }
  return names;
}

type Outcome = { records: UsageRecord[]; diagnostics: Diagnostic[] };

async function collectKeyActivity(
  context: CollectContext,
  entry: Enumerated,
  workspaceNames: Map<string, string>,
): Promise<Outcome> {
  const { row } = entry;
  try {
    const response = await context.http.json<ActivityResponse>(`${BASE_URL}/activity`, {
      headers: authHeaders(entry.via.credential.secret),
      query: { api_key_hash: row.hash },
    });
    return toOutcome(response.data ?? [], context, {
      apiKey: { id: row.hash, name: row.name ?? row.label ?? null },
      account: row.creator_user_id ? { id: row.creator_user_id, name: null } : null,
      workspace: row.workspace_id
        ? { id: row.workspace_id, name: workspaceNames.get(row.workspace_id) ?? null }
        : null,
      credentialLabel: entry.via.credential.label,
      workspaceNamed: Boolean(row.workspace_id && workspaceNames.has(row.workspace_id)),
      apiKeyIdMasked: false,
    });
  } catch (error) {
    return {
      records: [],
      diagnostics: [
        {
          provider: 'openrouter',
          level: 'warning',
          code: 'activity-key-failed',
          message: `Activity for key ${row.name ?? row.hash.slice(0, 8)} could not be read (${describe(error)}); its usage is missing from this report.`,
        },
      ],
    };
  }
}

async function collectUnscoped(context: CollectContext, probe: Probed): Promise<Outcome> {
  try {
    const response = await context.http.json<ActivityResponse>(`${BASE_URL}/activity`, {
      headers: authHeaders(probe.credential.secret),
    });
    // Without a management key the only identifier OpenRouter returns for the
    // caller is the masked key label. It is what the platform said, so it is
    // used as the id — and tagged, because it is not the key hash.
    return toOutcome(response.data ?? [], context, {
      apiKey: probe.maskedLabel
        ? { id: probe.maskedLabel, name: probe.credential.label }
        : { id: `credential:${probe.credential.label}`, name: probe.credential.label },
      account: null,
      workspace: null,
      credentialLabel: probe.credential.label,
      workspaceNamed: false,
      apiKeyIdMasked: true,
    });
  } catch (error) {
    return {
      records: [],
      diagnostics: [
        {
          provider: 'openrouter',
          level: 'error',
          code: 'collect-failed',
          message: `OpenRouter activity for the key labelled "${probe.credential.label}" could not be collected: ${describe(error)}`,
        },
      ],
    };
  }
}

type Attribution = {
  apiKey: Principal | null;
  account: Principal | null;
  workspace: Principal | null;
  credentialLabel: string;
  workspaceNamed: boolean;
  apiKeyIdMasked: boolean;
};

function toOutcome(
  rows: readonly ActivityRow[],
  context: CollectContext,
  attribution: Attribution,
): Outcome {
  const records: UsageRecord[] = [];
  let unparseable = 0;

  for (const row of rows) {
    const day = utcDayOf(row.date);
    if (day === null) {
      // A row whose bucket cannot be read is dropped, not guessed at, and the
      // count is reported: an unreadable date is missing usage, not zero usage.
      if (row.date !== undefined) unparseable += 1;
      continue;
    }
    if (day < context.range.since || day > context.range.until) continue;
    records.push(toRecord(row, day, attribution));
  }

  const diagnostics: Diagnostic[] =
    unparseable > 0
      ? [
          {
            provider: 'openrouter',
            level: 'warning',
            code: 'bucket-unparseable',
            message: `${unparseable} OpenRouter activity row(s) for "${attribution.credentialLabel}" carried a date this tool could not read; they are missing from this report.`,
          },
        ]
      : [];
  return { records, diagnostics };
}

/**
 * The UTC day of an activity row. `/activity` returns
 * `"YYYY-MM-DD HH:mm:ss"` (UTC midnight) as of 2026-07-26; a bare `YYYY-MM-DD`
 * and a full ISO instant are both accepted so a format change does not silently
 * drop every row.
 */
function utcDayOf(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(value.trim());
  return match?.[1] ?? null;
}

function toRecord(row: ActivityRow, day: string, attribution: Attribution): UsageRecord {
  const extras: Record<string, number> = {};
  if (typeof row.reasoning_tokens === 'number') extras.reasoningTokens = row.reasoning_tokens;
  // BYOK spend leaves OpenRouter's credit balance untouched, so it is tracked
  // separately instead of being folded into the reported cost.
  if (typeof row.byok_usage_inference === 'number' && row.byok_usage_inference > 0) {
    extras.byokCostMicros = usdToMicros(row.byok_usage_inference);
  }

  const tags: Record<string, string> = { credential: attribution.credentialLabel };
  if (row.provider_name) tags.upstreamProvider = row.provider_name;
  if (row.model_permaslug) tags.modelPermaslug = row.model_permaslug;
  if (attribution.account) tags.accountAttribution = 'key-creator';
  if (attribution.workspaceNamed) tags.workspaceNameSource = 'credential-label';
  if (attribution.apiKeyIdMasked) tags.apiKeyIdSource = 'masked-label';

  return {
    provider: 'openrouter',
    bucketStart: dayStartUtc(day).toISOString(),
    bucketEnd: dayEndUtc(day).toISOString(),
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
