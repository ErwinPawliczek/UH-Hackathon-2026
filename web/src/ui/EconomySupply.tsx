// Economy window, Supply options tab: a supplier is down — who else can
// reach this tank in time?
//
// Left, every tank that buys its feed, the one that runs dry soonest first,
// with how long its stock lasts and a red tag where its usual supplier is
// down. Right, the chosen tank: where it stands, and every way to fill it,
// in the order the plant itself would choose — who sells, by what vehicle,
// how far, how long door to door, whether that beats the tank running dry,
// how much the seller can spare, and what a tonne costs delivered: the price
// an order is booked at plus freight. The view is read-only: every tank
// orders for itself.
//
// Selecting a site on the map jumps to that site's first buying tank; a
// supplier's name selects the supplier on the map.

import { useEffect, useRef, useState } from 'react';
import type { SourcingDetail, SourcingOption, SourcingTank } from '../engine/api';
import { useSim } from '../store/sim';
import { SiteBadge } from './SiteIcon';
import { fmtTonnes } from './economyData';
import { useEconomyView } from './economyView';
import { fmtMomentWords } from './format';
import {
  blockedWords, cashWords, cutOff, fmtCover, fmtTrip, inTime, nextPassWords, optionCash, sellerSplitWords, sortByCover, stateWords, supplierDown, tankHeadline, tankLabel, useSourcingDetail, useSourcingList,
  vehicleWords, weighedWords,
} from './supplyData';

/** Hours of stock that fill the cover bar: a week. */
const FULL_BAR_H = 168;
/** Under this many hours a tank's bar turns red. */
const LOW_COVER_H = 24;

function Tag({ tone, children }: { tone: 'alarm' | 'blue' | 'muted'; children: React.ReactNode }) {
  const cls = tone === 'alarm' ? 'bg-alarm text-white' : tone === 'blue' ? 'bg-blue-soft text-blue-strong' : 'bg-panel-2 text-muted';
  return <span className={`inline-block shrink-0 rounded-sm px-1.5 py-px text-[11px] font-medium leading-snug ${cls}`}>{children}</span>;
}

function TankRow({ tank, preset, chosen, onPick }: { tank: SourcingTank; preset: string; chosen: boolean; onPick: () => void }) {
  const label = tankLabel(tank);
  const cover = tank.cover_h;
  const share = cover === null ? 1 : Math.min(1, cover / FULL_BAR_H);
  const low = cover !== null && cover < LOW_COVER_H;
  const down = supplierDown(tank.usual_state);
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        className={`flex w-full cursor-pointer items-start gap-2 px-2 py-1 text-left hover:bg-panel-2 ${chosen ? 'bg-blue-soft' : ''}`}
        aria-pressed={chosen}
        onClick={onPick}
        data-testid={`supply-tank-${tank.site}-${tank.material}`}
      >
        <SiteBadge preset={preset} down={down} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink">{label.material}</span>
            <span className="data shrink-0 text-xs text-ink">{fmtCover(cover)}</span>
          </span>
          <span className="block truncate text-xs text-muted">{label.site}</span>
          {/* how long the stock lasts, against a week: the track is a lighter step of the fill */}
          <span className={`mt-1 block h-1 w-full overflow-hidden rounded-sm ${low ? 'bg-alarm/20' : 'bg-blue-soft'}`} aria-hidden="true">
            <span className={`block h-full rounded-sm ${low ? 'bg-alarm' : 'bg-blue'}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
          </span>
          {down && <span className="mt-1 block"><Tag tone="alarm">usual supplier {stateWords(tank.usual_state)}</Tag></span>}
          {cutOff(tank) && <span className="mt-1 block"><Tag tone="alarm">route closed</Tag></span>}
        </span>
      </button>
    </li>
  );
}


function OptionRow({ option, material, coverH, presetOf, onSupplier }: {
  option: SourcingOption;
  /** the product this tank buys */
  material: string;
  coverH: number | null;
  presetOf: (site: number) => string;
  onSupplier: (site: number) => void;
}) {
  const blocked = blockedWords(option);
  const timing = inTime(option, coverH);
  const sellerDown = supplierDown(option.seller_state);
  const split = sellerSplitWords(option, material);
  // what a tonne will actually cost: the booked price plus freight
  const cash = optionCash(option);
  const weighed = weighedWords(option);
  return (
    <li className="border-t border-line py-1.5" data-testid="supply-option">
      <div className="flex items-center gap-2">
        <SiteBadge preset={presetOf(option.seller_index)} down={sellerDown} />
        <button
          className="min-w-0 cursor-pointer truncate text-left text-sm font-medium text-ink hover:underline"
          onClick={() => onSupplier(option.seller_index)}
          title={`Show ${option.seller_name} on the map`}
        >
          {option.seller_name}
        </button>
        {option.chosen && <Tag tone="blue">next order</Tag>}
        {option.usual && <Tag tone="muted">usual</Tag>}
        {option.seller_state !== 'running' && <Tag tone={sellerDown ? 'alarm' : 'muted'}>{stateWords(option.seller_state)}</Tag>}
        <span className="data ml-auto shrink-0 text-sm font-semibold text-ink" title={cashWords(cash)} data-testid="supply-option-price">
          ${cash.delivered.toLocaleString('en-US')}
          <span className="font-normal text-muted"> /t</span>
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 pl-7 text-xs text-ink">
        <span>by {vehicleWords(option.cls)}</span>
        <span className="text-muted">·</span>
        <span className="data">{Math.round(option.km).toLocaleString('en-US')} km</span>
        <span className="text-muted">·</span>
        <span><span className="data">{fmtTrip(option.door_to_door_h)}</span> door to door</span>
        {/* timing only for an option that can be used now; never colour alone: the words say it, the dot repeats it */}
        {blocked === null && (
          <>
            <span className="text-muted">·</span>
            <span className="inline-flex items-center gap-1" data-testid="supply-option-timing">
              <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${timing.ok ? 'bg-blue' : 'bg-alarm'}`} />
              <span className={timing.ok ? '' : 'font-medium'}>{timing.words}</span>
            </span>
          </>
        )}
        <span className="text-muted">·</span>
        <span>can spare <span className="data">{fmtTonnes(option.free_t)}</span></span>
      </div>
      <div className="flex items-end justify-between gap-2 pl-7">
        <span className="text-xs text-muted" data-testid="supply-option-money">
          {cashWords(cash)}
          {weighed !== null && <span className="block">{weighed}</span>}
        </span>
      </div>
      {split !== null && <div className="mt-0.5 pl-7 text-xs text-ink" data-testid="supply-option-split">{split}.</div>}
      {blocked !== null && (
        <div className="mt-0.5 flex items-center gap-1 pl-7 text-xs text-ink">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-alarm" />
          <span>Cannot be used now: {blocked}.</span>
        </div>
      )}
    </li>
  );
}

/** The chosen tank: where it stands and every way to fill it. */
export function SupplyDetail({ detail, presetOf, onSupplier }: {
  detail: SourcingDetail;
  presetOf: (site: number) => string;
  onSupplier: (site: number) => void;
}) {
  const t = detail.tank;
  return (
    <div data-testid="supply-detail">
      <p className="text-base font-semibold leading-snug text-ink" data-testid="supply-headline">{tankHeadline(detail)}</p>
      <p className="mt-1 text-xs text-muted">
        Uses <span className="data text-ink">{t.draw_t_h.toFixed(1)} t</span> an hour ·{' '}
        <span className="data text-ink">{fmtTonnes(t.level_t)}</span> in the tank ·{' '}
        <span className="data text-ink">{fmtTonnes(t.inbound_t)}</span> on the way
      </p>
      <p className="mt-1 text-xs text-ink">{nextPassWords(detail)}</p>
      <div className="label mb-0.5 mt-3">
        {detail.options.length === 0 ? 'No one can supply it' : `${detail.options.length} way${detail.options.length === 1 ? '' : 's'} to supply it`}
      </div>
      {detail.options.length > 0 && (
        <p className="mb-1 text-xs text-muted" data-testid="supply-order-of-list">
          Listed in the order this plant would choose: it also weighs how long the trip takes and whether it knows the supplier.
        </p>
      )}
      {detail.options.length === 0 ? (
        <p className="text-sm text-muted">No other plant makes it, or none can be reached by any vehicle.</p>
      ) : (
        <ul>
          {detail.options.map((o) => (
            <OptionRow key={`${o.seller}-${o.cls}`} option={o} material={t.material} coverH={t.cover_h} presetOf={presetOf} onSupplier={onSupplier} />
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        As of {fmtMomentWords(detail.tick)}. The price for the product is what an order is booked at now: halfway between
        what the seller asks (less when its tank is full) and what this plant bids. Freight is for that vehicle over
        that distance. &quot;In time&quot; compares door to door with the stock left.
      </p>
    </div>
  );
}

export function EconomySupply({ open }: { open: boolean }) {
  const world = useSim((s) => s.world);
  const select = useSim((s) => s.select);
  const selectedSite = useSim((s) => (s.selected !== null && s.selected.kind === 'site' ? s.selected.index : -1));
  const chosen = useEconomyView((s) => s.supplyTank);
  const choose = useEconomyView((s) => s.chooseSupplyTank);
  const [onlyDown, setOnlyDown] = useState(false);
  const list = useSourcingList(open);
  const presetOf = (site: number) => world?.sites[site]?.preset ?? '';

  const all = list.data === null ? [] : sortByCover(list.data.tanks);
  const downCount = all.filter((t) => supplierDown(t.usual_state)).length;
  const shown = onlyDown ? all.filter((t) => supplierDown(t.usual_state)) : all;
  const current = chosen === null ? undefined : all.find((t) => t.site_index === chosen.site && t.material === chosen.material);
  // the tank on show: the chosen one, else the first of the list
  const tank = current ?? shown[0] ?? all[0];
  const detail = useSourcingDetail(open, tank?.site ?? null, tank?.material ?? null);
  // A site selected on the map jumps to that site's first buying tank —
  // unless it was selected from here, by a supplier's name.
  const ownPick = useRef(-1);
  const lastSite = useRef(selectedSite);
  useEffect(() => {
    if (!open || selectedSite === lastSite.current) return;
    lastSite.current = selectedSite;
    if (selectedSite < 0) return;
    if (ownPick.current === selectedSite) {
      ownPick.current = -1;
      return;
    }
    const first = all.find((t) => t.site_index === selectedSite);
    if (first !== undefined) choose(first.site_index, first.material);
    // `all` is rebuilt each render; the jump depends only on the selection changing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedSite]);

  if (list.data === null) {
    return (
      <p className="px-4 py-6 text-sm text-muted" data-testid="supply-empty">
        {list.error !== null ? `The supply options could not be loaded: ${list.error}` : list.loading ? 'Looking at every buying tank…' : 'Start the simulation to see who supplies what.'}
      </p>
    );
  }

  const onSupplier = (site: number) => {
    ownPick.current = site;
    select({ kind: 'site', index: site });
  };

  return (
    <div className="px-3 py-3" data-testid="economy-supply">
      {/* one filter row above everything it scopes */}
      <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          id="supply-only-down"
          name="supply-only-down"
          checked={onlyDown}
          onChange={(e) => setOnlyDown(e.target.checked)}
          data-testid="supply-only-down"
        />
        Only where the usual supplier is down
        <span className="data text-muted">({downCount} of {all.length} tanks)</span>
      </label>
      <div className="flex gap-3">
      <div className="w-60 shrink-0">
        <ul
          className={`chamfer chamfer-sm max-h-[56vh] overflow-auto transition-opacity ${list.loading ? 'opacity-70' : ''}`}
          style={{ '--chamfer-fill': 'var(--white)' } as React.CSSProperties}
          data-testid="supply-tanks"
        >
          {shown.map((t) => (
            <TankRow
              key={`${t.site}-${t.material}`}
              tank={t}
              preset={presetOf(t.site_index)}
              chosen={tank !== undefined && t.site === tank.site && t.material === tank.material}
              onPick={() => choose(t.site_index, t.material)}
            />
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-3 text-xs text-muted">
              {onlyDown ? 'Every tank\'s usual supplier is running.' : 'No tank on this map buys its feed.'}
            </li>
          )}
        </ul>
      </div>
      <div className={`min-w-0 flex-1 transition-opacity ${detail.loading && detail.data !== null ? 'opacity-70' : ''}`}>
        {detail.data !== null ? (
          <SupplyDetail
            detail={detail.data}
            presetOf={presetOf}
            onSupplier={onSupplier}
          />
        ) : (
          <p className="py-4 text-sm text-muted">
            {detail.error !== null ? `This tank could not be loaded: ${detail.error}` : tank === undefined ? 'Pick a tank on the left.' : 'Looking for suppliers…'}
          </p>
        )}
      </div>
      </div>
    </div>
  );
}
