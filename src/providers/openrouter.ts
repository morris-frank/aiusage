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
 * The per-key calls do not add up to the workspace: activity on a deleted key,
 * or on no key at all, is in the management key's own unfiltered `/activity`
 * and on no listed hash (observed 2026-10-31: 151M tokens for the workspace
 * against 93M across its 49 keys). So each workspace is read once unfiltered
 * as well, and what no key accounts for is reported under the workspace with
 * no key — the total is the platform's, the split is as fine as it allows.
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
import { microsToUsd, usdToMicros } from '../money.js';
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
 * `is_provisioning_key` were observed on 2026-07-26 and `workspace_id` on
 * 2026-10-31; all are treated as optional, and the absence of the first two
 * leaves the env var's claim standing.
 */
type KeyProbeResponse = {
  data?: {
    label?: string;
    is_management_key?: boolean;
    is_provisioning_key?: boolean;
    limit_remaining?: number | null;
    workspace_id?: string | null;
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
  workspaceId: string | null;
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
  const workspaceNames = nameWorkspacesFromLabels(usable, enumerated);

  const perKey = await mapWithConcurrency(enumerated, context.concurrency, (entry) =>
    collectKeyActivity(context, entry, workspaceNames),
  );

  // One unfiltered read per workspace: two management keys scoped to the same
  // workspace would otherwise add its total twice.
  const workspaces = new Map<string, Probed>();
  for (const probe of usable) {
    if (probe.kind !== 'management') continue;
    const scope = workspaceScope(probe);
    if (!workspaces.has(scope)) workspaces.set(scope, probe);
  }
  const keyed = new Map<string, UsageRecord[]>();
  enumerated.forEach((entry, index) => {
    // A management key is scoped to one workspace, so every key it listed is in it.
    const scope = workspaceScope(entry.via);
    keyed.set(scope, [...(keyed.get(scope) ?? []), ...(perKey[index]?.records ?? [])]);
  });
  const remainders = await mapWithConcurrency(
    [...workspaces.entries()],
    context.concurrency,
    ([scope, probe]) =>
      collectWorkspaceRemainder(context, probe, keyed.get(scope) ?? [], workspaceNames),
  );

  // An inference key inside a workspace read above, or one a management key
  // enumerated, is already counted; only an unseen one makes its own call.
  const enumeratedLabels = new Set(
    enumerated.map((entry) => entry.row.label).filter((label): label is string => Boolean(label)),
  );
  const inference = usable.filter((probe) => probe.kind === 'inference');
  const standalone = inference.filter(
    (probe) =>
      !(probe.maskedLabel !== null && enumeratedLabels.has(probe.maskedLabel)) &&
      !(probe.workspaceId !== null && workspaces.has(probe.workspaceId)),
  );
  const covered = inference.length - standalone.length;
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
  for (const outcome of [...perKey, ...remainders, ...unscoped]) {
    records.push(...outcome.records);
    diagnostics.push(...outcome.diagnostics);
  }

  const capabilities: ProviderCapabilities = {
    ...DECLARED,
    splitByApiKey: records.some((record) => record.apiKey !== null),
    splitByAccount: enumerated.some((entry) => entry.row.creator_user_id),
    splitByWorkspace: records.some((record) => record.workspace !== null),
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
      probed: {
        credential,
        kind,
        maskedLabel: data.label ?? null,
        workspaceId: data.workspace_id ?? null,
      },
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
function nameWorkspacesFromLabels(
  probes: readonly Probed[],
  enumerated: readonly Enumerated[],
): Map<string, string> {
  const names = new Map<string, string>();
  // The probe names the key's own workspace outright, even when another
  // credential enumerated that workspace's keys first.
  for (const probe of probes) {
    if (probe.kind !== 'management' || !probe.credential.labelled || !probe.workspaceId) continue;
    if (!names.has(probe.workspaceId)) names.set(probe.workspaceId, probe.credential.label);
  }

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

/** A workspace's identity for de-duplication: its id, else the credential's own. */
function workspaceScope(probe: Probed): string {
  return probe.workspaceId ?? `credential:${probe.credential.label}`;
}

/**
 * A management key's unfiltered `/activity` is its whole workspace. Less what
 * the workspace's listed keys already reported, cell by cell, it is the usage
 * no key accounts for — reported with the workspace and without a key.
 */
async function collectWorkspaceRemainder(
  context: CollectContext,
  probe: Probed,
  keyed: readonly UsageRecord[],
  workspaceNames: Map<string, string>,
): Promise<Outcome> {
  const label = probe.credential.label;
  let total: Outcome;
  try {
    const response = await context.http.json<ActivityResponse>(`${BASE_URL}/activity`, {
      headers: authHeaders(probe.credential.secret),
    });
    total = toOutcome(response.data ?? [], context, {
      apiKey: null,
      account: null,
      workspace: probe.workspaceId
        ? { id: probe.workspaceId, name: workspaceNames.get(probe.workspaceId) ?? null }
        : null,
      credentialLabel: label,
      workspaceNamed: Boolean(probe.workspaceId && workspaceNames.has(probe.workspaceId)),
      apiKeyIdMasked: false,
    });
  } catch (error) {
    return {
      records: [],
      diagnostics: [
        {
          provider: 'openrouter',
          level: 'warning',
          code: 'workspace-activity-failed',
          message: `The workspace activity for "${label}" could not be read (${describe(error)}); usage on no listed key is missing from this report.`,
        },
      ],
    };
  }

  const { records, short, tokens, costMicros } = netAgainstKeys(total.records, keyed);

  const diagnostics = [...total.diagnostics];
  if (tokens > 0) {
    const workspace = probe.workspaceId
      ? (workspaceNames.get(probe.workspaceId) ?? probe.workspaceId)
      : label;
    diagnostics.push({
      provider: 'openrouter',
      level: 'info',
      code: 'activity-without-key',
      message: `${tokens} tokens ($${microsToUsd(costMicros).toFixed(2)}) of activity in workspace "${workspace}" are on no listed API key (a deleted key, or use outside one); they are reported under the workspace without a key.`,
    });
  }
  if (short > 0) {
    diagnostics.push({
      provider: 'openrouter',
      level: 'warning',
      code: 'workspace-total-short',
      message: `${short} activity cell(s) for "${label}" add up to less than its keys' own activity; those cells keep the per-key figures only.`,
    });
  }
  return { records, diagnostics };
}

/** The workspace's cells less its keys' cells, and how often keys exceeded them. */
function netAgainstKeys(totals: readonly UsageRecord[], keyed: readonly UsageRecord[]) {
  const claimed = new Map<string, Amounts>();
  for (const record of keyed) addInto(claimed, cellOf(record), amountsOf(record));
  const cells = new Map<string, { template: UsageRecord; amounts: Amounts }>();
  for (const record of totals) {
    const cell = cellOf(record);
    const found = cells.get(cell);
    if (found) found.amounts = plus(found.amounts, amountsOf(record));
    else cells.set(cell, { template: record, amounts: amountsOf(record) });
  }

  const records: UsageRecord[] = [];
  let short = [...claimed.keys()].filter((cell) => !cells.has(cell)).length;
  let tokens = 0;
  let costMicros = 0;
  for (const [cell, { template, amounts }] of cells) {
    const rest = minus(amounts, claimed.get(cell) ?? ZERO_AMOUNTS);
    const values = Object.values(rest);
    // Keys reporting more than their workspace is a contradiction in the
    // platform's own figures; the per-key rows stand and nothing is netted.
    if (values.some((value) => value < 0)) {
      short += 1;
      continue;
    }
    if (values.every((value) => value === 0)) continue;
    tokens += rest.input + rest.output;
    costMicros += rest.cost;
    records.push(remainderRecord(template, rest));
  }

  return { records, short, tokens, costMicros };
}

type Amounts = {
  input: number;
  output: number;
  reasoning: number;
  requests: number;
  cost: number;
  byok: number;
};

const ZERO_AMOUNTS: Amounts = { input: 0, output: 0, reasoning: 0, requests: 0, cost: 0, byok: 0 };

/** One `/activity` row's grain, as far as a record still carries it. */
function cellOf(record: UsageRecord): string {
  return [
    record.bucketStart,
    record.model,
    record.tags.modelPermaslug,
    record.tags.upstreamProvider,
  ].join('\u0000');
}

function amountsOf(record: UsageRecord): Amounts {
  return {
    input: record.tokens.input,
    output: record.tokens.output,
    reasoning: record.tokens.reasoning,
    requests: record.requests ?? 0,
    cost: record.reportedCostMicros ?? 0,
    byok: record.extras.byokCostMicros ?? 0,
  };
}

function plus(a: Amounts, b: Amounts): Amounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    requests: a.requests + b.requests,
    cost: a.cost + b.cost,
    byok: a.byok + b.byok,
  };
}

function minus(a: Amounts, b: Amounts): Amounts {
  return plus(a, {
    input: -b.input,
    output: -b.output,
    reasoning: -b.reasoning,
    requests: -b.requests,
    cost: -b.cost,
    byok: -b.byok,
  });
}

function addInto(map: Map<string, Amounts>, cell: string, amounts: Amounts): void {
  map.set(cell, plus(map.get(cell) ?? ZERO_AMOUNTS, amounts));
}

function remainderRecord(template: UsageRecord, rest: Amounts): UsageRecord {
  const extras: Record<string, number> = {};
  if (template.extras.reasoningTokens !== undefined) extras.reasoningTokens = rest.reasoning;
  if (rest.byok > 0) extras.byokCostMicros = rest.byok;
  return {
    ...template,
    tokens: {
      ...template.tokens,
      input: rest.input,
      output: rest.output,
      reasoning: rest.reasoning,
    },
    requests: template.requests === null ? null : rest.requests,
    reportedCostMicros: template.reportedCostMicros === null ? null : rest.cost,
    extras,
    tags: { ...template.tags, apiKeyAttribution: 'no-listed-key' },
  };
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
