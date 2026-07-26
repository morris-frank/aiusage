import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  centsStringToMicros,
  formatUsd,
  microsToUsd,
  sumReportedMicros,
  usdToMicros,
} from '../src/money.js';

describe('unit conversion', () => {
  it('round-trips USD through micro-USD', () => {
    expect(usdToMicros(1.234567)).toBe(1234567);
    expect(microsToUsd(1234567)).toBeCloseTo(1.234567, 9);
  });

  it('reads Anthropic cent strings, including sub-cent precision', () => {
    // "123.78912" cents is $1.2378912 → 1_237_891.2 micros, rounded.
    expect(centsStringToMicros('123.78912')).toBe(1237891);
    expect(centsStringToMicros('0')).toBe(0);
  });

  it('returns null for unparseable amounts instead of guessing zero', () => {
    expect(centsStringToMicros('not-a-number')).toBeNull();
    expect(centsStringToMicros('')).toBe(0); // Number('') is 0, and the API sends "0"
  });

  it('sums exactly where float USD would drift', () => {
    const cents = Array.from({ length: 1000 }, () => usdToMicros(0.0001));
    expect(sumReportedMicros(cents)).toBe(100_000);
    expect(microsToUsd(100_000)).toBe(0.1);
  });
});

describe('sumReportedMicros', () => {
  it('treats null as "not reported", not zero', () => {
    expect(sumReportedMicros([null, null])).toBeNull();
    expect(sumReportedMicros([null, 5])).toBe(5);
    expect(sumReportedMicros([])).toBeNull();
    expect(sumReportedMicros([0])).toBe(0);
  });
});

describe('allocateProportionally', () => {
  it('splits in proportion to the weights', () => {
    expect(allocateProportionally(1000, [1, 1, 2])).toEqual([250, 250, 500]);
  });

  it('never loses or invents a micro-dollar', () => {
    const shares = allocateProportionally(1000, [1, 1, 1]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(1000);
    expect(shares).toEqual([334, 333, 333]);
  });

  it('spreads evenly when no weight carries information', () => {
    expect(allocateProportionally(300, [0, 0, 0])).toEqual([100, 100, 100]);
  });

  it('ignores negative weights rather than inverting the split', () => {
    expect(allocateProportionally(100, [-5, 5])).toEqual([0, 100]);
  });

  it('handles the empty group', () => {
    expect(allocateProportionally(100, [])).toEqual([]);
  });
});

describe('formatUsd', () => {
  it('keeps sub-cent amounts visible instead of rounding them to $0.00', () => {
    expect(formatUsd(4200)).toBe('$0.004200');
    expect(formatUsd(12_340_000)).toBe('$12.34');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(null)).toBe('—');
  });
});
