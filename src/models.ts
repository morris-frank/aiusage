/**
 * Canonical model identity — recognising that a vendor-prefixed OpenRouter id
 * and a platform's own first-party id name the same underlying model.
 *
 * Platforms spell "the same" model differently:
 *   - OpenRouter prefixes a vendor (`anthropic/claude-opus-5`, `openai/gpt-5.6`).
 *   - A platform's own usage/cost API may carry a trailing pinned-snapshot
 *     date (`claude-opus-5-20260315`).
 *   - ccusage's local agent logs carry neither — confirmed never
 *     vendor-prefixed; see `pricing/litellm.ts`'s own comment on why the
 *     local source has no LiteLLM lookup at all.
 *
 * Stripping both merges these into one canonical id, so "the same model" is
 * one row in a `--split model` view, not three. This mirrors — and is the
 * shared source of truth for — the exact transform `pricing/litellm.ts`'s
 * `candidateKeys` already trusts to match a platform's model id against the
 * price table, so a group-vs-price mismatch can't drift out of sync.
 *
 * What it will not catch: a platform's internal version string that has no
 * mechanical relationship to another surface's spelling, and merging two
 * distinct *dated* snapshots of a model loses the distinction between them if
 * a caller cared which pinned snapshot was used. `report.ts` discloses when a
 * merge actually happened (`model-id-canonicalized`) rather than doing it
 * silently.
 */

const DATE_SUFFIX_RE = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** `anthropic/claude-opus-5` → `claude-opus-5`; a bare id is unchanged. */
export function stripVendorPrefix(model: string): string {
  return model.includes('/') ? (model.split('/').pop() ?? model) : model;
}

/** `claude-opus-5-20260315` → `claude-opus-5`; strips `-YYYYMMDD` or `-YYYY-MM-DD`. */
export function stripDateSuffix(model: string): string {
  return model.replace(DATE_SUFFIX_RE, '');
}

export function canonicalModelId(model: string): string {
  return stripDateSuffix(stripVendorPrefix(model.trim()));
}
