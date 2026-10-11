// The site window's Economics tab: the model's curves, in the order the
// model applies them, with this site's tanks marked on each. Only the charts
// that apply to the site are shown; each keeps its number (1 to 8), so a
// customer shows 4, 6 and 7 and a source 2 and 5.
//
// Each chart is the curve as a line, one labelled dot per tank in shades of
// blue (alarm red for the one that is holding the plant back), and one plain
// sentence. Chart 3 is bars: the limits side by side, the lowest named.

import { CHART_INK } from './charts/palette';
import { linePath, linear } from './charts/scale';
import { econMissing, siteCharts, useSiteEcon, type EconChart } from './siteEcon';

const H = 120;
const M = { top: 8, right: 12, bottom: 24, left: 38 };
const fmt = (v: number, unit: 'x' | 'pct') => (unit === 'pct' ? `${Math.round(v * 100)}%` : (Math.round(v * 100) / 100).toString());

function Curve({ chart, width }: { chart: EconChart; width: number }) {
  const [x0, x1] = chart.xDomain;
  const [y0, y1] = chart.yDomain;
  const sx = linear(x0, x1, M.left, width - M.right);
  const sy = linear(y0, y1, H - M.bottom, M.top);
  const xs = chart.curve.map((p) => p[0]);
  const ys = chart.curve.map((p) => p[1]);
  const yMarks = [y0, (y0 + y1) / 2, y1];
  const xMarks = [x0, (x0 + x1) / 2, x1];
  return (
    <svg width={width} height={H} role="img" aria-label={`${chart.title}. ${chart.sentence}`} className="block">
      {yMarks.map((v) => (
        <g key={v}>
          <line x1={M.left} x2={width - M.right} y1={sy(v)} y2={sy(v)} stroke={CHART_INK.grid} strokeWidth={1} />
          <text x={M.left - 5} y={sy(v) + 3.5} textAnchor="end" fontSize={10} fill={CHART_INK.muted} fontFamily="var(--f-mono)">{fmt(v, chart.yUnit)}</text>
        </g>
      ))}
      {xMarks.map((v) => (
        <text key={v} x={sx(v)} y={H - 8} textAnchor="middle" fontSize={10} fill={CHART_INK.muted} fontFamily="var(--f-mono)">{fmt(v, chart.xUnit)}</text>
      ))}
      <line x1={M.left} x2={width - M.right} y1={H - M.bottom} y2={H - M.bottom} stroke={CHART_INK.axis} strokeWidth={1} />
      <path d={linePath(xs, ys, sx, sy)} fill="none" stroke={CHART_INK.text} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {chart.dots.map((d) => (
        <circle key={d.label} cx={sx(Math.min(x1, Math.max(x0, d.x)))} cy={sy(Math.min(y1, Math.max(y0, d.y)))} r={5} fill={d.alarm ? 'var(--alarm)' : d.color} stroke={CHART_INK.surface} strokeWidth={2}>
          <title>{`${d.label}: ${fmt(d.x, chart.xUnit)}, ${fmt(d.y, chart.yUnit)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function Bars({ chart }: { chart: EconChart }) {
  return (
    <ul className="flex flex-col gap-1.5 py-1" data-testid="econ-bars">
      {(chart.bars ?? []).map((b) => (
        <li key={b.label} className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-2 text-xs">
          <span className={b.lowest ? 'font-semibold text-alarm' : 'text-ink'}>{b.label}</span>
          <span className="block h-2.5 overflow-hidden rounded-sm bg-line" aria-hidden="true">
            <span className="block h-full rounded-sm" style={{ width: `${Math.max(1, Math.min(100, b.value * 100))}%`, backgroundColor: b.lowest ? 'var(--alarm)' : 'var(--blue)' }} />
          </span>
          <span className="data text-right text-ink">{Math.round(b.value * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

export function SiteEconomics({ site, open, width }: { site: number; open: boolean; width: number }) {
  const econ = useSiteEcon(open, site);
  if (econ.data === null) {
    return (
      <p className="py-4 text-sm text-muted" data-testid="site-econ-empty">
        {econMissing(econ.error)
          ? 'Not available yet: this server does not report a site’s economics.'
          : econ.error !== null ? `This site’s economics could not be loaded: ${econ.error}` : 'Reading the model…'}
      </p>
    );
  }
  const charts = siteCharts(econ.data);
  if (charts.length === 0) return <p className="py-4 text-sm text-muted" data-testid="site-econ-empty">Not available yet: nothing the model does applies to this site, or the server sent no figures.</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="site-economics">
      <p className="text-xs text-muted">The model&apos;s rules in the order it applies them, with this site marked on each. The line is the rule; each dot is one of its tanks.</p>
      {charts.map((c) => (
        <section key={c.key} data-testid={`econ-chart-${c.key}`}>
          <h3 className="mb-0.5 text-xs font-semibold text-ink"><span className="data mr-1.5 text-muted">{c.n}</span>{c.title}</h3>
          {c.bars !== undefined ? <Bars chart={c} /> : (
            <>
              <Curve chart={c} width={width} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
                <span>{c.xLabel} → · ↑ {c.yLabel}</span>
                {c.dots.map((d) => (
                  <span key={d.label} className={`inline-flex items-center gap-1 ${d.alarm ? 'font-semibold text-alarm' : 'text-ink'}`}>
                    <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: d.alarm ? 'var(--alarm)' : d.color }} />
                    {d.label}
                  </span>
                ))}
              </div>
            </>
          )}
          <p className="mt-0.5 text-xs text-ink" data-testid={`econ-sentence-${c.key}`}>{c.sentence}</p>
        </section>
      ))}
    </div>
  );
}
