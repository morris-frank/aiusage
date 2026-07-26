/**
 * Turns measurements into money, and says exactly how.
 *
 * Five provenances, in descending order of authority — every costed record
 * carries the one that applies to it:
 *
 *   reported    the platform billed this exact record (OpenRouter activity rows)
 *   allocated   the platform billed a coarser bucket (a project-day, a
 *               model-day) and that real amount was distributed across the
 *               records inside it, in proportion to their derived cost
 *   imported    another tool stated this figure and calculated it itself
 *               (ccusage, pricing local agent logs from the LiteLLM table). No
 *               platform billed it: for subscription-billed agents it is an
 *               API-equivalent, not money spent
 *   calculated  no billed figure was available; tokens × published unit price
 *   unavailable neither a billed figure nor a price could be found
 *
 * Allocation exists because no platform will attribute *money* to an API key or
 * a user, but all of them attribute *tokens* that far. Allocating keeps the
 * platform total equal to the invoice while still answering "which key spent
 * what" — as a derived answer, labelled as one.
 */

import { allocateProportionally, MICROS_PER_USD } from './money.js';
import type { ModelPrice, PriceBook } from './pricing/index.js';
import type { CostRecord, Diagnostic, ProviderId, ProviderResult, UsageRecord } from './types.js';

export type CostSource = 'reported' | 'allocated' | 'imported' | 'calculated' | 'unavailable';

export type CostedRecord = UsageRecord & {
  costMicros: number | null;
  costSource: CostSource;
  /** Which price source produced the derived figure, when one did. */
  priceSource: string | null;
};

export type UnattributedCost = {
  provider: ProviderId;
  amountMicros: number;
  description: string | null;
  reason: 'not-allocatable' | 'no-matching-usage';
};

export type CostingResult = {
  records: CostedRecord[];
  unattributed: UnattributedCost[];
  diagnostics: Diagnostic[];
};

export function applyCosts(
  results: readonly ProviderResult[],
  priceBook: PriceBook,
): CostingResult {
  const records: CostedRecord[] = [];
  const unattributed: UnattributedCost[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const result of results) {
    const costed = costProvider(result, priceBook, unattributed, diagnostics);
    records.push(...costed);
  }
  return { records, unattributed, diagnostics };
}

function costProvider(
  result: ProviderResult,
  priceBook: PriceBook,
  unattributed: UnattributedCost[],
  diagnostics: Diagnostic[],
): CostedRecord[] {
  const missingPrices = new Set<string>();

  // Step 1: derive a cost for every record, so allocation has weights and
  // records with no billed figure still get an answer.
  const costed: CostedRecord[] = result.records.map((record) => {
    const derived = deriveCost(record, priceBook);
    // A missing price only costs us something when nothing else states this
    // record's cost: a row that came with its own figure is unaffected by it.
    if (derived === null && record.model && record.reportedCostMicros === null) {
      missingPrices.add(record.model);
    }

    if (record.reportedCostMicros !== null) {
      return {
        ...record,
        costMicros: record.reportedCostMicros,
        // A record only gets the `reported` label when a platform billed it; a
        // figure restated from another tool says so via `costBasis`.
        costSource: record.costBasis === 'imported' ? 'imported' : 'reported',
        priceSource: null,
      };
    }
    return {
      ...record,
      costMicros: derived?.micros ?? null,
      costSource: derived ? 'calculated' : 'unavailable',
      priceSource: derived?.source ?? null,
    };
  });

  // Step 2: replace derived figures with the platform's billed amounts wherever
  // a billed bucket covers them.
  allocateReportedCost(result, costed, unattributed, diagnostics);

  if (missingPrices.size > 0) {
    diagnostics.push({
      provider: result.provider,
      level: 'warning',
      code: 'price-missing',
      message: `No unit price found for ${[...missingPrices].sort().join(', ')} — cost for these models is only as complete as the platform's own billed figures.`,
    });
  }
  return costed;
}

/** Day-grain key: billed buckets are daily everywhere, usage may be hourly. */
function grainKey(utcDay: string, model: string | null, workspaceId: string | null): string {
  return `${utcDay}|${model ?? ''}|${workspaceId ?? ''}`;
}

function utcDayOf(instant: string): string {
  return instant.slice(0, 10);
}

function allocateReportedCost(
  result: ProviderResult,
  costed: CostedRecord[],
  unattributed: UnattributedCost[],
  diagnostics: Diagnostic[],
): void {
  if (result.costRecords.length === 0) return;

  const byKey = new Map<string, CostedRecord[]>();
  for (const record of costed) {
    // Records that already carry a stated figure are authoritative; never
    // re-derive them from a coarser bucket.
    if (record.costSource === 'reported' || record.costSource === 'imported') continue;
    for (const key of candidateKeys(record)) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(record);
      else byKey.set(key, [record]);
    }
  }

  let allocatedTotal = 0;
  for (const cost of result.costRecords) {
    if (!cost.allocatable) {
      unattributed.push({
        provider: result.provider,
        amountMicros: cost.amountMicros,
        description: cost.description,
        reason: 'not-allocatable',
      });
      continue;
    }
    const key = grainKey(utcDayOf(cost.bucketStart), cost.model, cost.workspace?.id ?? null);
    const targets = byKey.get(key);
    if (!targets || targets.length === 0) {
      unattributed.push({
        provider: result.provider,
        amountMicros: cost.amountMicros,
        description: cost.description,
        reason: 'no-matching-usage',
      });
      continue;
    }
    apply(targets, cost);
    allocatedTotal += cost.amountMicros;
  }

  if (allocatedTotal > 0) {
    diagnostics.push({
      provider: result.provider,
      level: 'info',
      code: 'cost-allocated',
      message: `${result.provider} cost is billed at a coarser grain than usage; per-model, per-key and per-account amounts are allocated from the billed totals in proportion to derived cost.`,
    });
  }

  const orphaned = unattributed
    .filter((entry) => entry.provider === result.provider && entry.reason === 'no-matching-usage')
    .reduce((sum, entry) => sum + entry.amountMicros, 0);
  if (orphaned > 0) {
    diagnostics.push({
      provider: result.provider,
      level: 'warning',
      code: 'cost-unattributed',
      message: `${(orphaned / MICROS_PER_USD).toFixed(2)} USD of billed ${result.provider} cost matched no collected usage (a product this tool does not collect, or usage outside the window). It is reported separately, not spread over tokens.`,
    });
  }
}

/**
 * Keys a usage record could be billed under, finest first: the platform may
 * report cost per model-day-workspace, per day-workspace, or per day.
 */
function candidateKeys(record: CostedRecord): string[] {
  const day = utcDayOf(record.bucketStart);
  const workspaceId = record.workspace?.id ?? null;
  return [
    ...new Set([
      grainKey(day, record.model, workspaceId),
      grainKey(day, null, workspaceId),
      grainKey(day, record.model, null),
      grainKey(day, null, null),
    ]),
  ];
}

function apply(targets: CostedRecord[], cost: CostRecord): void {
  // Weight by derived cost where known, else by total tokens, so a group with no
  // price data still splits sensibly instead of collapsing onto one record.
  const weights = targets.map((record) =>
    record.priceSource !== null && record.costMicros !== null
      ? record.costMicros
      : totalTokens(record),
  );
  const shares = allocateProportionally(cost.amountMicros, weights);

  targets.forEach((record, index) => {
    const share = shares[index] ?? 0;
    // A record can sit inside several billed buckets (token cost plus a
    // day-level charge), so shares accumulate.
    record.costMicros =
      record.costSource === 'allocated' ? (record.costMicros ?? 0) + share : share;
    record.costSource = 'allocated';
  });
}

function totalTokens(record: UsageRecord): number {
  const { input, output, cacheCreation, cacheRead } = record.tokens;
  return input + output + cacheCreation + cacheRead;
}

/** tokens × published unit price, in micro-USD. */
export function deriveCost(
  record: UsageRecord,
  priceBook: PriceBook,
): { micros: number; source: string } | null {
  if (!record.model) return null;
  const found = priceBook.lookup(record.provider, record.model);
  if (!found) return null;

  const price = selectTier(found.price, record.tags.contextWindow);
  const { input, output, cacheCreation, cacheRead } = record.tokens;
  // A source without a cache price is not a source saying caching is free —
  // fall back to the uncached input rate rather than dropping the tokens.
  const cacheReadRate = price.cacheReadPerToken ?? price.inputPerToken;
  const cacheWriteRate = price.cacheWritePerToken ?? price.inputPerToken;

  const usd =
    input * price.inputPerToken +
    output * price.outputPerToken +
    cacheRead * cacheReadRate +
    cacheCreation * cacheWriteRate;

  return { micros: Math.round(usd * MICROS_PER_USD), source: found.source };
}

type TokenRates = {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number | null;
  cacheWritePerToken: number | null;
};

function selectTier(price: ModelPrice, contextWindow: string | undefined): TokenRates {
  // Anthropic prices requests above a 200k context window differently and tells
  // us which tier each record was in; only then is the long-context rate used.
  if (contextWindow === '200k-1M' && price.longContext) return price.longContext;
  return price;
}
