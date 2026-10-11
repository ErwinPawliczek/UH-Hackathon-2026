// A sparkline: the shape of one series in a table row — no axes, no labels.
// The value itself is always written beside it by the caller.

import { CHART_COLORS } from './palette';
import { linePath, linear } from './scale';

export function Sparkline({
  values,
  x,
  width = 96,
  height = 20,
  max,
  color = CHART_COLORS[0],
}: {
  values: number[];
  /** x of each value; evenly spaced when omitted */
  x?: number[];
  width?: number;
  height?: number;
  /** top of the scale; the series' own maximum when omitted (0 is always the bottom) */
  max?: number;
  color?: string;
}) {
  const xs = x ?? values.map((_, i) => i);
  if (values.length < 2 || xs.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const top = Math.max(max ?? 0, ...values.filter(Number.isFinite), 1e-9);
  const sx = linear(xs[0], xs[xs.length - 1], 2, width - 4);
  const sy = linear(0, top, height - 2.5, 2.5);
  const last = values.length - 1;
  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0">
      <path d={linePath(xs, values, sx, sy)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={sx(xs[last])} cy={sy(values[last])} r={2.2} fill={color} />
    </svg>
  );
}
