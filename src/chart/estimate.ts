/**
 * The decayed daily estimate: what a typical day costs lately, as a Bayesian
 * update of a normal model for the daily rate. Each of the last 30 complete
 * days is one observation, discounted by age (half-life 7 days); with a flat
 * prior the posterior mean is the exponentially weighted mean, and its spread
 * is the weighted standard deviation over √(effective number of days). The
 * curve is that posterior; the weighted distribution of the days themselves
 * stays faint behind it.
 *
 * UNRESOLVED: the variance is a plug-in estimate, not integrated over, so the
 * band is a little narrow when there are few effective days; and single days are
 * skewed and non-negative, so the normal is trusted for the rate, never drawn as
 * a prediction for one day. On the page the reader scrubs
 * the "as of" day back through the window and the same estimate is recomputed
 * as it would have read then.
 *
 * `estimateFrame` is the only implementation of the maths: the server calls it
 * for the first paint and the page script embeds its source via `toString()`,
 * so it must stay self-contained (no imports, no module-level helpers).
 */

import { addDays, dayKey, daysBetween } from '../dates.js';
import type { PeriodReport } from '../report.js';
import type { ChartOptions } from './figure.js';
import { escapeXml, TOKEN, type VendorId, vendorColour, vendorOf } from './tokens.js';

const WINDOW_DAYS = 30;
const HALF_LIFE_DAYS = 7;
const W = 1000;
const DENSITY = { top: 10, bottom: 150 };

export type EstimateModel = {
  days: string[];
  values: number[];
  unit: 'usd' | 'tokens';
  window: number;
  halfLife: number;
  bandwidth: number;
  xMax: number;
  yMax: number;
  width: number;
  density: { top: number; bottom: number };
};

export type EstimateFrame = {
  /** Decayed mean per day, and the flat mean of the same window. */
  mean: number;
  flat: number;
  /** Each day's weight relative to a day of age zero, 0…1. */
  weights: number[];
  /** Posterior standard deviation of the rate, and the effective number of days. */
  sd: number;
  nEff: number;
  /** The posterior (closed, and as an open line) and the weighted density of days. */
  path: string;
  line: string;
  days: string;
  peak: number;
  meanX: number;
  flatX: number;
  label: string;
};

/**
 * The estimate as of a fractional day index `at` (the end of day `at`). A day
 * eases in over the step before it completes and out over the step past the
 * window, so a scrub between days moves every mark smoothly.
 */
export function estimateFrame(model: EstimateModel, at: number): EstimateFrame {
  const { values, window, halfLife, bandwidth, xMax, yMax, width, density } = model;
  const fade = (value: number) => {
    const t = Math.min(1, Math.max(0, value));
    return t * t * (3 - 2 * t);
  };
  const covers = values.map((_, day) => fade(at - day + 1) * fade(window - (at - day)));
  const weights = covers.map((cover, day) => cover * 2 ** (-Math.max(at - day, 0) / halfLife));
  const sum = (list: number[], of: (weight: number, value: number) => number) =>
    list.reduce((total, weight, day) => total + of(weight, values[day] ?? 0), 0);
  const total = sum(weights, (weight) => weight);
  const mean = total > 0 ? sum(weights, (weight, value) => weight * value) / total : 0;
  const coverTotal = sum(covers, (cover) => cover);
  const flat = coverTotal > 0 ? sum(covers, (cover, value) => cover * value) / coverTotal : 0;
  // Discounted evidence: Kish's effective n, and the posterior spread of the mean.
  const squares = sum(weights, (weight) => weight * weight);
  const nEff = squares > 0 ? (total * total) / squares : 0;
  const spread =
    total > 0 ? sum(weights, (weight, value) => weight * (value - mean) ** 2) / total : 0;
  const sd = nEff > 1 ? Math.sqrt((spread * nEff) / (nEff - 1) / nEff) : xMax;

  const plot = (value: number) => (Math.min(value, xMax) / xMax) * width;
  const points: string[] = [];
  let peak = 0;
  for (let step = 0; step <= 120; step += 1) {
    const x = (step / 120) * xMax;
    let y = 0;
    if (total > 0) {
      for (let day = 0; day < values.length; day += 1) {
        const weight = weights[day] ?? 0;
        if (weight === 0) continue;
        const z = (x - (values[day] ?? 0)) / bandwidth;
        y += weight * Math.exp(-0.5 * z * z);
      }
      y /= total * bandwidth * Math.sqrt(2 * Math.PI);
    }
    peak = Math.max(peak, y);
    const top = density.bottom - (Math.min(y, yMax) / (yMax || 1)) * (density.bottom - density.top);
    points.push(`${plot(x).toFixed(1)},${top.toFixed(1)}`);
  }
  const days = `M0,${density.bottom}L${points.join('L')}L${width},${density.bottom}Z`;
  // The posterior at a fixed peak height: its width is the uncertainty. A floor on
  // the spread keeps a run of identical days from drawing a spike of zero width.
  const scale = Math.max(sd, xMax / 400);
  const curve: string[] = [];
  for (let step = 0; step <= 80; step += 1) {
    const x = mean + ((step - 40) / 10) * scale;
    const top =
      density.bottom - Math.exp(-0.5 * ((x - mean) / scale) ** 2) * (density.bottom - density.top);
    curve.push(`${plot(Math.max(x, 0)).toFixed(1)},${top.toFixed(1)}`);
  }
  const path = `M${curve[0]?.split(',')[0]},${density.bottom}L${curve.join('L')}L${curve.at(-1)?.split(',')[0]},${density.bottom}Z`;
  const format = (value: number) =>
    model.unit === 'usd'
      ? value.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        })
      : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const label = `${format(mean)} ± ${format(1.96 * sd)}`;
  return {
    mean,
    flat,
    weights,
    sd,
    nEff,
    path,
    line: `M${curve.join('L')}`,
    days,
    peak,
    meanX: plot(mean),
    flatX: plot(flat),
    label,
  };
}

/** The model for a daily report, or null when fewer than a week of complete days exist. */
export function estimateModel(report: PeriodReport, options: ChartOptions): EstimateModel | null {
  if (!report.daily) return null;
  const { since, until } = report.meta.range;
  const today = dayKey(report.meta.generatedAt, report.meta.timezone);
  const lastComplete = today <= until ? addDays(today, -1) : until;
  const unit = options.includeCost ? 'usd' : 'tokens';
  const byDay = new Map(
    report.daily.map((row) => [
      row.period,
      unit === 'usd' ? (row.totalCost ?? 0) : row.totalTokens,
    ]),
  );
  const days: string[] = [];
  for (let day = since; day <= lastComplete; day = addDays(day, 1)) days.push(day);
  if (days.length < 7) return null;
  // Days without a row count as zero, as the run-rate cards do.
  const values = days.map((day) => byDay.get(day) ?? 0);
  const max = Math.max(...values);
  if (max <= 0) return null;

  // One bandwidth for the whole series (Silverman), so scrubbing moves the
  // curve without re-smoothing it underfoot.
  const mu = values.reduce((sum, one) => sum + one, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, one) => sum + (one - mu) ** 2, 0) / values.length);
  const model: EstimateModel = {
    days,
    values,
    unit,
    window: WINDOW_DAYS,
    halfLife: HALF_LIFE_DAYS,
    bandwidth: Math.max(1.06 * sd * values.length ** -0.2, max / 40),
    xMax: max * 1.05,
    yMax: 1,
    width: W,
    density: DENSITY,
  };
  // A fixed height scale: the tallest curve over every whole-day position.
  let peak = 0;
  for (let at = 0; at < days.length; at += 1) peak = Math.max(peak, estimateFrame(model, at).peak);
  model.yMax = peak || 1;
  return model;
}

/** The section: heading, the readout, and the scrubbable SVG. */
export type CardKind = 'rate' | 'total' | 'price' | 'leverage';

/**
 * Actually paid, against the API-rate ink: a grey from the token-class ramp, since
 * the report's only hues are vendor colours (AGENTS.md rule 13).
 */
const PAID_INK = '#939393';
/** The thinnest price band drawn, in the card's 100 vertical units (about 2px). */
const BAND_FLOOR = 3;
/** How far the price bands stop under the 2.5px price line, in the same units: under
    its half width, so the line overlaps them a little rather than leave a gap. */
const LINE_CLEARANCE = 0.8;

/** Catmull-Rom through whole-day keyframes: the scrub moves between days on a smooth curve. */
export function interp(series: number[], at: number): number {
  const index = Math.floor(at);
  const u = at - index;
  const at_ = (k: number) => series[Math.min(series.length - 1, Math.max(0, k))] ?? 0;
  const [p0, p1, p2, p3] = [at_(index - 1), at_(index), at_(index + 1), at_(index + 2)];
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)
  );
}

/**
 * The cumulative line up to a fractional day `at` (−1 is before the first day,
 * where nothing is drawn), in a 1000 × 100 box with the total near the top.
 */
export function cumulativePath(
  cum: number[],
  at: number,
): { line: string; area: string; value: number } {
  const n = cum.length;
  const total = cum[n - 1] || 1;
  const x = (k: number) => ((k + 1) / n) * 1000;
  const y = (value: number) => 100 - (value / total) * 92;
  const level = (k: number) => (k < 0 ? 0 : (cum[k] ?? 0));
  const whole = Math.floor(at);
  const points = [`0,100`];
  for (let k = 0; k <= whole && k < n; k += 1)
    points.push(`${x(k).toFixed(2)},${y(level(k)).toFixed(2)}`);
  const u = at - whole;
  const value = level(whole) + (level(whole + 1) - level(whole)) * u;
  const end = x(whole) + (x(whole + 1) - x(whole)) * u;
  if (u > 0) points.push(`${end.toFixed(2)},${y(value).toFixed(2)}`);
  const line = `M${points.join('L')}`;
  return { line, area: `${line}L${end.toFixed(2)},100L0,100Z`, value };
}

/**
 * A level over time from day `first` up to a fractional day `at`, in the same
 * 1000 × 100 box, `top` near the top edge; before `first` nothing is drawn.
 */
export function levelPath(
  series: number[],
  first: number,
  top: number,
  at: number,
): { line: string; area: string; value: number } {
  const n = series.length;
  const x = (k: number) => ((k + 1) / n) * 1000;
  const y = (value: number) => 100 - (value / (top || 1)) * 92;
  if (at < first) return { line: '', area: '', value: series[first] ?? 0 };
  const whole = Math.floor(at);
  const points = [];
  for (let k = first; k <= whole && k < n; k += 1)
    points.push(`${x(k).toFixed(2)},${y(series[k] ?? 0).toFixed(2)}`);
  const u = at - whole;
  const value = (series[whole] ?? 0) + ((series[whole + 1] ?? 0) - (series[whole] ?? 0)) * u;
  const end = x(whole) + (x(whole + 1) - x(whole)) * u;
  if (u > 0) points.push(`${end.toFixed(2)},${y(value).toFixed(2)}`);
  const line = `M${points.join('L')}`;
  return { line, area: `${line}L${end.toFixed(2)},100L${x(first).toFixed(2)},100Z`, value };
}

/** A band between two share series (0…1) from `first` up to `at`, in the card box. */
export function bandPath(lower: number[], upper: number[], first: number, at: number): string {
  const n = upper.length;
  if (at < first) return '';
  const x = (k: number) => ((k + 1) / n) * 1000;
  const whole = Math.floor(at);
  const u = at - whole;
  const ks: number[] = [];
  for (let k = first; k <= whole && k < n; k += 1) ks.push(k);
  const point = (series: number[], k: number) =>
    `${x(k).toFixed(2)},${(100 - (series[k] ?? 0) * 100).toFixed(2)}`;
  const tip = (series: number[]) => {
    const value = (series[whole] ?? 0) + ((series[whole + 1] ?? 0) - (series[whole] ?? 0)) * u;
    return `${(x(whole) + (x(whole + 1) - x(whole)) * u).toFixed(2)},${(100 - value * 100).toFixed(2)}`;
  };
  const top = ks.map((k) => point(upper, k));
  const bottom = ks.map((k) => point(lower, k)).reverse();
  if (u > 0) {
    top.push(tip(upper));
    bottom.unshift(tip(lower));
  }
  return `M${[...top, ...bottom].join('L')}Z`;
}

/**
 * A header card that scrubs through time: the daily rate posterior, the year's
 * projection from it, or the cumulative total. Focus it and the wheel moves the
 * as-of day. Empty when there is no model.
 */
export function estimateCard(
  report: PeriodReport,
  options: ChartOptions,
  kind: CardKind = 'rate',
  paid?: { line: string; daily: number[]; rest: string },
): string {
  const model = estimateModel(report, options);
  if (!model) return '';
  const short = (day: string) => shortDate(day);
  const format = (value: number) => compactValue(model, value);
  const host = (
    label: string,
    title: string,
    value: string,
    date: string,
    data: unknown,
    svg: string,
    paid?: { line: string; colour?: string; attr?: string },
  ) =>
    `  <div class="card${kind === 'total' ? '' : ' projected'} estimate-card${paid ? ' has-paid' : ''}" tabindex="0" data-card='${JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll("'", '\\u0027')}' title="${escapeXml(title)}" aria-label="${escapeXml(label)}; focus, then scroll or use the arrow keys to move the as-of day">
    <div class="label" data-card-label>${escapeXml(label)}</div>
    <div class="value" data-card-value>${escapeXml(value)}</div>
    <div class="date" data-card-date>${escapeXml(date)}</div>${paid ? `\n    <div class="sub paid" ${paid.attr ?? 'data-card-paid'} style="color:${paid.colour ?? PAID_INK}">${escapeXml(paid.line)}</div>` : ''}
<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">${svg}</svg>
  </div>`;

  if (kind === 'total') {
    // Through the last complete day, as the rate is, so every card moves on the
    // same days; today's partial spend is left to the table.
    const { since } = report.meta.range;
    const until = model.days.at(-1) ?? since;
    const byDay = new Map(report.daily?.map((row) => [row.period, row.totalCost ?? 0]));
    const days: string[] = [];
    for (let day = since; day <= until; day = addDays(day, 1)) days.push(day);
    let running = 0;
    const cum = days.map((day) => {
      running += byDay.get(day) ?? 0;
      return running;
    });
    const at = days.length - 1;
    const path = cumulativePath(cum, at);
    // Actually paid, accumulated the same way; each line is a share of its own
    // final total, so both end at 100% and only their shapes are compared.
    let paidRunning = 0;
    const paidCum = paid?.daily.map((one) => {
      paidRunning += one;
      return paidRunning;
    });
    const paidPath = paidCum ? cumulativePath(paidCum, at) : null;
    return host(
      'Total cost',
      `Cumulative ${report.totals.costSource} cost at API rates${paid ? ' (dark) and actually paid (grey), each as a share of its own total' : ''}, ${since} to ${until}, the last complete day.`,
      format(path.value),
      short(days[at] ?? ''),
      {
        kind,
        unit: model.unit,
        days,
        cum,
        paidCum,
        paidRest: paid?.rest ?? '',
        first: -1,
        last: at,
      },
      `${
        paidPath
          ? `<path data-part="paid" d="${paidPath.line}" fill="none" stroke="${PAID_INK}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`
          : ''
      }<path data-part="line" d="${path.line}" fill="none" stroke="${TOKEN.ink}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`,
      paid,
    );
  }

  if (kind === 'price' || kind === 'leverage') {
    // Same days as the total card, so the shared as-of day means the same thing.
    const { since } = report.meta.range;
    const until = model.days.at(-1) ?? since;
    const days: string[] = [];
    for (let day = since; day <= until; day = addDays(day, 1)) days.push(day);
    const cost = days.map(() => 0);
    const tokens = days.map(() => 0);
    const index = new Map(days.map((day, k) => [day, k]));
    const byVendor = new Map<VendorId, number[]>();
    const names = new Map<VendorId, string>();
    const vendorCost = new Map<VendorId, number>();
    for (const row of report.daily ?? []) {
      const k = index.get(row.period);
      if (k === undefined) continue;
      cost[k] = (cost[k] ?? 0) + (row.totalCost ?? 0);
      // Cache reads are excluded: they are near-free and would swamp the price.
      tokens[k] = (tokens[k] ?? 0) + row.inputTokens + row.outputTokens + row.cacheCreationTokens;
      for (const one of row.modelBreakdowns) {
        // By agent, as the figure's series are, so the colours agree with it.
        const agent = one.agents[0] ?? one.provider;
        const vendor = vendorOf(agent);
        if (!names.has(vendor)) names.set(vendor, agent);
        vendorCost.set(vendor, (vendorCost.get(vendor) ?? 0) + (one.cost ?? 0));
        const series = byVendor.get(vendor) ?? days.map(() => 0);
        series[k] = (series[k] ?? 0) + one.inputTokens + one.outputTokens + one.cacheCreationTokens;
        byVendor.set(vendor, series);
      }
    }
    const decay = (values: number[], d: number) => {
      let sum = 0;
      for (let k = Math.max(0, d - model.window + 1); k <= d; k += 1)
        sum += 0.5 ** ((d - k) / model.halfLife) * (values[k] ?? 0);
      return sum;
    };
    let series: number[];
    let first: number;
    let label: string;
    let title: string;
    if (kind === 'price') {
      // Decayed like the rate: cost-weighted over token-weighted, per million.
      series = days.map((_, d) => {
        const t = decay(tokens, d);
        return t > 0 ? (decay(cost, d) / t) * 1e6 : 0;
      });
      first = Math.max(
        0,
        tokens.findIndex((t) => t > 0),
      );
      label = 'Price per M tokens';
      title = `API-rate cost per million tokens (input, output and cache writes; cache reads excluded, their cost included), decayed with a ${model.halfLife}-day half-life over ${model.window} days. Shaded: each agent's share of those tokens, decayed the same way; when the price moves with the shading, the mix changed, not the prices. Derived, not billed.`;
    } else {
      // Plan leverage: what the usage would have cost at API rates over what was paid.
      let api = 0;
      let out = 0;
      series = days.map((_, d) => {
        api += cost[d] ?? 0;
        out += paid?.daily[d] ?? 0;
        return out > 0 ? api / out : 0;
      });
      first = Math.max(
        0,
        series.findIndex((v) => v > 0),
      );
      label = 'Plan leverage';
      title = `Cumulative API-rate cost over cumulative actually paid, ${since} to ${until}. Modelled from the stated plans; not a bill.`;
    }
    const last = days.length - 1;
    const top = Math.max(...series.slice(first)) * 1.04;
    const path = levelPath(series, first, top, last);
    // Token share by agent, stacked under the price line so the stack's top is
    // the line (each band is its share of the price's height), largest at the bottom.
    let bands: { lower: number[]; upper: number[]; colour: string; name: string }[] = [];
    if (kind === 'price') {
      // The figure's stack order (largest cost at the bottom), so the two agree.
      const order = [...byVendor.keys()].sort(
        (a, b) => (vendorCost.get(b) ?? 0) - (vendorCost.get(a) ?? 0) || a.localeCompare(b),
      );
      const heights = order.map((vendor) =>
        days.map((_, d) => decay(byVendor.get(vendor) ?? [], d)),
      );
      // The stack stops LINE_CLEARANCE under the line (the line's own half
      // width), so the line sits on the bands rather than over them.
      const stackTop = days.map((_, d) =>
        Math.max(0, ((series[d] ?? 0) * 0.92) / top - LINE_CLEARANCE / 100),
      );
      // Under BAND_FLOOR (of the card's 100 units) a band is dropped and the rest
      // fill its place: a sliver a pixel high only flickers as the day moves.
      for (const [d] of days.entries()) {
        const height = (stackTop[d] ?? 0) * 100;
        const total = heights.reduce((sum, one) => sum + (one[d] ?? 0), 0) || 1;
        for (const one of heights) {
          if (((one[d] ?? 0) / total) * height < BAND_FLOOR) one[d] = 0;
        }
      }
      const kept = days.map((_, d) => heights.reduce((sum, one) => sum + (one[d] ?? 0), 0) || 1);
      let floor = days.map(() => 0);
      bands = order.map((vendor, index) => {
        const lower = floor;
        const upper = days.map(
          (_, d) =>
            (lower[d] ?? 0) + ((heights[index]?.[d] ?? 0) / (kept[d] ?? 1)) * (stackTop[d] ?? 0),
        );
        floor = upper;
        return { lower, upper, colour: vendorColour(vendor), name: names.get(vendor) ?? vendor };
      });
    }
    const text = (value: number) =>
      kind === 'price' ? `${compactValue(model, value)} / M` : `${value.toFixed(1)}×`;
    return host(
      label,
      title,
      text(path.value),
      short(days[last] ?? ''),
      {
        kind,
        days,
        series,
        top,
        first,
        last,
        bands: bands.map(({ lower, upper }) => ({ lower, upper })),
      },
      `${
        bands.length
          ? bands
              .map(
                (band) =>
                  `<path data-part="band" d="${bandPath(band.lower, band.upper, first, last)}" fill="${band.colour}"><title>${escapeXml(band.name)}: share of tokens</title></path>`,
              )
              .join('')
          : ''
      }<path data-part="line" d="${path.line}" fill="none" stroke="${TOKEN.ink}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`,
    );
  }

  const last = model.values.length - 1;
  const first = Math.min(6, last);
  const frames = model.values.map((_, day) => estimateFrame(model, day));
  const mean = frames.map((frame) => frame.mean);
  const sd = frames.map((frame) => frame.sd);
  const label = model.unit === 'usd' ? 'Daily spend' : 'Daily tokens';
  // The year's projection is an affine map of the same posterior (known days of
  // the year plus every other day at the rate), so it is one bell on a rescaled
  // axis: a second readout, not a second plot. Its band would be the rate's
  // uncertainty times the remaining days, not day-to-day noise.
  const year = (model.days[last] ?? '').slice(0, 4);
  const yearStart = `${year}-01-01`;
  const inYear = daysBetween(yearStart, `${year}-12-31`) + 1;
  let known = 0;
  let knownDays = 0;
  const yearMean = mean.map((rate, day) => {
    if ((model.days[day] ?? '') >= yearStart) {
      known += model.values[day] ?? 0;
      knownDays += 1;
    }
    return known + (inYear - knownDays) * rate;
  });
  // Label first, amount last: the amount changes on a scrub.
  const yearPrefix = `${year} projected ≈ `;
  const title = `Posterior daily rate ≈ ${frames[last]?.label}; ${subLine(model, last, frames[last] as EstimateFrame)}. ${year} projected: cost of the year's days in the window plus every other day at that rate. Modelled, not billed.`;

  // Bars at fixed ticks over where the posterior travels in the scrub range;
  // their heights trace it, down to zero.
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (let day = first; day <= last; day += 1) {
    lo = Math.min(lo, (mean[day] ?? 0) - 2.5 * (sd[day] ?? 0));
    hi = Math.max(hi, (mean[day] ?? 0) + 2.5 * (sd[day] ?? 0));
  }
  const span = Math.max(hi - lo, Math.abs(hi) / 20, 1e-9);
  lo = Math.max(lo - span * 0.04, 0);
  hi += span * 0.06;
  const BARS = 36;
  const ticks = Array.from({ length: BARS }, (_, index) => lo + ((index + 0.5) / BARS) * (hi - lo));
  const floor = (hi - lo) / 400;
  const bars = ticks
    .map((tick, index) => {
      const x = ((index + 0.5) / BARS) * 1000;
      const height = bell(tick, mean[last] ?? 0, Math.max(sd[last] ?? 0, floor)) * 100;
      return `<rect x="${(x - 8.3).toFixed(2)}" width="16.6" y="${(100 - height).toFixed(2)}" height="${height.toFixed(2)}" fill="${TOKEN.ink}"/>`;
    })
    .join('');
  return host(
    label,
    title,
    `≈ ${format(mean[last] ?? 0)}`,
    short(model.days[last] ?? ''),
    {
      kind,
      unit: model.unit,
      days: model.days,
      mean,
      sd,
      yearMean,
      yearPrefix,
      ticks,
      floor,
      first,
      last,
    },
    `<g data-part="bars">${bars}</g>`,
    model.unit === 'usd'
      ? {
          line: `${yearPrefix}${format(yearMean[last] ?? 0)}`,
          colour: PAID_INK,
          attr: 'data-card-year',
        }
      : undefined,
  );
}

/** The posterior's height at `value`, 0…1; the page script repeats it. */
function bell(value: number, mean: number, scale: number): number {
  return Math.exp(-0.5 * ((value - mean) / scale) ** 2);
}

function compactValue(model: EstimateModel, value: number): string {
  return model.unit === 'usd'
    ? value.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      })
    : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function subLine(model: EstimateModel, at: number, frame: EstimateFrame): string {
  const day = model.days[Math.round(at)] ?? '';
  const flat =
    model.unit === 'usd'
      ? frame.flat.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        })
      : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
          frame.flat,
        );
  return `as of ${day} · ${frame.nEff.toFixed(1)} effective days · flat ${model.window}-day mean ${flat}`;
}

export const ESTIMATE_STYLES = `.cards.trio { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.cards.trio .estimate-card { grid-column: auto; }
@media (max-width: 1000px) { .cards.trio { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .cards.trio { grid-template-columns: minmax(0, 1fr); } }
.estimate-card { grid-column: span 2; outline: none; position: relative; overflow: hidden;
  padding: 16px 20px 0; min-height: 156px; touch-action: pan-y; cursor: ew-resize; }
.estimate-card .label, .estimate-card .value, .estimate-card .date { position: relative; z-index: 1;
  pointer-events: none; }
.estimate-card .value { font-size: 24px; margin-top: 2px; }
/* The headline number in the site's handwriting, a little smaller to sit at the same height. */
.estimate-card [data-card-value] { font-family: 'Rock Salt', cursive; font-size: 20px; line-height: 1.5; }
.estimate-card .date { position: absolute; top: 34px; right: 20px; font-size: 24px; line-height: 1.25;
  color: var(--muted); font-variant-numeric: tabular-nums; }
/* Below the readouts, full width, down to the border: the curve sits in the card. */
.estimate-card svg { position: absolute; left: 0; bottom: 0; top: 84px;
  width: 100%; height: calc(100% - 84px); }
.estimate-card .sub.paid { position: relative; z-index: 1; pointer-events: none; margin-top: 8px; }
.estimate-card.has-paid { min-height: 184px; }
.estimate-card.has-paid svg { top: 112px; height: calc(100% - 112px); }`;

/**
 * Wires the scrubs. Only a focused element takes the wheel, so the page scrolls
 * past it untouched; at either end the wheel goes back to the page. The as-of
 * day follows the input on a critically damped spring — the standard answer to
 * bursty wheel and trackpad deltas — and the cards draw between whole-day
 * posteriors on a Catmull-Rom curve rather than refitting at fractional days.
 */
export function estimateScript(): string {
  return `const interp = ${interp.toString()};
const cumulativePath = ${cumulativePath.toString()};
const levelPath = ${levelPath.toString()};
const bandPath = ${bandPath.toString()};
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const dash = matchMedia('(min-width: 1001px) and (min-height: 640px)');
const shortDay = (day) => new Date(day + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const amount = (unit, n) => unit === 'usd' ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
function scrub(hosts, first, last, paint) {
  let at = last, target = last, velocity = 0, frame = 0, then = 0, held = -Infinity;
  const omega = 16;
  const tick = (now) => {
    const dt = Math.min(0.05, then ? (now - then) / 1000 : 1 / 60);
    then = now;
    if (still) { at = target; velocity = 0; }
    else {
      velocity += (omega * omega * (target - at) - 2 * omega * velocity) * dt;
      at += velocity * dt;
    }
    if (Math.abs(target - at) < 0.001 && Math.abs(velocity) < 0.01) { at = target; velocity = 0; }
    paint(at);
    if (at === target && velocity === 0) { frame = 0; then = 0; } else frame = requestAnimationFrame(tick);
  };
  const go = (to) => {
    target = Math.min(last, Math.max(first, to));
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const wheel = (event) => {
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    // Down or left is back in time, at 40 px a day.
    const next = Math.min(last, Math.max(first, target + (event.deltaX - event.deltaY) * scale / 40));
    // At an end the same gesture (and its trackpad momentum) stays captured;
    // only a fresh wheel after a pause goes back to the page.
    const now = event.timeStamp;
    if (next === target && now - held > 300) return;
    held = now;
    event.preventDefault();
    go(next);
  };
  // On the desktop dashboard nothing scrolls, so the wheel anywhere is the scrub;
  // a figure pane panning sideways or the open provenance keeps its own.
  addEventListener('wheel', (event) => {
    if (dash.matches && !event.defaultPrevented && !event.target.closest?.('.provenance')) wheel(event);
  }, { passive: false });
  for (const host of hosts) {
  host.addEventListener('wheel', (event) => {
    if (!dash.matches && document.activeElement === host) wheel(event);
  }, { passive: false });
  host.addEventListener('keydown', (event) => {
    const by = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -7, PageUp: 7 }[event.key];
    if (event.key === 'Home') go(first); else if (event.key === 'End') go(last); else if (by) go(Math.round(target) + by); else return;
    event.preventDefault();
  });
  let drag = null;
  host.addEventListener('pointerdown', (event) => { drag = { x: event.clientX, from: target }; host.focus(); host.setPointerCapture(event.pointerId); });
  host.addEventListener('pointermove', (event) => { if (drag) go(drag.from + (event.clientX - drag.x) / 8); });
  for (const type of ['pointerup', 'pointercancel']) host.addEventListener(type, () => { drag = null; });
  }
}
// The header cards share one as-of day: scrolling any of them moves them all.
// They start together at the latest first day (the rate needs a week of days)
// and end together on the last complete day.
const cards = [...document.querySelectorAll('[data-card]')];
const painters = [];
let lowest = -Infinity, highest = -Infinity;
for (const card of cards) {
  const data = JSON.parse(card.dataset.card);
  lowest = Math.max(lowest, data.first); highest = Math.max(highest, data.last);
  const clamp = (at) => Math.min(data.last, Math.max(data.first, at));
  const value = card.querySelector('[data-card-value]'), date = card.querySelector('[data-card-date]');
  const svg = card.querySelector('svg');
  const part = (name) => svg.querySelector('[data-part="' + name + '"]');
  const dayOf = (at) => at < -0.5 ? '—' : shortDay(data.days[Math.max(0, Math.round(at))]);
  if (data.kind === 'total') {
    const line = part('line'), area = part('area'), paidLine = part('paid');
    const paidText = card.querySelector('[data-card-paid]');
    painters.push((time) => {
      const at = clamp(time);
      const path = cumulativePath(data.cum, at);
      line.setAttribute('d', path.line); area?.setAttribute('d', path.area);
      value.textContent = amount(data.unit, path.value);
      date.textContent = dayOf(at);
      if (data.paidCum) {
        const paid = cumulativePath(data.paidCum, at);
        paidLine.setAttribute('d', paid.line);
        paidText.textContent = 'actually paid ≈ ' + amount(data.unit, paid.value) + data.paidRest;
      }
    });
    continue;
  }
  if (data.kind === 'price' || data.kind === 'leverage') {
    const line = part('line'), area = part('area'), bands = [...svg.querySelectorAll('[data-part="band"]')];
    painters.push((time) => {
      const at = clamp(time);
      const path = levelPath(data.series, data.first, data.top, at);
      line.setAttribute('d', path.line); area?.setAttribute('d', path.area);
      bands.forEach((band, i) => band.setAttribute('d', bandPath(data.bands[i].lower, data.bands[i].upper, data.first, at)));
      value.textContent = data.kind === 'price' ? amount('usd', path.value) + ' / M' : path.value.toFixed(1) + '×';
      date.textContent = dayOf(at);
    });
    continue;
  }
  const bars = [...part('bars').children], year = card.querySelector('[data-card-year]');
  painters.push((time) => {
    const at = clamp(time);
    const mean = interp(data.mean, at), sd = Math.max(interp(data.sd, at), data.floor);
    bars.forEach((bar, i) => {
      const g = Math.exp(-0.5 * ((data.ticks[i] - mean) / sd) ** 2) * 100;
      bar.setAttribute('y', 100 - g); bar.setAttribute('height', g);
    });
    value.textContent = '≈ ' + amount(data.unit, mean);
    if (year) year.textContent = data.yearPrefix + amount(data.unit, interp(data.yearMean, at));
    date.textContent = dayOf(at);
  });
}
// The figure's bars mark the as-of day with a soft column, panned into view.
const marks = [...document.querySelectorAll('rect[data-asof]')].map((rect) => {
  const periods = rect.dataset.asof.split(' '), slot = Number(rect.dataset.slot), left = Number(rect.dataset.left);
  const days = cards.length ? JSON.parse(cards[0].dataset.card).days : [];
  // A day without usage has no bar: it sits between its neighbours.
  let k = -1;
  const pos = days.map((day) => { while (k + 1 < periods.length && periods[k + 1] <= day) k += 1; return periods[k] === day ? k : k + 0.5; });
  return { rect, pane: rect.ownerSVGElement, pos, slot, left };
});
const mark = (at) => {
  for (const m of marks) {
    const shown = at < highest - 0.01;
    m.rect.setAttribute('opacity', shown ? '1' : '0');
    if (!shown) continue;
    const i = Math.max(0, Math.min(m.pos.length - 1, at)), lo = Math.floor(i), u = i - lo;
    const p = (m.pos[lo] ?? 0) + ((m.pos[lo + 1] ?? m.pos[lo] ?? 0) - (m.pos[lo] ?? 0)) * u;
    const x = m.left + m.slot * p;
    m.rect.setAttribute('x', x);
    m.pane.dispatchEvent(new CustomEvent('reveal', { detail: [x, x + m.slot] }));
  }
};
// The table follows: the as-of day is its top row; at the end every row shows,
// today's partial one included.
const tableRows = [...document.querySelectorAll('tr[data-period]')];
const asOfDays = cards.length ? JSON.parse(cards[0].dataset.card).days : [];
let topDay;
// The figure's legend amounts: summed through the as-of day, the total at the end.
const legendAmounts = [...document.querySelectorAll('text[data-cum]')].map((text) => ({
  text,
  labels: text.dataset.cum.split('|'),
  periods: text.closest('svg[data-view]').querySelector('rect[data-asof]').dataset.asof.split(' '),
}));
const follow = (at) => {
  const day = at < highest - 0.01 ? asOfDays[Math.max(0, Math.round(at))] : undefined;
  if (day === topDay) return;
  topDay = day;
  for (const row of tableRows) row.hidden = day !== undefined && row.dataset.period > day;
  for (const { text, labels, periods } of legendAmounts) {
    const through = day === undefined ? periods.length : periods.filter((period) => period <= day).length;
    text.textContent = labels[through];
  }
};
if (cards.length) scrub(cards, lowest, highest, (at) => { for (const paint of painters) paint(at); mark(at); follow(at); });
`;
}
