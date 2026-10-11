// The Supply options tab's data and wording: which tanks buy their feed, how
// long each can last, and every way to fill one — who could sell, by what
// vehicle, how long door to door, whether that beats the tank running dry,
// and what a tonne would cost delivered.
//
// Money is shown as the visitor would pay it: the price an order is booked
// at plus freight. The engine ranks options by a different figure
// (`landed_usd_t`: asking price, freight, and charges for the wait and for
// switching supplier that nobody pays), which is why the list is not always
// cheapest first; that figure is never shown as a price.

import type { SourcingDetail, SourcingList, SourcingOption, SourcingTank, SupplierState } from '../engine/api';
import { useSim } from '../store/sim';
import { TICKS_PER_DAY, useSessionData, type Polled } from './economyData';
import { materialName, materialTitle } from './materials';

const TICKS_PER_HOUR = TICKS_PER_DAY / 24;

/** A supplier that cannot deliver right now. */
export const supplierDown = (state: SupplierState | null | undefined) => state === 'shut_down' || state === 'restarting';

/** Buying tanks, the one that runs dry soonest first; tanks nothing draws from go last. */
export function sortByCover(tanks: SourcingTank[]): SourcingTank[] {
  return [...tanks].sort((a, b) => (a.cover_h ?? Infinity) - (b.cover_h ?? Infinity) || a.site_index - b.site_index);
}

/** Hours of stock in words: "31 hours", "3.1 days"; "plenty" when nothing draws. */
export function fmtCover(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return 'plenty';
  if (hours < 1) return 'under an hour';
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${(hours / 24).toFixed(1)} days`;
}

/** A journey time: "9.8 h", "2.1 days". */
export function fmtTrip(hours: number): string {
  return hours < 48 ? `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h` : `${(hours / 24).toFixed(1)} days`;
}

const STATE_WORDS: Record<string, string> = {
  running: 'running',
  held: 'held at its lowest rate',
  restarting: 'restarting',
  shut_down: 'shut down',
  no_producer: 'not producing it',
};
export const stateWords = (state: SupplierState | string | null | undefined) =>
  state === null || state === undefined ? 'unknown' : STATE_WORDS[state] ?? state.replace(/_/g, ' ');

const CLASS_ONE: Record<string, string> = {
  TRUCK_TANK: 'tank truck', TRUCK_PRESS: 'pressurised truck', TRUCK_BULK: 'bulk truck',
  BARGE_TANK: 'tank barge', BARGE_DRY: 'dry barge',
  SHIP_TANK: 'tanker', SHIP_GAS: 'gas carrier', SHIP_DRY: 'bulk carrier',
};
/** One vehicle of a class, in words: "tank truck", "gas carrier". */
export const vehicleWords = (cls: string) => CLASS_ONE[cls] ?? cls.toLowerCase().replace(/_/g, ' ');

/**
 * Why an option cannot be used right now: the engine's own sentence, as
 * given ("the road to this site is closed"). Null when it can be used. An
 * engine that sends only the code gets the code spelled out.
 */
export function blockedWords(o: Pick<SourcingOption, 'blocked' | 'blocked_reason'>): string | null {
  if (typeof o.blocked_reason === 'string' && o.blocked_reason !== '') return o.blocked_reason;
  if (o.blocked === null || o.blocked === undefined) return null;
  return String(o.blocked).replace(/_/g, ' ');
}

/** True when every way to supply the tank has been taken away by a closed route. */
export const cutOff = (t: Pick<SourcingTank, 'options' | 'route_closed'>) =>
  (t.route_closed ?? 0) > 0 && (t.route_closed ?? 0) >= t.options;

/**
 * Whether a delivery would beat the tank running dry. The stricter test:
 * door to door (a vehicle getting to the seller, loading, the trip,
 * unloading) against the hours of stock left.
 */
export function inTime(o: Pick<SourcingOption, 'door_to_door_h'>, coverH: number | null): { ok: boolean; words: string } {
  if (coverH === null || !Number.isFinite(coverH)) return { ok: true, words: 'arrives in time' };
  const late = o.door_to_door_h - coverH;
  if (late < 0) return { ok: true, words: 'arrives in time' };
  return { ok: false, words: `too late by ${fmtTrip(Math.max(0.1, late))}` };
}

const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

/** A price in whole dollars per tonne, as paid: the product, the freight, and the two together. */
export interface CashPrice {
  product: number;
  freight: number;
  delivered: number;
}

/**
 * What a tonne actually costs: the price the order is booked at, plus
 * freight. Each part is rounded to the dollar and the total is the sum of
 * the rounded parts, so the line never reads "$922 + $76 = $999". Values are
 * first taken at two decimals, the precision the engine lists options at,
 * so a listed option and the booking it leads to round the same way.
 */
export function cashPrice(productUsdT: number, freightUsdT: number): CashPrice {
  const dollars = (v: number) => Math.round(Math.round(v * 100) / 100);
  const product = dollars(productUsdT);
  const freight = dollars(freightUsdT);
  return { product, freight, delivered: product + freight };
}

/** The cash price of a listed option. */
export const optionCash = (o: Pick<SourcingOption, 'price_usd_t' | 'freight_usd_t'>): CashPrice =>
  cashPrice(o.price_usd_t, o.freight_usd_t);

/** "$922 /t for the product + $76 freight = $998 /t delivered" */
export function cashWords(p: CashPrice): string {
  return `${usd(p.product)} /t for the product + ${usd(p.freight)} freight = ${usd(p.delivered)} /t delivered`;
}

/**
 * What the buyer adds on top when ranking an option that is not money paid:
 * a charge for the wait when stock is short, and one for switching away
 * from the usual supplier. Null when it adds neither.
 */
export function weighedWords(o: Pick<SourcingOption, 'time_usd_t' | 'switch_usd_t'>): string | null {
  const parts: string[] = [];
  if (o.time_usd_t >= 0.5) parts.push(`${usd(o.time_usd_t)} /t for the wait`);
  if (o.switch_usd_t >= 0.5) parts.push(`${usd(o.switch_usd_t)} /t for switching supplier`);
  if (parts.length === 0) return null;
  return `When choosing, this plant counts an extra ${parts.join(' and ')} (not money paid).`;
}

/**
 * Where a seller's site and the process that makes this product are in
 * different states, both in plain words: "Refinery: partly shut down, still
 * supplying diesel". Null when they agree, or the engine does not send the
 * site's own state.
 */
export function sellerSplitWords(o: Pick<SourcingOption, 'seller_name' | 'seller_state' | 'seller_site_state'>, material: string): string | null {
  const site = o.seller_site_state;
  if (site === undefined || site === null || site === o.seller_state) return null;
  const what = materialName(material);
  if (supplierDown(site) && !supplierDown(o.seller_state)) {
    return `${o.seller_name}: ${site === 'restarting' ? 'partly restarting' : 'partly shut down'}, still supplying ${what}`;
  }
  if (supplierDown(o.seller_state) && !supplierDown(site)) {
    return `${o.seller_name}: still running, but the unit that makes ${what} is ${stateWords(o.seller_state)}; it sells what is in the tank`;
  }
  return `${o.seller_name}: the site is ${stateWords(site)}, the unit that makes ${what} is ${stateWords(o.seller_state)}`;
}

/** "Styrenics has 3.0 days of benzene; its usual supplier, Steam cracker (flex), is shut down." */
export function tankHeadline(d: SourcingDetail): string {
  const t = d.tank;
  const stock = t.cover_h === null ? `plenty of ${materialName(t.material)}` : `${fmtCover(t.cover_h)} of ${materialName(t.material)}`;
  const first = `${t.name} has ${stock}`;
  if (d.usual === null) return `${first}; nobody has delivered any yet.`;
  return `${first}; its usual supplier, ${d.usual.name}, is ${stateWords(d.usual.state)}.`;
}

/** What the next hourly ordering round will do for this tank, in a sentence. */
export function nextPassWords(d: SourcingDetail): string {
  const pass = d.next_pass;
  if (pass === null) return 'This tank is not bought for: it is filled by pipeline.';
  if (pass.lots.length === 0) {
    const nothing = 'The next ordering round will book nothing';
    if (d.tank.want_t <= 0.5 || d.tank.urgency <= 0) return `${nothing}: what is on hand and on the way is above its reorder point.`;
    if (d.options.some((o) => o.feasible_now)) return `${nothing}: it is waiting until it needs most of a vehicle load.`;
    return `${nothing}: no supplier can fill a load right now.`;
  }
  const bySeller = new Map<string, { loads: number; tonnes: number; cls: string }>();
  for (const lot of pass.lots) {
    const key = `${lot.seller}|${lot.cls}`;
    const cur = bySeller.get(key) ?? { loads: 0, tonnes: 0, cls: lot.cls };
    bySeller.set(key, { loads: cur.loads + 1, tonnes: cur.tonnes + lot.tonnes, cls: lot.cls });
  }
  const names = new Map(d.options.map((o) => [o.seller, o.seller_name]));
  const parts = [...bySeller.entries()].map(([key, v]) => {
    const seller = key.split('|')[0];
    return `${v.loads} ${vehicleWords(v.cls)} load${v.loads === 1 ? '' : 's'} from ${names.get(seller) ?? seller} (${Math.round(v.tonnes).toLocaleString('en-US')} t)`;
  });
  return `The next ordering round will book ${parts.join(' and ')}.`;
}

/** The engine's answer to a place_order command. */
export interface PlaceOrderReply {
  ok?: boolean;
  error?: string;
  blocked?: string;
  order?: {
    id: number; tonnes: number; requestedTonnes?: number; material: string; seller: string; site: string; cls: string;
    priceUsdT: number; freightUsd?: number; km?: number; etaTick: number;
  };
}

/** The place_order command for one vehicle load of an option. */
export function orderCommand(tank: { site: string; material: string }, o: Pick<SourcingOption, 'seller' | 'cls' | 'lot_t'>): Record<string, unknown> {
  return { type: 'place_order', site: tank.site, material: tank.material, seller: o.seller, cls: o.cls, tonnes: o.lot_t };
}

/**
 * "25 t of benzene from Refinery by tank truck: $976 /t for the product +
 * $54 freight = $1,030 /t delivered, about 9.8 h door to door" — the same
 * money, in the same words, as the option's row. `doorToDoorH` is the
 * option's own estimate; the reply's `etaTick` is not used, because it
 * counts only the loaded drive from the moment of booking.
 */
export function orderBookedWords(order: NonNullable<PlaceOrderReply['order']>, sellerName: string, doorToDoorH?: number): string {
  const t = order.tonnes >= 100 ? Math.round(order.tonnes).toLocaleString('en-US') : String(Math.round(order.tonnes * 10) / 10);
  const money = order.freightUsd === undefined || !(order.tonnes > 0)
    ? `${usd(cashPrice(order.priceUsdT, 0).product)} /t for the product`
    : cashWords(cashPrice(order.priceUsdT, order.freightUsd / order.tonnes));
  const trip = doorToDoorH === undefined || !Number.isFinite(doorToDoorH) ? '' : `, about ${fmtTrip(doorToDoorH)} door to door`;
  return `${t} t of ${materialName(order.material)} from ${sellerName} by ${vehicleWords(order.cls)}: ${money}${trip}`;
}

/** Why the engine refused an order: its own sentence, as a sentence. */
export function orderRefusedWords(reply: PlaceOrderReply): string {
  const raw = (reply.error ?? '').replace(/^place_order:\s*/, '').trim();
  if (raw === '') return 'The order was not accepted.';
  return raw.charAt(0).toUpperCase() + raw.slice(1) + (/[.!?]$/.test(raw) ? '' : '.');
}

/** Label of a tank in the list: "Benzene", with the site it belongs to. */
export const tankLabel = (t: Pick<SourcingTank, 'material' | 'name'>) => ({ material: materialTitle(t.material), site: t.name });

/** Trains online across every unit: changes whenever a unit fails or is repaired. */
function trainsOnline(): number {
  const snap = useSim.getState().snap;
  if (snap === null) return 0;
  let n = 0;
  for (let i = 0; i < snap.unitTrains.length; i++) n += snap.unitTrains[i];
  return n;
}

/** What makes the supply views refetch: a new simulated hour, a scenario, a unit failing or coming back. */
function useRefreshKey(): string {
  const hour = useSim((s) => Math.floor(Number(s.snap?.tick ?? 0) / TICKS_PER_HOUR));
  const triggered = useSim((s) => s.triggered.length);
  const trains = useSim(() => trainsOnline());
  return `${hour}|${triggered}|${trains}`;
}

/** Every buying tank, refreshed at most once per simulated hour while the tab is open. */
export function useSourcingList(open: boolean, nonce = 0): Polled<SourcingList> {
  const key = useRefreshKey();
  return useSessionData(open, `${key}|${nonce}`, (backend, id) => {
    if (backend.sourcing === undefined) return Promise.reject(new Error('This view needs the hosted engine.'));
    return backend.sourcing(id);
  });
}

/** One tank and its supply options, refreshed on the same rhythm; nothing is fetched until a tank is chosen. */
export function useSourcingDetail(open: boolean, site: string | null, material: string | null, nonce = 0): Polled<SourcingDetail> {
  const key = useRefreshKey();
  const ready = open && site !== null && material !== null;
  return useSessionData(ready, `${key}|${site}|${material}|${nonce}`, (backend, id) => {
    if (backend.sourcingTank === undefined || site === null || material === null) {
      return Promise.reject(new Error('This view needs the hosted engine.'));
    }
    return backend.sourcingTank(id, site, material);
  });
}
