// The shared chart module: axis arithmetic, the fixed colour order, and what
// LineChart draws for one series and for several.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LineChart } from './LineChart';
import { Sparkline } from './Sparkline';
import { CHART_COLORS, CHART_OTHER, seriesColor } from './palette';
import { fmtTick, fmtValue, linePath, linear, nearestIndex, niceCeil, timeMarks, valueMarks } from './scale';

describe('chart scales', () => {
  it('rounds an axis top up to a clean number', () => {
    expect(niceCeil(93.2)).toBe(100);
    expect(niceCeil(41)).toBe(50);
    expect(niceCeil(321)).toBe(400);
    expect(niceCeil(1.05)).toBe(1.2);
    expect(niceCeil(0)).toBe(1);
  });

  it('spreads value marks evenly, both ends included', () => {
    expect(valueMarks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('formats values compactly from 1,000 up', () => {
    expect(fmtValue(0.456)).toBe('0.46');
    expect(fmtValue(40.31)).toBe('40.3');
    expect(fmtValue(321.4)).toBe('321');
    expect(fmtValue(1284)).toBe('1.3K');
    expect(fmtValue(12900)).toBe('13K');
    expect(fmtValue(4.2e6)).toBe('4.2M');
    expect(fmtValue(NaN)).toBe('—');
  });

  it('labels ticks by day, and by time of day when asked', () => {
    expect(fmtTick(0, false)).toBe('D1');
    expect(fmtTick(11 * 96 + 24, true)).toBe('D12 06:00');
    expect(fmtTick(96 + 1, true)).toBe('D2 00:15');
  });

  it('puts time marks on whole hours or days, never more than asked for', () => {
    const day = timeMarks(400, 496); // one day
    expect(day.withTime).toBe(true);
    expect(day.ticks.every((t) => t % 24 === 0)).toBe(true); // every 6 h
    expect(day.ticks.length).toBeLessThanOrEqual(6);
    const month = timeMarks(0, 30 * 96);
    expect(month.withTime).toBe(false);
    expect(month.ticks.every((t) => t % 96 === 0)).toBe(true);
    expect(month.ticks.length).toBeLessThanOrEqual(7);
  });

  it('finds the sample nearest the pointer', () => {
    const xs = [4, 8, 12, 16];
    expect(nearestIndex(xs, 9)).toBe(1);
    expect(nearestIndex(xs, 10.1)).toBe(2);
    expect(nearestIndex(xs, -50)).toBe(0);
    expect(nearestIndex(xs, 999)).toBe(3);
    expect(nearestIndex([], 3)).toBe(-1);
  });

  it('maps data onto pixels and draws a path that skips gaps', () => {
    const sx = linear(0, 10, 0, 100);
    const sy = linear(0, 1, 50, 0);
    expect(sx(5)).toBe(50);
    expect(linePath([0, 5, 10], [0, 1, 0.5], sx, sy)).toBe('M0.0 50.0L50.0 0.0L100.0 25.0');
    expect(linePath([0, 5, 10], [0, NaN, 0.5], sx, sy)).toBe('M0.0 50.0M100.0 25.0');
  });
});

describe('chart colours', () => {
  it('assigns colours in a fixed order and never cycles', () => {
    expect(seriesColor(0)).toBe('#1764d6'); // the brand blue leads
    expect(new Set(CHART_COLORS).size).toBe(CHART_COLORS.length);
    expect(seriesColor(CHART_COLORS.length)).toBe(CHART_OTHER);
    expect(CHART_COLORS).not.toContain('#d1372f'); // alarm red stays reserved for alarms
  });
});

describe('LineChart', () => {
  const x = [4, 8, 12, 16];

  it('names a single series by its title, labels the end of the line, and has no legend', () => {
    const html = renderToStaticMarkup(
      <LineChart title="Crude in" unit="t/h" x={x} series={[{ label: 'Crude', values: [300, 310, 320, 321.4] }]} testId="c" />,
    );
    expect(html).toContain('Crude in');
    expect(html).toContain('t/h');
    expect(html).not.toContain('data-testid="c-legend"');
    expect(html).toContain('>321<'); // the latest value, at the line's end
    expect(html.match(/stroke-width="2"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain('<table class="sr-only">'); // the values as a table
  });

  it('shows a legend with latest values for several series, in palette order', () => {
    const html = renderToStaticMarkup(
      <LineChart
        unit="$"
        x={x}
        series={[
          { label: 'Revenue', values: [1, 2, 3, 4] },
          { label: 'Freight', values: [0.5, 0.6, 0.7, 0.8], min: [0.4, 0.5, 0.6, 0.7], max: [0.6, 0.7, 0.8, 0.9] },
        ]}
        testId="c"
      />,
    );
    expect(html).toContain('data-testid="c-legend"');
    expect(html).toContain('Revenue');
    expect(html).toContain('Freight');
    expect(html).toContain(CHART_COLORS[0]);
    expect(html).toContain(CHART_COLORS[1]);
    expect(html).toContain('fill-opacity="0.14"'); // the min–max band
  });

  it('draws reference lines with their labels and says so when there is no history', () => {
    const withRef = renderToStaticMarkup(
      <LineChart unit="t/h" x={x} series={[{ label: 'CDU', values: [300, 310, 320, 321] }]} refLines={[{ value: 353, label: 'capacity' }]} />,
    );
    expect(withRef).toContain('capacity');
    const empty = renderToStaticMarkup(<LineChart unit="t/h" series={[{ label: 'CDU', values: [] }]} />);
    expect(empty).toContain('No history yet');
  });
});

describe('Sparkline', () => {
  it('draws a line for two or more values and nothing for fewer', () => {
    expect(renderToStaticMarkup(<Sparkline values={[1, 2, 3]} />)).toContain('<path');
    expect(renderToStaticMarkup(<Sparkline values={[1]} />)).not.toContain('<path');
  });
});
