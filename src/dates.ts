/**
 * Date handling.
 *
 * Two clocks meet here and must not be confused:
 *
 *   - Platforms bucket usage in **UTC** (all four of them). A "1d" bucket is a
 *     UTC calendar day.
 *   - The user may want rows grouped in their own timezone.
 *
 * So a period key is always derived from the bucket's *start instant* rendered
 * in the requested timezone. When the source buckets are whole UTC days and the
 * requested timezone is not UTC, that mapping is lossy — the collector asks for
 * hourly buckets where the platform supports it, and emits a
 * `timezone-approximation` diagnostic where it does not.
 */

import type { DateRange, Granularity } from './types.js';

const DATE_RE = /^(\d{4})-?(\d{2})-?(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export class DateInputError extends Error {}

/** Accepts `YYYY-MM-DD` or `YYYYMMDD`; returns the canonical `YYYY-MM-DD`. */
export function parseDateInput(input: string, label = 'date'): string {
  const match = DATE_RE.exec(input.trim());
  if (!match) {
    throw new DateInputError(`Invalid ${label} "${input}": expected YYYY-MM-DD or YYYYMMDD`);
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || toDateString(parsed) !== iso) {
    throw new DateInputError(`Invalid ${label} "${input}": not a real calendar date`);
  }
  return iso;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` for an instant, in UTC. */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** `YYYY-MM-DD` for an instant, rendered in `timeZone`. */
export function dayKey(instant: string | Date, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (timeZone === 'UTC') return toDateString(date);
  let year = '';
  let month = '';
  let day = '';
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM` for an instant, rendered in `timeZone`. */
export function monthKey(instant: string | Date, timeZone: string): string {
  return dayKey(instant, timeZone).slice(0, 7);
}

/**
 * `YYYY-MM-DD` of the ISO week's Monday, rendered in `timeZone`.
 * ISO-8601 weeks (Monday start) are used so week boundaries do not depend on
 * locale — the label is the week's first day, which is what reads best in a
 * table.
 */
export function weekKey(instant: string | Date, timeZone: string): string {
  const day = dayKey(instant, timeZone);
  const asUtc = new Date(`${day}T00:00:00Z`);
  // getUTCDay(): 0 = Sunday. Monday-start offset: Sunday counts as 6 days in.
  const offset = (asUtc.getUTCDay() + 6) % 7;
  return toDateString(new Date(asUtc.getTime() - offset * MS_PER_DAY));
}

export function periodKey(
  instant: string | Date,
  granularity: Granularity,
  timeZone: string,
): string {
  switch (granularity) {
    case 'daily':
      return dayKey(instant, timeZone);
    case 'weekly':
      return weekKey(instant, timeZone);
    case 'monthly':
      return monthKey(instant, timeZone);
  }
}

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = offsetFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  offsetFormatterCache.set(timeZone, formatter);
  return formatter;
}

/** Minutes `timeZone` is ahead of UTC at `instant` (DST included). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of offsetFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  // Some ICU builds render midnight as hour 24; both mean the same instant.
  const hour = (parts.hour ?? 0) % 24;
  const wallClock = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    hour,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return Math.round((wallClock - instant.getTime()) / 60_000);
}

/**
 * The instant at which a calendar day starts *in `timeZone`*.
 *
 * Needed for sources that report a local calendar day rather than a UTC bucket
 * (ccusage groups by the timezone it was asked for). Naively treating such a day
 * as UTC midnight moves it a day west of UTC. Two passes so a day that begins
 * inside a DST transition resolves to the offset in force at its own start.
 */
export function zonedDayStart(day: string, timeZone: string): Date {
  const naive = new Date(`${day}T00:00:00Z`).getTime();
  if (timeZone === 'UTC') return new Date(naive);
  let instant = new Date(naive);
  for (let pass = 0; pass < 2; pass += 1) {
    instant = new Date(naive - offsetMinutes(instant, timeZone) * 60_000);
  }
  return instant;
}

/** Start of the day after `day`, in `timeZone` — an exclusive bucket end. */
export function zonedDayEnd(day: string, timeZone: string): Date {
  return zonedDayStart(addDays(day, 1), timeZone);
}

export function addDays(date: string, days: number): string {
  return toDateString(new Date(new Date(`${date}T00:00:00Z`).getTime() + days * MS_PER_DAY));
}

/** Start of a UTC calendar day, as an instant. */
export function dayStartUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** Start of the day *after* `date` — the exclusive end of an inclusive range. */
export function dayEndUtc(date: string): Date {
  return dayStartUtc(addDays(date, 1));
}

export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * The default window: the last `days` calendar days including today, in UTC.
 * 30 days is not arbitrary — it is OpenRouter's hard lookback limit, so the
 * default range is one every provider can actually answer.
 */
export function defaultRange(now: Date, days = 30): DateRange {
  const until = toDateString(now);
  return { since: addDays(until, -(days - 1)), until };
}

export function daysBetween(since: string, until: string): number {
  return Math.round((dayStartUtc(until).getTime() - dayStartUtc(since).getTime()) / MS_PER_DAY);
}

/**
 * The UTC instants to *fetch*, for a requested local-date range. Non-UTC
 * timezones need a day of slack on both ends because a local day overlaps two
 * UTC days; rows outside the requested range are dropped after grouping.
 */
export function fetchWindow(range: DateRange, timeZone: string): { start: Date; end: Date } {
  const slack = timeZone === 'UTC' ? 0 : 1;
  return {
    start: dayStartUtc(addDays(range.since, -slack)),
    end: dayEndUtc(addDays(range.until, slack)),
  };
}

/** Does a period key fall inside the requested range? */
export function periodInRange(key: string, granularity: Granularity, range: DateRange): boolean {
  switch (granularity) {
    case 'daily':
      return key >= range.since && key <= range.until;
    case 'weekly': {
      // A week is in range when it overlaps the range at all.
      const weekEnd = addDays(key, 6);
      return weekEnd >= range.since && key <= range.until;
    }
    case 'monthly':
      return key >= range.since.slice(0, 7) && key <= range.until.slice(0, 7);
  }
}
