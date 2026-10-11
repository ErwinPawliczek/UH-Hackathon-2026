// Economy window, Supply options tab: a supplier is down — who else can
// reach this tank in time?
//
// Left, every tank that buys its feed, the one that runs dry soonest first,
// with how long its stock lasts and a red tag where its usual supplier is
// down. Right, the chosen tank: where it stands, and every way to fill it,
// in the order the plant itself would choose — who sells, by what vehicle,
// how far, how long door to door, whether that beats the tank running dry,
// how much the seller can spare, and what a tonne costs delivered: the price
// an order is booked at plus freight, which is exactly what "Order one load"
// then reports.
//
// Selecting a site on the map jumps to that site's first buying tank; a
// supplier's name selects the supplier on the map. "Order one load" on an
// option books one vehicle load from that supplier by hand; when a vehicle
// takes the order it is selected, so its trip shows on the map.

import { useEffect, useRef, useState } from 'react';
import type { SourcingDetail, SourcingOption, SourcingTank } from '../engine/api';
import { useSim } from '../store/sim';
import { SiteBadge } from './SiteIcon';
import { fmtTonnes } from './economyData';
import { useEconomyView } from './economyView';
import { fmtMomentWords } from './format';
import {
  blockedWords, cashWords, cutOff, fmtCover, fmtTrip, inTime, nextPassWords, optionCash, orderBookedWords, orderCommand,
  orderRefusedWords, sortByCover, stateWords, supplierDown, tankHeadline, tankLabel, useSourcingDetail, useSourcingList,
  vehicleWords, weighedWords, type PlaceOrderReply,
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

function OptionRow({ option, coverH, presetOf, onSupplier, onOrder, busy }: {
  option: SourcingOption;
  coverH: number | null;
  presetOf: (site: number) => string;
  onSupplier: (site: number) => void;
  /** book one vehicle load from this supplier; absent when orders cannot be placed */
  onOrder?: (option: SourcingOption) => void;
  busy?: boolean;
}) {
  const blocked = blockedWords(option);
  const timing = inTime(option, coverH);
  const sellerDown = supplierDown(option.seller_state);
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
        {onOrder !== undefined && option.feasible_now && blocked === null && (
          <button
            className="btn"
            disabled={busy === true}
            onClick={() => onOrder(option)}
            title={`Book one ${vehicleWords(option.cls)} load (${fmtTonnes(option.lot_t)}) from ${option.seller_name} now`}
            data-testid="supply-order"
          >
            Order one load
          </button>
        )}
      </div>
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
export function SupplyDetail({ detail, presetOf, onSupplier, onOrder, busy, note = null }: {
  detail: SourcingDetail;
  presetOf: (site: number) => string;
  onSupplier: (site: number) => void;
  onOrder?: (option: SourcingOption) => void;
  busy?: boolean;
  /** what became of the last order placed for this tank */
  note?: { ok: boolean; text: string } | null;
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
      {note !== null && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-ink" role="status" data-testid="supply-order-note">
          <span aria-hidden="true" className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${note.ok ? 'bg-blue' : 'bg-alarm'}`} />
          <span>{note.text}</span>
        </p>
      )}
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
            <OptionRow key={`${o.seller}-${o.cls}`} option={o} coverH={t.cover_h} presetOf={presetOf} onSupplier={onSupplier} onOrder={onOrder} busy={busy} />
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
  // bumped after an order by hand, so the figures show it at once
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tank: string; ok: boolean; text: string } | null>(null);
  /** an order placed here that no vehicle has taken yet */
  const [awaiting, setAwaiting] = useState<{ id: number; epoch: number; tank: string; booked: string } | null>(null);
  const canOrder = useSim((s) => s.sendCommand !== null);
  const epoch = useSim((s) => s.runEpoch);
  const list = useSourcingList(open, nonce);
  const presetOf = (site: number) => world?.sites[site]?.preset ?? '';

  const all = list.data === null ? [] : sortByCover(list.data.tanks);
  const downCount = all.filter((t) => supplierDown(t.usual_state)).length;
  const shown = onlyDown ? all.filter((t) => supplierDown(t.usual_state)) : all;
  const current = chosen === null ? undefined : all.find((t) => t.site_index === chosen.site && t.material === chosen.material);
  // the tank on show: the chosen one, else the first of the list
  const tank = current ?? shown[0] ?? all[0];
  const detail = useSourcingDetail(open, tank?.site ?? null, tank?.material ?? null, nonce);
  const tankKey = tank === undefined ? '' : `${tank.site}/${tank.material}`;

  // the vehicle that has taken the awaited order, once dispatch gives it one
  const carrier = useSim((s) => {
    if (awaiting === null || s.snap === null) return -1;
    for (let v = 0; v < s.snap.vehOrder.length; v++) if (s.snap.vehOrder[v] === awaiting.id) return v;
    return -1;
  });
  useEffect(() => {
    if (awaiting === null) return;
    if (awaiting.epoch !== epoch) {
      setAwaiting(null); // the run went back in time or was replaced: that order is not this run's
      return;
    }
    if (carrier < 0) return;
    select({ kind: 'vehicle', index: carrier });
    setNote({ tank: awaiting.tank, ok: true, text: `Booked ${awaiting.booked}. A vehicle has taken it: it is selected on the map.` });
    setAwaiting(null);
  }, [awaiting, carrier, epoch, select]);

  const placeOrder = (option: SourcingOption) => {
    const send = useSim.getState().sendCommand;
    if (send === null || tank === undefined || busy) return;
    setBusy(true);
    const forTank = tankKey;
    send(orderCommand(tank, option))
      .then((raw) => {
        const reply = (raw ?? {}) as PlaceOrderReply;
        if (reply.ok === true && reply.order !== undefined) {
          const booked = orderBookedWords(reply.order, option.seller_name, option.door_to_door_h);
          setNote({ tank: forTank, ok: true, text: `Booked ${booked}. Waiting for a vehicle (the next dispatch is on the hour).` });
          setAwaiting({ id: reply.order.id, epoch: useSim.getState().runEpoch, tank: forTank, booked });
        } else {
          setNote({ tank: forTank, ok: false, text: `Not booked. ${orderRefusedWords(reply)}` });
        }
      })
      .catch((err: unknown) => setNote({ tank: forTank, ok: false, text: `Not booked. ${err instanceof Error ? err.message : String(err)}` }))
      .finally(() => {
        setBusy(false);
        setNonce((n) => n + 1);
      });
  };

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
            onOrder={canOrder ? placeOrder : undefined}
            busy={busy}
            note={note !== null && note.tank === tankKey ? note : null}
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
