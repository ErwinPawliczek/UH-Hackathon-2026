// Chart arithmetic, kept apart from the drawing so it is unit-tested: value
// and time axes, clean tick marks, and finding the sample nearest the pointer.
//
// Time on the x axis is in sim ticks (15 simulated minutes each, 96 a day)
// unless a chart says its x is already in days.

export const TICKS_PER_HOUR = 4;
export const TICKS_PER_DAY = 96;

/** A round number at or above `max`, for the top of a value axis. */
export function niceCeil(max: number): number {
  if (!(max > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= max - 1e-9) return m * pow;
  return 10 * pow;
}

/** Evenly spaced marks from `min` to `max` inclusive: `count` intervals. */
export function valueMarks(min: number, max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => min + ((max - min) * i) / count);
}

/** A value for an axis or a readout: compact from 1,000 up, one decimal under 100. */
export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${Math.round(v / 1e3)}K`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return (Math.round(v * 10) / 10).toString();
  return (Math.round(v * 100) / 100).toString();
}

/** A tick as "D5" or, with the time, "D5 06:00" (day 1 starts at tick 0). */
export function fmtTick(tick: number, withTime: boolean): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  if (!withTime) return `D${day}`;
  const minutes = Math.round(((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY) * (1440 / TICKS_PER_DAY);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(Math.round(minutes % 60)).padStart(2, '0');
  return `D${day} ${hh}:${mm}`;
}

/** Spacings a time axis may use, in ticks: 1 h, 3 h, 6 h, 12 h, 1 d, 2 d, 5 d, 10 d, 20 d. */
const TIME_STEPS = [4, 12, 24, 48, 96, 192, 480, 960, 1920];

/**
 * Marks for a time axis from `from` to `to` (ticks): on whole hours or days,
 * at most `maxMarks` of them. `withTime` says whether a label needs the
 * time of day (the span is short) or the day alone will do.
 */
export function timeMarks(from: number, to: number, maxMarks = 6): { ticks: number[]; withTime: boolean } {
  const span = Math.max(1, to - from);
  const step = TIME_STEPS.find((s) => span / s <= maxMarks) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const ticks: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to + 1e-9; t += step) ticks.push(t);
  return { ticks, withTime: step < TICKS_PER_DAY };
}

/** Index of the entry of ascending `xs` nearest to `x`; -1 for an empty list. */
export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

/** A linear map from a data range onto a pixel range. */
export function linear(d0: number, d1: number, p0: number, p1: number): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v) => p0 + ((v - d0) / span) * (p1 - p0);
}

/** Polyline path data through the points, skipping values that are not numbers. */
export function linePath(xs: number[], ys: number[], sx: (v: number) => number, sy: (v: number) => number): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < xs.length && i < ys.length; i++) {
    if (!Number.isFinite(ys[i])) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${sx(xs[i]).toFixed(1)} ${sy(ys[i]).toFixed(1)}`;
    pen = true;
  }
  return d;
}
