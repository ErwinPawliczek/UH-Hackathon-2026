// A hand-rolled SVG line chart for values over simulated time: one or more
// series on one value axis (never two), with clean axis marks, a unit, an
// optional min-max band per series, reference lines, and a hover readout —
// a crosshair that snaps to the nearest sample and one tooltip listing every
// series there. Keyboard: focus the chart and use the arrow keys.
//
// Conventions it enforces: 2 px lines with round joins; hairline grid; text
// in ink and muted, never in a series colour; a legend whenever there are
// two or more series (a single series is named by the title); the last
// value of a single series written at the end of its line; a table of the
// plotted values for screen readers.
//
// Series colours come from charts/palette in fixed order unless a series
// brings its own. More than seven series should be folded by the caller.

import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CHART_INK, seriesColor } from './palette';
import { dayMarks, fmtDay, fmtTick, fmtValue, linePath, linear, nearestIndex, niceCeil, timeMarks, valueMarks } from './scale';

export interface ChartSeries {
  label: string;
  /** line colour; the palette slot of its position when omitted */
  color?: string;
  values: number[];
  /** x of each value; the chart's shared `x` when omitted */
  x?: number[];
  /** optional band drawn behind the line, e.g. the lowest and highest across plants */
  min?: number[];
  max?: number[];
}

export interface LineChartProps {
  series: ChartSeries[];
  /** shared x positions, for series that bring none of their own */
  x?: number[];
  /**
   * what x is: sim ticks (15 simulated minutes; marks by day, or day and time
   * on a short span; readout "D5 06:00") or days (marks on whole days, "D5";
   * readout "Day 5") — use days for one value per day
   */
  xUnit?: 'ticks' | 'days';
  /** unit of the values, shown on the axis and in the readout (e.g. "t/h", "%", "$") */
  unit: string;
  /** names the chart; with a single series it stands in for the legend */
  title?: string;
  width?: number;
  height?: number;
  /** bottom and top of the value axis; 0 and a round number above the data by default */
  yMin?: number;
  yMax?: number;
  /** horizontal reference lines with a label (a design rate, a capacity) */
  refLines?: { value: number; label: string }[];
  /** a light wash under the line of a single-series chart */
  area?: boolean;
  /** number formatting for marks and readouts */
  format?: (v: number) => string;
  testId?: string;
}

const M = { top: 10, right: 46, bottom: 22, left: 40 };

export function LineChart({
  series, x, xUnit = 'ticks', unit, title, width = 560, height = 180, yMin = 0, yMax, refLines = [],
  area = false, format = fmtValue, testId,
}: LineChartProps) {
  const [hoverX, setHoverX] = useState<number | null>(null);

  const drawn = series
    .map((s, i) => ({ ...s, xs: s.x ?? x ?? s.values.map((_, k) => k), color: s.color ?? seriesColor(i) }))
    .filter((s) => s.values.length > 0 && s.xs.length > 0);
  const allX = drawn.flatMap((s) => s.xs);
  const allY = drawn.flatMap((s) => [...s.values, ...(s.max ?? []), ...(s.min ?? [])]).filter(Number.isFinite);
  const empty = drawn.length === 0 || allX.length === 0;

  const x0 = empty ? 0 : Math.min(...allX);
  const x1 = empty ? 1 : Math.max(...allX);
  const top = yMax ?? niceCeil(Math.max(yMin + 1e-9, ...allY, ...refLines.map((r) => r.value)));
  const sx = linear(x0, x1 === x0 ? x0 + 1 : x1, M.left, width - M.right);
  const sy = linear(yMin, top, height - M.bottom, M.top);
  // In days mode x is already a day number: marks sit on whole days ("D5")
  // and a readout names the day ("Day 5"). In ticks mode a mark is a day, or
  // a day and time when the span is short, and a readout always has the time.
  const fmtX = (v: number, readout: boolean) => (xUnit === 'days' ? fmtDay(v, readout) : fmtTick(v, readout));
  const xMarks = xUnit === 'days'
    ? { ticks: dayMarks(x0, x1), withTime: false }
    : timeMarks(x0, x1);
  const yMarks = valueMarks(yMin, top, 4);

  // the longest x list is what the crosshair snaps along
  const spine = drawn.reduce<number[]>((best, s) => (s.xs.length > best.length ? s.xs : best), []);
  const at = hoverX === null || spine.length === 0 ? null : spine[nearestIndex(spine, hoverX)];
  const readout = at === null ? [] : drawn.map((s) => {
    const i = nearestIndex(s.xs, at);
    return { label: s.label, color: s.color, value: i < 0 ? NaN : s.values[i] };
  });

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = M.left + ((e.clientX - rect.left) / Math.max(1, rect.width)) * (width - M.left - M.right);
    setHoverX(x0 + ((px - M.left) / (width - M.left - M.right)) * (x1 - x0));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (spine.length === 0 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const cur = at === null ? spine.length - 1 : nearestIndex(spine, at);
    const next = Math.min(spine.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    setHoverX(spine[next]);
  };

  const tipLeft = at === null ? 0 : sx(at);
  const single = drawn.length === 1 ? drawn[0] : null;
  const sample = (n: number) => {
    // up to n evenly spread rows of the first series' x, for the screen-reader table
    const xs = spine;
    if (xs.length <= n) return xs;
    return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
  };

  return (
    <figure className="m-0" data-testid={testId}>
      {(title !== undefined || drawn.length > 1) && (
        <figcaption className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
          {title !== undefined && <span className="font-semibold text-ink">{title}</span>}
          <span className="text-muted">{unit}</span>
          {drawn.length > 1 && (
            <span className="flex flex-wrap gap-x-3 gap-y-0.5" data-testid={testId === undefined ? undefined : `${testId}-legend`}>
              {drawn.map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1.5 text-muted">
                  <span aria-hidden="true" className="inline-block h-0.5 w-3.5 rounded-sm" style={{ backgroundColor: s.color }} />
                  {s.label}
                  <span className="data text-ink">{format(s.values[s.values.length - 1])}</span>
                </span>
              ))}
            </span>
          )}
        </figcaption>
      )}

      <div className="relative" style={{ width }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title ?? 'Chart'}${unit === '' ? '' : `, ${unit}`}${single !== null && !empty ? `: now ${format(single.values[single.values.length - 1])}` : ''}`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHoverX(null)}
          className="block focus:outline-none focus-visible:ring-1 focus-visible:ring-blue"
        >
          {/* value grid and marks */}
          {yMarks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={sy(v)} y2={sy(v)} stroke={CHART_INK.grid} strokeWidth={1} />
              <text x={M.left - 6} y={sy(v) + 3.5} textAnchor="end" fontSize={10} fill={CHART_INK.muted} fontFamily="var(--f-mono)">
                {format(v)}
              </text>
            </g>
          ))}
          {/* time marks */}
          {!empty && xMarks.ticks.map((t) => (
            <g key={t}>
              <line x1={sx(t)} x2={sx(t)} y1={height - M.bottom} y2={height - M.bottom + 4} stroke={CHART_INK.axis} strokeWidth={1} />
              <text x={sx(t)} y={height - 6} textAnchor="middle" fontSize={10} fill={CHART_INK.muted} fontFamily="var(--f-mono)">
                {fmtX(t, xMarks.withTime)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={width - M.right} y1={height - M.bottom} y2={height - M.bottom} stroke={CHART_INK.axis} strokeWidth={1} />

          {/* reference lines, labelled at the right edge */}
          {refLines.map((r) => (
            <g key={r.label}>
              <line x1={M.left} x2={width - M.right} y1={sy(r.value)} y2={sy(r.value)} stroke={CHART_INK.muted} strokeWidth={1} />
              <text x={width - M.right + 4} y={sy(r.value) + 3.5} fontSize={10} fill={CHART_INK.muted}>{r.label}</text>
            </g>
          ))}

          {/* bands, washes, lines, end dots */}
          {drawn.map((s) => {
            const band = s.min !== undefined && s.max !== undefined && s.min.length === s.xs.length && s.max.length === s.xs.length
              ? `${linePath(s.xs, s.max, sx, sy)}${linePath([...s.xs].reverse(), [...s.min].reverse(), sx, sy).replace('M', 'L')}Z`
              : null;
            const last = Math.min(s.xs.length, s.values.length) - 1;
            return (
              <g key={s.label}>
                {band !== null && <path d={band} fill={s.color} fillOpacity={0.14} stroke="none" />}
                {area && single !== null && last > 0 && (
                  <path
                    d={`${linePath(s.xs, s.values, sx, sy)}L${sx(s.xs[last]).toFixed(1)} ${sy(yMin).toFixed(1)}L${sx(s.xs[0]).toFixed(1)} ${sy(yMin).toFixed(1)}Z`}
                    fill={s.color}
                    fillOpacity={0.1}
                    stroke="none"
                  />
                )}
                <path d={linePath(s.xs, s.values, sx, sy)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {last >= 0 && Number.isFinite(s.values[last]) && (
                  <circle cx={sx(s.xs[last])} cy={sy(s.values[last])} r={4} fill={s.color} stroke={CHART_INK.surface} strokeWidth={2} />
                )}
              </g>
            );
          })}
          {/* a single series carries its latest value at the end of the line */}
          {single !== null && !empty && Number.isFinite(single.values[single.values.length - 1]) && (
            <text
              x={width - M.right + 8}
              y={sy(single.values[single.values.length - 1]) + (refLines.some((r) => Math.abs(sy(r.value) - sy(single.values[single.values.length - 1])) < 11) ? -8 : 3.5)}
              fontSize={11}
              fontWeight={600}
              fill={CHART_INK.text}
              fontFamily="var(--f-mono)"
            >
              {format(single.values[single.values.length - 1])}
            </text>
          )}

          {empty && (
            <text x={(M.left + width - M.right) / 2} y={(M.top + height - M.bottom) / 2} textAnchor="middle" fontSize={11} fill={CHART_INK.muted}>
              No history yet — the first point arrives after one simulated hour.
            </text>
          )}

          {/* crosshair */}
          {at !== null && (
            <g pointerEvents="none">
              <line x1={sx(at)} x2={sx(at)} y1={M.top} y2={height - M.bottom} stroke={CHART_INK.muted} strokeWidth={1} />
              {readout.map((r) => Number.isFinite(r.value) && (
                <circle key={r.label} cx={sx(at)} cy={sy(r.value)} r={4} fill={r.color} stroke={CHART_INK.surface} strokeWidth={2} />
              ))}
            </g>
          )}
          {/* the pointer only has to be over the plot, never on a line */}
          <rect
            x={M.left}
            y={M.top}
            width={Math.max(0, width - M.left - M.right)}
            height={Math.max(0, height - M.top - M.bottom)}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverX(null)}
          />
        </svg>

        {at !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-sm border border-line bg-white px-2 py-1 text-xs"
            style={tipLeft > width / 2 ? { right: width - tipLeft + 8 } : { left: tipLeft + 8 }}
            role="status"
            data-testid={testId === undefined ? undefined : `${testId}-readout`}
          >
            <div className="data mb-0.5 text-muted">{fmtX(at, true)}</div>
            {readout.map((r) => (
              <div key={r.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded-sm" style={{ backgroundColor: r.color }} />
                <span className="data font-semibold text-ink">{format(r.value)}{unit === '' ? '' : ` ${unit}`}</span>
                {drawn.length > 1 && <span className="text-muted">{r.label}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* the plotted values as a table, for readers who cannot use the picture */}
      {!empty && (
        <table className="sr-only">
          <caption>{title ?? 'Chart'}{unit === '' ? '' : ` (${unit})`}</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {drawn.map((s) => <th key={s.label} scope="col">{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {sample(12).map((t) => (
              <tr key={t}>
                <th scope="row">{fmtX(t, true)}</th>
                {drawn.map((s) => <td key={s.label}>{format(s.values[nearestIndex(s.xs, t)])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
