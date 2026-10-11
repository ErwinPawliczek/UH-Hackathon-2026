// Economy window, Overview: five answers and nothing else. Are customers
// being served, what will the current disruption cost, what stops next,
// which chemicals cost more than usual, and how many plants are running.
// Everything fuller (the cost breakdown, every plant's chart, who else can
// supply a tank) is one link away and has a link back.

import type { EconomyReply, ForecastReply } from '../engine/api';
import { useSim } from '../store/sim';
import { SiteBadge } from './SiteIcon';
import { Sparkline } from './charts/Sparkline';
import { CHART_COLORS } from './charts/palette';
import { countdownSentence, fmtMoney, nothingBroken, useEconomy, useForecast } from './economyData';
import { useEconomyView } from './economyView';
import { SERVICE_ALARM, fmtShare, plantsRunning, pricePressure, serviceNow } from './overviewData';
import { fmtSigned, priceRows, usePriceHistory } from './pricesData';
import { supplierDown, useSourcingList } from './supplyData';

/** Days the disruption forecast looks ahead. */
const FORECAST_DAYS = 30;
const STOPS_SHOWN = 3;
const PLANTS_NAMED = 4;

const LINK = 'cursor-pointer text-left text-xs font-medium text-blue underline decoration-dotted underline-offset-2 hover:text-blue-strong';
const BIG = 'font-display font-bold leading-none text-ink';

function Panel({ label, children, className = '', testId }: { label: string; children: React.ReactNode; className?: string; testId: string }) {
  return (
    <section className={`chamfer chamfer-sm flex min-w-0 flex-col px-3.5 py-2.5 ${className}`} style={{ '--chamfer-fill': 'var(--white)' } as React.CSSProperties} data-testid={testId}>
      <h3 className="label mb-1.5">{label}</h3>
      {children}
    </section>
  );
}

const waiting = <p className="text-sm text-muted">Start the simulation to see this.</p>;

function Served({ reply }: { reply: EconomyReply | null }) {
  const s = reply === null ? null : serviceNow(reply);
  if (s === null) return <p className="text-sm text-muted">{reply === null ? 'Start the simulation to see this.' : 'The first full day is not in yet.'}</p>;
  const low = s.now < SERVICE_ALARM;
  return (
    <>
      <div className={`${BIG} text-5xl`} style={low ? { color: 'var(--alarm)' } : undefined} data-testid="overview-served-now">{fmtShare(s.now)}</div>
      <p className="mt-1 text-xs text-muted">of what customers ordered, on day {s.series.length}{low ? ': below 95%' : ''}</p>
      <div className="mt-auto pt-2" title="Each day so far, from 0 to 100%">
        <Sparkline values={s.series.map((v) => v * 100)} max={100} width={170} height={26} color={low ? 'var(--alarm)' : CHART_COLORS[0]} />
      </div>
    </>
  );
}

function Cost({ f }: { f: ForecastReply | null }) {
  const showDetail = useEconomyView((s) => s.showDetail);
  if (f === null) return waiting;
  if (nothingBroken(f)) {
    return (
      <>
        <div className={`${BIG} text-3xl`} data-testid="overview-cost">Nothing is broken</div>
        <p className="mt-1.5 text-xs text-muted">The next {f.days} days run as planned. Break something from the Scenario menu to see what it costs.</p>
      </>
    );
  }
  const cost = f.delta.cost_usd;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-sm text-ink">{cost >= 0 ? 'This will cost' : 'This will save'}</span>
        <span className={`${BIG} text-5xl`} data-testid="overview-cost">{fmtMoney(Math.abs(cost))}</span>
        <span className="text-sm text-ink">over the next {f.days} days</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {f.disruptions === 1 ? '1 disruption active' : `${f.disruptions} disruptions active`}, against the same {f.days} days with nothing broken.
      </p>
      <button className={`${LINK} mt-auto self-start pt-2`} onClick={() => showDetail('impact')} data-testid="overview-breakdown">See the breakdown</button>
    </>
  );
}

function StopsNext({ f }: { f: ForecastReply | null }) {
  const select = useSim((s) => s.select);
  const world = useSim((s) => s.world);
  const showDetail = useEconomyView((s) => s.showDetail);
  if (f === null) return waiting;
  if (f.countdown.length === 0) return <p className="text-sm text-muted">Nothing stops in the next {f.days} days.</p>;
  // what is still to come first; what has already stopped is named under Plants running
  const ahead = [...f.countdown.filter((r) => !r.already), ...f.countdown.filter((r) => r.already)];
  const rest = f.countdown.length - STOPS_SHOWN;
  return (
    <>
      <ul className="flex flex-col gap-1">
        {ahead.slice(0, STOPS_SHOWN).map((row, i) => (
          <li key={`${row.site}-${row.kind}-${row.what}-${i}`}>
            <button
              className="flex w-full cursor-pointer items-start gap-2 text-left text-sm leading-snug text-ink hover:bg-panel-2"
              onClick={() => select({ kind: 'site', index: row.site_index })}
              title={`Show ${row.name} on the map`}
              data-testid="overview-stop"
            >
              <SiteBadge preset={world?.sites[row.site_index]?.preset ?? ''} down={row.already} />
              <span className="min-w-0 flex-1">
                {countdownSentence(row)}
                {row.kind !== 'runs_dry' && <span className="block text-xs text-muted">{row.what}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {rest > 0 && <button className={`${LINK} mt-auto self-start pt-2`} onClick={() => showDetail('impact')} data-testid="overview-stops-more">and {rest} more</button>}
    </>
  );
}

function Pressure({ reply }: { reply: EconomyReply | null }) {
  const setTab = useEconomyView((s) => s.setTab);
  if (reply === null) return waiting;
  const { above, below } = pricePressure(priceRows(reply));
  if (above.length === 0 && below === null) return <p className="text-sm text-muted">Every chemical is at its base price, or nothing has been ordered yet.</p>;
  const line = (key: string, label: string, pct: number) => (
    <li key={key} className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate text-sm text-ink">{label}</span>
      <span className={`${BIG} shrink-0 text-xl`}>{fmtSigned(pct)}</span>
    </li>
  );
  return (
    <button className="flex flex-1 cursor-pointer flex-col text-left hover:bg-panel-2" onClick={() => setTab('prices')} title="Open the Prices tab" data-testid="overview-prices">
      <ul className="flex w-full flex-col gap-1">
        {above.map((r) => line(r.key, r.label, r.paidPct as number))}
        {below !== null && <li aria-hidden="true" className="my-0.5 border-t border-line" />}
        {below !== null && line(below.key, below.label, below.paidPct as number)}
      </ul>
      <span className="mt-auto pt-2 text-xs text-muted">paid now, against base price</span>
    </button>
  );
}

function Plants({ reply }: { reply: EconomyReply | null }) {
  const snap = useSim((s) => s.snap);
  const world = useSim((s) => s.world);
  const select = useSim((s) => s.select);
  const showDetail = useEconomyView((s) => s.showDetail);
  if (reply === null || snap === null) return waiting;
  const p = plantsRunning(reply, snap);
  const more = p.others.length - PLANTS_NAMED;
  return (
    <>
      <button className="cursor-pointer self-start text-left hover:bg-panel-2" onClick={() => showDetail('plants')} title="Every plant, day by day" data-testid="overview-plants-count">
        <span className={`${BIG} text-4xl`}>{p.running}</span>
        <span className="ml-1.5 text-sm text-ink">of {p.total} running normally</span>
      </button>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {p.others.slice(0, PLANTS_NAMED).map((o) => (
          <li key={`${o.site}-${o.process}`}>
            <button className="flex w-full cursor-pointer items-start gap-2 text-left text-xs leading-snug text-ink hover:bg-panel-2" onClick={() => select({ kind: 'site', index: o.site })} title={`Show ${o.name} on the map`} data-testid="overview-plant">
              <SiteBadge preset={world?.sites[o.site]?.preset ?? ''} down={o.down} limited={!o.down} />
              <span className="min-w-0 flex-1">{o.name} <span className="text-muted">{o.words}</span></span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && <button className={`${LINK} mt-auto self-start pt-1.5`} onClick={() => showDetail('plants')}>and {more} more</button>}
    </>
  );
}

export function EconomyOverview({ open }: { open: boolean }) {
  const economy = useEconomy(open);
  const forecast = useForecast(open, FORECAST_DAYS);
  const prices = usePriceHistory(open);
  const sourcing = useSourcingList(open);
  const showDetail = useEconomyView((s) => s.showDetail);
  const lost = sourcing.data === null ? 0 : sourcing.data.tanks.filter((t) => supplierDown(t.usual_state)).length;
  const failed = economy.error ?? forecast.error ?? prices.error;
  return (
    <div className="flex flex-col gap-2 px-3 py-3" data-testid="economy-overview">
      <div className="grid grid-cols-3 gap-2">
        <Panel label="Customers served" className="min-h-[150px]" testId="overview-served"><Served reply={economy.data} /></Panel>
        <Panel label="Cost of the current disruption" className="col-span-2 min-h-[150px]" testId="overview-cost-panel"><Cost f={forecast.data} /></Panel>
        <Panel label="What stops next" className="min-h-[196px]" testId="overview-stops"><StopsNext f={forecast.data} /></Panel>
        <Panel label="Price pressure" className="min-h-[196px]" testId="overview-pressure"><Pressure reply={prices.data} /></Panel>
        <Panel label="Plants running" className="min-h-[196px]" testId="overview-plants"><Plants reply={economy.data} /></Panel>
      </div>
      {lost > 0 && (
        <button className={`${LINK} self-start px-1`} onClick={() => showDetail('supply')} data-testid="overview-supplier-down">
          {lost === 1 ? '1 tank has lost its usual supplier' : `${lost} tanks have lost their usual supplier`}
        </button>
      )}
      {failed !== null && failed !== undefined && <p className="px-1 text-xs text-muted">Some figures could not be loaded: {failed}</p>}
    </div>
  );
}
