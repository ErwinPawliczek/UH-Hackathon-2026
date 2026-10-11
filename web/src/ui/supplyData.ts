// The Supply options tab's data and wording: which tanks buy their feed, how
// long each can last, and every way to fill one — who could sell, by what
// vehicle, how long door to door, whether that beats the tank running dry,
// and what a tonne would cost delivered.

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

/** Why an option cannot be used right now, in plain words; null when it can. */
export function blockedWords(o: Pick<SourcingOption, 'blocked' | 'cls' | 'lot_t'>): string | null {
  switch (o.blocked) {
    case null:
    case undefined:
      return null;
    case 'no_vehicles': return `no ${vehicleWords(o.cls)} can get there`;
    case 'seller_short': return `not enough in its tank for one ${vehicleWords(o.cls)} load`;
    case 'unreachable': return `no way through by ${vehicleWords(o.cls)}`;
    case 'export_fill': return 'keeps this stock for its own customers';
    default: return String(o.blocked).replace(/_/g, ' ');
  }
}

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

/** What makes up the delivered price of a tonne, as one line. */
export function priceParts(o: Pick<SourcingOption, 'ask_usd_t' | 'freight_usd_t' | 'time_usd_t' | 'switch_usd_t'>): string {
  const parts = [`${usd(o.ask_usd_t)} asked`, `${usd(o.freight_usd_t)} freight`];
  if (o.switch_usd_t >= 0.5) parts.push(`${usd(o.switch_usd_t)} for switching supplier`);
  if (o.time_usd_t >= 0.5) parts.push(`${usd(o.time_usd_t)} for the wait`);
  return parts.join(' + ');
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
export function useSourcingList(open: boolean): Polled<SourcingList> {
  const key = useRefreshKey();
  return useSessionData(open, key, (backend, id) => {
    if (backend.sourcing === undefined) return Promise.reject(new Error('This view needs the hosted engine.'));
    return backend.sourcing(id);
  });
}

/** One tank and its supply options, refreshed on the same rhythm; nothing is fetched until a tank is chosen. */
export function useSourcingDetail(open: boolean, site: string | null, material: string | null): Polled<SourcingDetail> {
  const key = useRefreshKey();
  const ready = open && site !== null && material !== null;
  return useSessionData(ready, `${key}|${site}|${material}`, (backend, id) => {
    if (backend.sourcingTank === undefined || site === null || material === null) {
      return Promise.reject(new Error('This view needs the hosted engine.'));
    }
    return backend.sourcingTank(id, site, material);
  });
}
