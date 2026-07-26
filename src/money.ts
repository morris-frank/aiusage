/**
 * Money is carried as integer **micro-USD** (1e-6 USD) everywhere inside this
 * package, and converted to a float USD only at the JSON/table boundary.
 *
 * Why: usage reports sum thousands of sub-cent amounts. Doing that in float USD
 * accumulates visible drift (and makes two runs over the same data disagree in
 * the last digits). Micro-USD keeps sums exact — a micro-dollar is finer than
 * any platform's own reporting resolution, and 2^53 micros is ~$9bn of headroom.
 */

export const MICROS_PER_USD = 1_000_000;

/** Micro-USD per *cent* — Anthropic's cost report is denominated in cents. */
const MICROS_PER_CENT = 10_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/**
 * Parses a decimal string of cents (Anthropic returns e.g. `"123.78912"`) into
 * micro-USD. Returns null for anything unparseable rather than guessing zero —
 * a missing cost must stay distinguishable from a zero cost.
 */
export function centsStringToMicros(value: string): number | null {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * MICROS_PER_CENT);
}

/** Sums cost values where `null` means "not reported", not "zero". */
export function sumReportedMicros(values: Iterable<number | null>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

/**
 * Distributes `totalMicros` across `weights` proportionally, as integers that
 * sum back to exactly `totalMicros`. Used to spread a platform-reported (real)
 * cost over a finer grain than the platform will report it at.
 *
 * With no usable weights the total is spread evenly, so money is never lost.
 */
export function allocateProportionally(totalMicros: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, weight) => acc + Math.max(weight, 0), 0);
  const shares =
    sum > 0
      ? weights.map((weight) => (Math.max(weight, 0) / sum) * totalMicros)
      : weights.map(() => totalMicros / weights.length);

  // Floor everything, then hand the remainder to the largest fractional parts,
  // so the allocation is deterministic and sums exactly.
  const floors = shares.map((share) => Math.floor(share));
  let remainder = totalMicros - floors.reduce((acc, value) => acc + value, 0);
  const order = shares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of order) {
    if (remainder <= 0) break;
    const current = floors[index];
    if (current === undefined) continue;
    floors[index] = current + 1;
    remainder -= 1;
  }
  return floors;
}

/** Formats micro-USD for display, e.g. `$12.34` / `$0.0042` for small amounts. */
export function formatUsd(micros: number | null): string {
  if (micros === null) return '—';
  const usd = microsToUsd(micros);
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(2)}`;
}
