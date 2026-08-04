/**
 * Core domain types.
 *
 * The vocabulary is deliberately narrow and keeps the layers apart:
 *
 *   measurement   → `UsageRecord` (token counts a platform reported to us)
 *   reported cost → `CostRecord` / `UsageRecord.reportedCostMicros` (real money
 *                   the platform billed, at whatever grain it will tell us)
 *   derived cost  → `cost.ts` (tokens × unit price, or reported cost allocated
 *                   across a finer grain) — always labelled with its provenance
 *
 * Nothing in this package silently promotes a derived number to a reported one.
 */

export const PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'ccusage'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Human-facing labels; also the `--provider` aliases accepted on the CLI. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI Platform',
  anthropic: 'Claude Platform',
  ccusage: 'Local agents (ccusage)',
};

/**
 * `ccusage` is a *local* source, not a platform: it reads agent logs on this
 * machine instead of a billing API. It is opt-in (`--local`) because its rows can
 * describe the same traffic a platform already billed — see
 * `providers/ccusage.ts` for the overlap it warns about.
 */
export const LOCAL_PROVIDER_IDS: readonly ProviderId[] = ['ccusage'];

export function isLocalProvider(provider: ProviderId): boolean {
  return LOCAL_PROVIDER_IDS.includes(provider);
}

/**
 * A named thing usage can be attributed to. `name` is null whenever the
 * platform gives us an id but no resolvable label (e.g. a deleted API key).
 */
export type Principal = {
  id: string;
  name: string | null;
};

/**
 * Token counts, normalised across platforms.
 *
 * `input` is *uncached* input only, so `input + cacheRead + cacheCreation` is
 * the total prompt side and no token is counted twice. Platforms that report a
 * cache-inclusive input total (OpenAI) are normalised on the way in.
 *
 * `reasoning` is a subset of `output`, reported separately by OpenRouter. It is
 * carried for visibility and never added into totals.
 */
export type TokenCounts = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
};

export const ZERO_TOKENS: Readonly<TokenCounts> = Object.freeze({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
  reasoning: 0,
});

/**
 * One usage measurement at the finest grain a platform will report: a time
 * bucket, optionally split by model, API key, account and workspace.
 */
export type UsageRecord = {
  provider: ProviderId;
  /** Start of the platform's time bucket, inclusive, UTC ISO-8601. */
  bucketStart: string;
  /** End of the platform's time bucket, exclusive, UTC ISO-8601. */
  bucketEnd: string;
  /** Platform model id, or null when the platform would not split by model. */
  model: string | null;
  /** The user account behind the request (OAuth/console user, org member). */
  account: Principal | null;
  apiKey: Principal | null;
  /** OpenAI project, Anthropic workspace, OpenRouter workspace. */
  workspace: Principal | null;
  tokens: TokenCounts;
  /** Requests in this bucket; null when the platform does not report a count. */
  requests: number | null;
  /**
   * Cost in micro-USD (1e-6 USD) as billed by the platform *at this record's
   * grain*. Null when the platform reports cost only at a coarser grain (then
   * see `CostRecord`) or not at all.
   */
  reportedCostMicros: number | null;
  /**
   * How `reportedCostMicros` may be labelled. Absent means `reported`: the
   * platform billed this amount. `imported` is for a figure restated from
   * another tool's own calculation (ccusage prices local agent logs from the
   * LiteLLM table) — real enough to report, never a billed amount.
   */
  costBasis?: 'reported' | 'imported';
  /** Provider-specific counters kept out of the normalised token fields. */
  extras: Record<string, number>;
  /**
   * Provider-specific string dimensions, verbatim from the platform:
   * `contextWindow` (`0-200k` | `200k-1M`), `serviceTier`, `inferenceGeo`,
   * `upstreamProvider` (OpenRouter's serving provider), `batch`.
   * Priced differently where the price book knows how — never invented.
   */
  tags: Record<string, string>;
};

/**
 * Real money the platform billed, at a grain coarser than `UsageRecord`.
 * Used to scale derived per-key/per-account costs onto the billed total instead
 * of letting a price table disagree with the invoice.
 */
export type CostRecord = {
  provider: ProviderId;
  bucketStart: string;
  bucketEnd: string;
  /** Null when the platform's cost grain does not carry a model. */
  model: string | null;
  workspace: Principal | null;
  amountMicros: number;
  /** Verbatim platform label, kept for provenance (e.g. an OpenAI line item). */
  description: string | null;
  /**
   * Whether this cost may be spread across usage records at its grain. False for
   * charges that are not token consumption at all (web search calls, code
   * execution, session fees) — those are reported as unattributed cost instead of
   * being smeared over token counts they have nothing to do with.
   */
  allocatable: boolean;
};

export type DiagnosticLevel = 'info' | 'warning' | 'error';

/** A machine-readable note about what a collection run could or could not do. */
export type Diagnostic = {
  provider: ProviderId | null;
  level: DiagnosticLevel;
  /** Stable, greppable identifier — safe to branch on. */
  code: string;
  message: string;
};

/**
 * What a provider can actually answer, given the credentials it was handed.
 * Reported honestly per run: a provider with an inference-only OpenRouter key
 * reports `splitByApiKey: false`, it does not pretend otherwise.
 */
export type ProviderCapabilities = {
  usage: boolean;
  reportedCost: boolean;
  splitByModel: boolean;
  splitByApiKey: boolean;
  splitByAccount: boolean;
  splitByWorkspace: boolean;
  livePricing: boolean;
  /** How far back the platform's usage API reaches, in days; null = unbounded. */
  maxLookbackDays: number | null;
};

export const NO_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  usage: false,
  reportedCost: false,
  splitByModel: false,
  splitByApiKey: false,
  splitByAccount: false,
  splitByWorkspace: false,
  livePricing: false,
  maxLookbackDays: null,
});

export type ProviderStatus =
  /** Credentials present, usage collected. */
  | 'ok'
  /** Some requested splits or windows were unavailable; records are partial. */
  | 'partial'
  /** No credentials configured — the provider was not contacted. */
  | 'skipped'
  /**
   * Credentials present, but the platform exposes no usage API to call. No
   * shipped source emits this today; it stays in the vocabulary because it is
   * part of the JSON contract and is what a future usage-less platform must
   * report rather than zero.
   */
  | 'unsupported'
  /** The platform was contacted and refused or failed. */
  | 'error';

export type ProviderIdentity = {
  organizationId?: string;
  organizationName?: string;
  projectId?: string;
  projectName?: string;
  apiKeyId?: string;
  userId?: string;
  /** Local sources: the tool that produced the rows, and which agents it saw. */
  tool?: string;
  agents?: string;
};

export type ProviderResult = {
  provider: ProviderId;
  status: ProviderStatus;
  capabilities: ProviderCapabilities;
  records: UsageRecord[];
  costRecords: CostRecord[];
  diagnostics: Diagnostic[];
  identity: ProviderIdentity | null;
};

/** A closed date window, both ends inclusive, as `YYYY-MM-DD` calendar dates. */
export type DateRange = {
  since: string;
  until: string;
};

export type Granularity = 'daily' | 'weekly' | 'monthly';
