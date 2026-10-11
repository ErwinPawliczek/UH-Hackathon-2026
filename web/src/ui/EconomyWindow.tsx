// The Economy window: the numbers behind the whole process, in one wide
// draggable window opened from the top bar. Tabs:
//
//   Procurement — what has been bought so far: spend and tonnes per chemical
//   over time, and freight by vehicle type (EconomyProcurement.tsx).
//   Production — how hard every plant has run, day by day, and the network's
//   service, lost sales and stopped time (EconomyProduction.tsx).
//   Disruption impact — what is broken right now will cost over the next 30
//   days, itemised in plain words, what stops next and when, and how the 30
//   days compare with the same days had nothing broken.
//   Supply options — for each tank that buys its feed: how long its stock
//   lasts, whether its usual supplier is down, and who else could deliver in
//   time and at what price (EconomySupply.tsx).
//
// The data comes from the live session (see economyData.ts): the run so far
// once per simulated day, the forecast also whenever something breaks or is
// repaired; all of it is dropped when the run is replaced or taken back.

import type { ForecastReply } from '../engine/api';
import { useSim } from '../store/sim';
import { DraggableWindow } from './DraggableWindow';
import { SiteBadge } from './SiteIcon';
import { EconomySupply } from './EconomySupply';
import { EconomyOverview } from './EconomyOverview';
import { EconomyPrices } from './EconomyPrices';
import { EconomyProcurement, EconomyProduction } from './EconomyTabs';
import { ECONOMY_WINDOW_AT, ECONOMY_WINDOW_ID, useEconomyView, type EconomyTab } from './economyView';
import { costParts, rejectedPart, countdownSentence, fmtMoney, fmtTonnes, nothingBroken, useForecast } from './economyData';
import { fmtClock, fmtMomentWords } from './format';
import { useWindows } from './windows';

export { ECONOMY_WINDOW_AT, ECONOMY_WINDOW_ID, openSupplyOptions } from './economyView';
const WIDTH = 720;
/** Days the disruption forecast looks ahead. */
export const FORECAST_DAYS = 30;

const TABS: { key: EconomyTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'prices', label: 'Prices' },
  { key: 'spending', label: 'Spending' },
];

const DETAIL_TITLE = { impact: 'Disruption impact', plants: 'Every plant, day by day', supply: 'Supply options' } as const;

export function EconomyWindow() {
  const open = useWindows((s) => s.windows[ECONOMY_WINDOW_ID]?.open === true);
  const tab = useEconomyView((s) => s.tab);
  const detail = useEconomyView((s) => s.detail);
  const setTab = useEconomyView((s) => s.setTab);
  const showDetail = useEconomyView((s) => s.showDetail);
  return (
    <DraggableWindow id={ECONOMY_WINDOW_ID} title="Economy" width={WIDTH} maxHeight="80vh" at={ECONOMY_WINDOW_AT}>
      {/* the tabs stay put while a long page scrolls under them */}
      <div className="sticky top-0 z-10 flex gap-1.5 border-b border-line bg-panel px-3 py-2" role="tablist" aria-label="Economy views">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`btn ${tab === t.key ? 'btn-active' : ''}`}
            onClick={() => setTab(t.key)}
            data-testid={`economy-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'overview' && detail === null && <EconomyOverview open={open} />}
      {tab === 'overview' && detail !== null && (
        <>
          <div className="flex items-baseline gap-3 px-4 pt-2.5">
            <button className="cursor-pointer text-sm font-medium text-blue underline decoration-dotted underline-offset-2 hover:text-blue-strong" onClick={() => showDetail(null)} data-testid="economy-back">
              ← Overview
            </button>
            <span className="label">{DETAIL_TITLE[detail]}</span>
          </div>
          {detail === 'impact' && <ImpactTab open={open} />}
          {detail === 'plants' && <EconomyProduction open={open} />}
          {detail === 'supply' && <EconomySupply open={open} />}
        </>
      )}
      {tab === 'prices' && <EconomyPrices open={open} />}
      {tab === 'spending' && <EconomyProcurement open={open} />}
    </DraggableWindow>
  );
}

/** A headline number with what it is, and the same number had nothing broken. */
function Tile({ label, value, without, worse = false }: { label: string; value: string; without?: string; worse?: boolean }) {
  return (
    <div className="chamfer chamfer-sm min-w-0 flex-1 px-3 py-1.5" style={{ '--chamfer-fill': 'var(--white)' } as React.CSSProperties}>
      <div className="label">{label}</div>
      <div className="text-2xl font-semibold leading-tight text-ink">{value}</div>
      {without !== undefined && (
        <div className="text-xs text-muted">
          {worse ? <span className="font-medium text-ink">{without}</span> : without} with nothing broken
        </div>
      )}
    </div>
  );
}

/** A share as a percentage, rounded down so "100%" only ever means all of it. */
function pct(share: number): string {
  if (share >= 0.99995) return '100%';
  const v = Math.floor(share * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}
const hours = (h: number) => `${Math.round(h).toLocaleString('en-US')} h`;

function ImpactTab({ open }: { open: boolean }) {
  const { data, error, loading } = useForecast(open, FORECAST_DAYS);
  const world = useSim((s) => s.world);

  if (data === null) {
    return (
      <p className="px-4 py-6 text-sm text-muted" data-testid="economy-impact-empty">
        {error !== null ? `The forecast could not be worked out: ${error}` : loading ? `Working out the next ${FORECAST_DAYS} days…` : 'Start the simulation to see a forecast.'}
      </p>
    );
  }

  return (
    // while a refresh is in flight the last forecast stays, dimmed: no flash, no jump
    <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
      <ImpactView f={data} presetOf={(i) => world?.sites[i]?.preset ?? ''} note={error !== null ? `Last update failed: ${error}` : null} />
    </div>
  );
}

/** The Disruption impact tab for one forecast. */
export function ImpactView({ f, presetOf, note = null }: { f: ForecastReply; presetOf: (site: number) => string; note?: string | null }) {
  const quiet = nothingBroken(f);
  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-testid="economy-impact">
      {quiet ? <Quiet f={f} /> : <Headline f={f} />}
      {!quiet && <Breakdown f={f} />}
      {!quiet && <Countdown f={f} presetOf={presetOf} />}
      <Comparison f={f} quiet={quiet} />
      {!quiet && <ShortCustomers f={f} />}
      <p className="text-xs text-muted">
        Worked out at {fmtMomentWords(f.tick)} by running the next {f.days} days twice: once as things are, once with
        everything repaired. It updates when something breaks or is repaired, and once a simulated day.
        {note !== null && ` (${note})`}
      </p>
    </div>
  );
}

function Quiet({ f }: { f: ForecastReply }) {
  return (
    <div data-testid="economy-impact-quiet">
      <div className="text-xl font-semibold text-ink">Nothing is broken.</div>
      <p className="mt-1 max-w-[60ch] text-sm text-muted">
        Over the next {f.days} days the network runs as planned. Break something from the Scenario menu, or fail a
        unit in a site&apos;s panel, and this page shows what it will cost and what stops next.
      </p>
    </div>
  );
}

function Headline({ f }: { f: ForecastReply }) {
  const cost = f.delta.cost_usd;
  return (
    <div data-testid="economy-impact-headline">
      <div className="label">
        {f.disruptions === 1 ? '1 disruption active' : `${f.disruptions} disruptions active`}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
        <span className="text-lg text-ink">{cost >= 0 ? 'This will cost' : 'This will save'}</span>
        <span className="text-5xl font-semibold leading-none text-ink" data-testid="economy-impact-cost">
          {fmtMoney(Math.abs(cost))}
        </span>
        <span className="text-lg text-ink">over the next {f.days} days</span>
      </div>
      <p className="mt-1 text-sm text-muted">Compared with the same {f.days} days with nothing broken.</p>
    </div>
  );
}

function Breakdown({ f }: { f: ForecastReply }) {
  const parts = costParts(f);
  const rejected = rejectedPart(f);
  return (
    <table className="w-full text-sm" data-testid="economy-impact-breakdown">
      <caption className="label mb-1 text-left">Where it comes from</caption>
      <tbody>
        {parts.flatMap((p) => [
          <tr key={p.key} className="border-t border-line">
            <th scope="row" className="w-40 py-1 pr-3 text-left font-medium text-ink">{p.label}</th>
            <td className="py-1 pr-3 text-muted">{p.note}</td>
            <td className="data w-28 py-1 text-right text-ink">
              {p.usd > 0 ? '+' : ''}
              {fmtMoney(p.usd)}
            </td>
          </tr>,
          // inside the stock figure, so it is shown under it and not added to the total
          p.key === 'stock' && rejected !== null ? (
            <tr key="rejected" data-testid="economy-impact-rejected">
              <th scope="row" className="py-0.5 pl-4 pr-3 text-left text-xs font-normal text-muted">of which product rejected</th>
              <td className="py-0.5 pr-3 text-xs text-muted">
                {rejected.tonnes >= 0.5 ? `${fmtTonnes(rejected.tonnes)} made with nowhere to put it` : 'made with nowhere to put it'}
              </td>
              <td className="data py-0.5 text-right text-xs text-muted">{fmtMoney(rejected.usd)}</td>
            </tr>
          ) : null,
        ])}
        <tr className="border-t border-line-2">
          <th scope="row" className="py-1 pr-3 text-left font-semibold text-ink">Total</th>
          <td />
          <td className="data py-1 text-right font-semibold text-ink">{fmtMoney(f.delta.cost_usd)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Countdown({ f, presetOf }: { f: ForecastReply; presetOf: (site: number) => string }) {
  const select = useSim((s) => s.select);
  const selected = useSim((s) => (s.selected !== null && s.selected.kind === 'site' ? s.selected.index : -1));
  if (f.countdown.length === 0) {
    return (
      <div>
        <div className="label mb-1">What stops next</div>
        <p className="text-sm text-muted">Nothing else stops in the next {f.days} days.</p>
      </div>
    );
  }
  return (
    <div data-testid="economy-impact-countdown">
      <div className="label mb-1">What stops next</div>
      <ul>
        {f.countdown.map((row, i) => (
          <li key={`${row.site}-${row.kind}-${row.what}-${i}`} className="border-t border-line">
            <button
              className={`flex w-full cursor-pointer items-center gap-2 px-1 py-1 text-left text-sm hover:bg-panel-2 ${selected === row.site_index ? 'bg-blue-soft' : ''}`}
              onClick={() => select({ kind: 'site', index: row.site_index })}
              title={`Show ${row.name} on the map`}
              data-testid="economy-impact-countdown-row"
            >
              <SiteBadge preset={presetOf(row.site_index)} down={row.already} />
              <span className="min-w-0 flex-1 text-ink">
                {countdownSentence(row)}
                {row.kind !== 'runs_dry' && <span className="text-muted"> · {row.what}</span>}
              </span>
              <span className="data shrink-0 text-muted">{row.already ? 'now' : fmtClock(row.tick)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Comparison({ f, quiet }: { f: ForecastReply; quiet: boolean }) {
  const w = f.with.totals;
  const o = f.without.totals;
  return (
    <div>
      <div className="label mb-1">{quiet ? `The next ${f.days} days` : `The next ${f.days} days, as things are`}</div>
      <div className="flex gap-2" data-testid="economy-impact-compare">
        <Tile label="Customers served" value={pct(w.service)} without={quiet ? undefined : pct(o.service)} worse={w.service < o.service - 1e-6} />
        <Tile label="Demand not met" value={fmtTonnes(w.unmet_t)} without={quiet ? undefined : fmtTonnes(o.unmet_t)} worse={w.unmet_t > o.unmet_t + 0.5} />
        <Tile label="Plant time stopped" value={hours(w.shutdown_h)} without={quiet ? undefined : hours(o.shutdown_h)} worse={w.shutdown_h > o.shutdown_h + 0.5} />
      </div>
    </div>
  );
}

/** Customers that will not get everything they order, worst first. */
function ShortCustomers({ f }: { f: ForecastReply }) {
  const short = f.with.customers
    .filter((c) => c.demand_t > 0 && c.service < 0.9995)
    .sort((a, b) => a.service - b.service)
    .slice(0, 6);
  if (short.length === 0) return null;
  return (
    <table className="w-full text-sm" data-testid="economy-impact-short">
      <caption className="label mb-1 text-left">Customers that will go short</caption>
      <tbody>
        {short.map((c) => (
          <tr key={`${c.site}-${c.process}`} className="border-t border-line">
            <th scope="row" className="py-1.5 pr-3 text-left font-medium text-ink">{c.name}</th>
            <td className="py-1.5 pr-3 text-muted">{c.process_name}</td>
            <td className="data w-40 py-1.5 text-right text-ink">
              gets {pct(c.service)} · short {fmtTonnes(c.demand_t - c.served_t)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
