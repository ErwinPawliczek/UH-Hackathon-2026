// Economy window, Market tab: the market rules at work. Shown only in the
// market world, where buyers order by price, customers want less of what has
// become dear, and a plant that loses money on a tonne drops to its minimum.
//
// Three panels, each under one sentence of explanation:
//   Prices against base — every chemical, as a bar either side of a centre
//   line (−50% to +50%), with what is paid per tonne.
//   What customers want — each customer and product: demand against normal,
//   the price it pays, and the sales it has been priced out of.
//   Plant margins — each plant: what it makes on a tonne, how that tonne
//   splits into feed, energy and what is left, its rate, and what the margin
//   is doing to it.
// A customer or plant row selects that site on the map.

import type { ReactNode } from 'react';
import { useSim } from '../store/sim';
import { blueRamp } from './charts/palette';
import {
  changeBar, customerWords, demandBar, fmtChange, fmtUsd, marketMissing, marketTitle, paidChangePct, perTonne, plantWords, rulesWords,
  sortedCustomers, sortedMaterials, sortedPlants, tonneSplit, useMarket,
} from './marketData';

const [LIGHT, MID, DARK] = blueRamp(3);

function Section({ title, why, children, testId }: { title: string; why: string; children: ReactNode; testId: string }) {
  return (
    <section data-testid={testId}>
      <h3 className="label">{title}</h3>
      <p className="mb-1.5 text-xs text-muted">{why}</p>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="py-2 text-sm text-muted">{children}</p>;

/** A bar either side of a centre line: left of it cheaper than base, right of it dearer. */
function ChangeBar({ pct }: { pct: number }) {
  const b = changeBar(pct);
  return (
    <span className="relative block h-2.5 w-full rounded-sm bg-line" aria-hidden="true">
      <span className="absolute top-0 h-full rounded-sm" style={{ left: `${b.left * 100}%`, width: `${Math.max(0.5, b.width * 100)}%`, backgroundColor: pct >= 0 ? DARK : MID }} />
      <span className="absolute -top-0.5 left-1/2 h-3.5 w-px bg-ink" />
    </span>
  );
}

export function EconomyMarket({ open }: { open: boolean }) {
  const market = useMarket(open);
  const select = useSim((s) => s.select);
  const nSites = useSim((s) => s.world?.sites.length ?? 0);
  const pick = (site: number) => { if (Number.isInteger(site) && site >= 0 && site < nSites) select({ kind: 'site', index: site }); };

  if (market.data === null) {
    return (
      <p className="px-4 py-6 text-sm text-muted" data-testid="market-empty">
        {marketMissing(market.error)
          ? 'Not available yet: this server does not report the market view.'
          : market.error !== null ? `The market view could not be loaded: ${market.error}` : 'Reading the market…'}
      </p>
    );
  }
  const d = market.data;
  const materials = sortedMaterials(d);
  const customers = sortedCustomers(d);
  const plants = sortedPlants(d);

  return (
    <div className="flex flex-col gap-5 px-4 py-3" data-testid="economy-market">
      <p className="text-sm text-ink" data-testid="market-rules">{rulesWords(d.rules)}</p>

      <Section title="Prices against base" why="What each chemical sells for now against its usual price: right of the line is dearer, left is cheaper." testId="market-prices">
        {d.materials === undefined ? <Empty>Not available yet.</Empty> : materials.length === 0 ? <Empty>Nothing has been sold yet.</Empty> : (
          <ul className="divide-y divide-line">
            {materials.map((m) => (
              <li key={m.material} className="grid grid-cols-[9rem_1fr_5.5rem_3.5rem] items-center gap-3 py-1.5 text-sm" data-testid="market-price-row">
                <span className="truncate text-ink">{marketTitle(m.material, m.name)}</span>
                <ChangeBar pct={m.paidUsdPerT === null ? 0 : m.changePct} />
                <span className="data text-right text-ink">{perTonne(m.paidUsdPerT)}</span>
                <span className="data text-right font-semibold text-ink">{m.paidUsdPerT === null ? '—' : fmtChange(m.changePct)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="What customers want" why="A customer buys less of what has become dear. The mark on each bar is its normal demand; sales it gave up over price are 'priced out'." testId="market-customers">
        {d.customers === undefined ? <Empty>Not available yet.</Empty> : customers.length === 0 ? <Empty>No customers in this world.</Empty> : (
          <ul className="divide-y divide-line">
            {customers.map((c) => {
              const bar = demandBar(c.demandFactor);
              const change = paidChangePct(c);
              return (
                <li key={`${c.site}-${c.material}`}>
                  <button type="button" className="grid w-full cursor-pointer grid-cols-[11rem_1fr_6rem] items-center gap-3 py-1.5 text-left text-sm hover:bg-panel-2" onClick={() => pick(c.site)} title={`Show ${c.name} on the map`} data-testid="market-customer-row">
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{c.name}</span>
                      <span className="block truncate text-xs text-muted">{marketTitle(c.material)}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="relative block h-2.5 w-full rounded-sm bg-line" aria-hidden="true">
                        <span className="absolute left-0 top-0 h-full rounded-sm" style={{ width: `${bar.fill * 100}%`, backgroundColor: c.demandFactor < 0.995 ? MID : DARK }} />
                        <span className="absolute -top-0.5 h-3.5 w-px bg-ink" style={{ left: `${bar.normal * 100}%` }} />
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink">{customerWords(c)}</span>
                    </span>
                    <span className="text-right">
                      <span className="data block text-ink">{perTonne(c.pricePaidUsdPerT)}</span>
                      <span className="block text-xs text-muted">
                        {change === null ? `base ${perTonne(c.baseUsdPerT)}` : `${fmtChange(change)} on base`}
                        {(c.pricedOutUsd ?? 0) >= 1 && <span className="block">{fmtUsd(c.pricedOutUsd ?? 0)} priced out</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Plant margins" why="What a plant has left from a tonne sold after paying for feed and energy. A plant that loses money on a tonne drops to its lowest rate." testId="market-plants">
        {d.plants === undefined ? <Empty>Not available yet.</Empty> : plants.length === 0 ? <Empty>No plants in this world.</Empty> : (
          <>
            <div className="mb-1 flex gap-3 text-xs text-muted" aria-hidden="true">
              <span><span className="mr-1 inline-block h-2 w-3 rounded-sm align-middle" style={{ backgroundColor: DARK }} />feed</span>
              <span><span className="mr-1 inline-block h-2 w-3 rounded-sm align-middle" style={{ backgroundColor: MID }} />energy</span>
              <span><span className="mr-1 inline-block h-2 w-3 rounded-sm align-middle" style={{ backgroundColor: LIGHT }} />left over</span>
            </div>
            <ul className="divide-y divide-line">
              {plants.map((p) => {
                const split = tonneSplit(p);
                const words = plantWords(p);
                const losing = p.marginUsdPerT !== null && p.marginUsdPerT < 0;
                return (
                  <li key={p.site}>
                    <button type="button" className="grid w-full cursor-pointer grid-cols-[11rem_1fr_5.5rem_3rem] items-center gap-3 py-1.5 text-left text-sm hover:bg-panel-2" onClick={() => pick(p.site)} title={`Show ${p.name} on the map`} data-testid="market-plant-row">
                      <span className="min-w-0">
                        <span className="block truncate text-ink">{p.name}</span>
                        {words !== null && <span className={`block truncate text-xs ${losing ? 'text-alarm' : 'text-muted'}`}>{words}</span>}
                      </span>
                      <span className="min-w-0" title={`Per tonne sold: revenue ${perTonne(p.revenueUsdPerT)}, feed ${perTonne(p.feedCostUsdPerT)}, energy ${perTonne(p.energyUsdPerT)}`}>
                        {split === null ? <span className="text-xs text-muted">nothing sold yet</span> : (
                          <>
                            <span className={`flex h-2.5 w-full overflow-hidden rounded-sm ${split.over ? 'outline outline-1 outline-alarm' : ''}`} aria-hidden="true">
                              <span style={{ width: `${split.feed * 100}%`, backgroundColor: DARK }} />
                              <span style={{ width: `${split.energy * 100}%`, backgroundColor: MID }} />
                              <span style={{ width: `${split.margin * 100}%`, backgroundColor: LIGHT }} />
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted">
                              sells {perTonne(p.revenueUsdPerT)} · feed {perTonne(p.feedCostUsdPerT)} · energy {perTonne(p.energyUsdPerT)}
                            </span>
                          </>
                        )}
                      </span>
                      <span className={`data text-right font-semibold ${losing ? 'text-alarm' : 'text-ink'}`}>{perTonne(p.marginUsdPerT)}</span>
                      <span className="data text-right text-ink">{Math.round(p.rate * 100)}%</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>
    </div>
  );
}
