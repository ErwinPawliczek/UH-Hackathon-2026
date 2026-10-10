import { describe, expect, it } from 'vitest';
import {
  fmtClock, fmtDaysOfCover, fmtDelta, fmtPct, hoursOfCover,
} from './format';

describe('fmtClock', () => {
  it('formats tick 0 as day 1 00:00', () => {
    expect(fmtClock(0)).toBe('D1 00:00');
  });

  it('formats mid-day and day boundaries (96 ticks per day, 15-min quarters)', () => {
    expect(fmtClock(37)).toBe('D1 09:15'); // 37 = 9h + 1 quarter
    expect(fmtClock(96)).toBe('D2 00:00');
    expect(fmtClock(2 * 96 + 4 * 13 + 2)).toBe('D3 13:30');
  });
});

describe('fmtDelta', () => {
  it('renders null and past targets as — and now', () => {
    expect(fmtDelta(100, null)).toBe('—');
    expect(fmtDelta(100, 100)).toBe('now');
    expect(fmtDelta(100, 40)).toBe('now');
  });

  it('renders hours and day+hour offsets', () => {
    expect(fmtDelta(100, 100 + 5 * 4)).toBe('+5h');
    expect(fmtDelta(100, 100 + 2 * 96 + 3 * 4)).toBe('+2d 03h');
  });
});

describe('fmtDaysOfCover', () => {
  it('maps ~0 hours to an em dash', () => {
    expect(fmtDaysOfCover(0)).toBe('—');
  });

  it('formats days with one decimal', () => {
    expect(fmtDaysOfCover(4.2 * 24)).toBe('4.2 d');
  });
});

describe('hoursOfCover', () => {
  const cap = 100_000; // t
  const draw = 500; // t/h

  it('divides stock by the current draw', () => {
    // fill 50% → 50_000 t at 500 t/h × full rate = 100 h
    expect(hoursOfCover(0.5, cap, draw, 1)).toBeCloseTo(100, 6);
  });

  it('scales with the rate factor', () => {
    expect(hoursOfCover(0.5, cap, draw, 0.5)).toBeCloseTo(200, 6);
  });

  it('returns 0 (indefinite) when nothing draws or the plant is idle', () => {
    expect(hoursOfCover(0.5, cap, 0, 1)).toBe(0);
    expect(hoursOfCover(0.5, cap, draw, 0)).toBe(0);
  });
});

describe('fmtPct', () => {
  it('rounds to whole percents', () => {
    expect(fmtPct(0.456)).toBe('46%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(1)).toBe('100%');
  });
});
