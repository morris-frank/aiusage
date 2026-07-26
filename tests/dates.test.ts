import { describe, expect, it } from 'vitest';
import {
  addDays,
  DateInputError,
  dayKey,
  defaultRange,
  fetchWindow,
  isValidTimeZone,
  monthKey,
  parseDateInput,
  periodInRange,
  periodKey,
  weekKey,
  zonedDayEnd,
  zonedDayStart,
} from '../src/dates.js';

describe('parseDateInput', () => {
  it('accepts both accepted spellings and canonicalises them', () => {
    expect(parseDateInput('2026-07-26')).toBe('2026-07-26');
    expect(parseDateInput('20260726')).toBe('2026-07-26');
    expect(parseDateInput('  20260726 ')).toBe('2026-07-26');
  });

  it('rejects impossible dates rather than rolling them over', () => {
    expect(() => parseDateInput('2026-02-30')).toThrow(DateInputError);
    expect(() => parseDateInput('2026-13-01')).toThrow(DateInputError);
    expect(() => parseDateInput('26-07-26')).toThrow(DateInputError);
  });
});

describe('period keys', () => {
  it('groups by UTC day by default', () => {
    expect(dayKey('2026-07-26T23:59:59Z', 'UTC')).toBe('2026-07-26');
    expect(monthKey('2026-07-26T23:59:59Z', 'UTC')).toBe('2026-07');
  });

  it('shifts the day when a timezone moves the instant across midnight', () => {
    // 23:30 UTC is already the next day in Berlin (UTC+2 in July).
    expect(dayKey('2026-07-26T23:30:00Z', 'Europe/Berlin')).toBe('2026-07-27');
    // 01:00 UTC is still the previous day in Los Angeles.
    expect(dayKey('2026-07-26T01:00:00Z', 'America/Los_Angeles')).toBe('2026-07-25');
  });

  it('labels weeks with their Monday, independent of locale', () => {
    // 2026-07-26 is a Sunday; its ISO week starts Monday 2026-07-20.
    expect(weekKey('2026-07-26T12:00:00Z', 'UTC')).toBe('2026-07-20');
    expect(weekKey('2026-07-20T00:00:00Z', 'UTC')).toBe('2026-07-20');
    expect(weekKey('2026-07-27T00:00:00Z', 'UTC')).toBe('2026-07-27');
  });

  it('dispatches on granularity', () => {
    const instant = '2026-07-26T12:00:00Z';
    expect(periodKey(instant, 'daily', 'UTC')).toBe('2026-07-26');
    expect(periodKey(instant, 'weekly', 'UTC')).toBe('2026-07-20');
    expect(periodKey(instant, 'monthly', 'UTC')).toBe('2026-07');
  });
});

describe('ranges', () => {
  it('defaults to the trailing 30 days, inclusive of today', () => {
    expect(defaultRange(new Date('2026-07-26T10:00:00Z'))).toEqual({
      since: '2026-06-27',
      until: '2026-07-26',
    });
  });

  it('honours an explicit window length', () => {
    expect(defaultRange(new Date('2026-07-26T10:00:00Z'), 1)).toEqual({
      since: '2026-07-26',
      until: '2026-07-26',
    });
  });

  it('adds a day of slack on both ends only when grouping outside UTC', () => {
    const range = { since: '2026-07-01', until: '2026-07-31' };
    expect(fetchWindow(range, 'UTC')).toEqual({
      start: new Date('2026-07-01T00:00:00Z'),
      end: new Date('2026-08-01T00:00:00Z'),
    });
    expect(fetchWindow(range, 'Asia/Tokyo')).toEqual({
      start: new Date('2026-06-30T00:00:00Z'),
      end: new Date('2026-08-02T00:00:00Z'),
    });
  });

  it('keeps a week that only partially overlaps the range', () => {
    const range = { since: '2026-07-22', until: '2026-07-24' };
    expect(periodInRange('2026-07-20', 'weekly', range)).toBe(true);
    expect(periodInRange('2026-07-13', 'weekly', range)).toBe(false);
    expect(periodInRange('2026-07-21', 'daily', range)).toBe(false);
    expect(periodInRange('2026-07', 'monthly', range)).toBe(true);
  });

  it('moves dates without drifting across DST', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('isValidTimeZone', () => {
  it('separates real zones from typos', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

/**
 * Sources that report a *local* calendar day (ccusage) need the instant that day
 * began in the reporting zone; treating it as UTC midnight files a day of usage
 * under the wrong date for every zone west of UTC.
 */
describe('zonedDayStart', () => {
  it('is UTC midnight in UTC', () => {
    expect(zonedDayStart('2026-07-25', 'UTC').toISOString()).toBe('2026-07-25T00:00:00.000Z');
  });

  it('is the local start of day in a zone behind UTC', () => {
    expect(zonedDayStart('2026-07-25', 'America/New_York').toISOString()).toBe(
      '2026-07-25T04:00:00.000Z',
    );
  });

  it('is the local start of day in a zone ahead of UTC', () => {
    expect(zonedDayStart('2026-07-25', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-24T22:00:00.000Z',
    );
    expect(zonedDayStart('2026-07-25', 'Asia/Tokyo').toISOString()).toBe(
      '2026-07-24T15:00:00.000Z',
    );
  });

  it('uses the offset in force on the day itself, across a DST change', () => {
    // Berlin is UTC+1 in winter and UTC+2 in summer; the spring change is 2026-03-29.
    expect(zonedDayStart('2026-03-28', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-27T23:00:00.000Z',
    );
    expect(zonedDayStart('2026-03-30', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
  });

  it('ends a day where the next one starts', () => {
    expect(zonedDayEnd('2026-07-25', 'America/New_York').toISOString()).toBe(
      zonedDayStart('2026-07-26', 'America/New_York').toISOString(),
    );
  });

  it('keeps a local day grouping under its own date', () => {
    for (const zone of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo', 'Pacific/Apia']) {
      expect(dayKey(zonedDayStart('2026-07-25', zone), zone)).toBe('2026-07-25');
    }
  });
});
