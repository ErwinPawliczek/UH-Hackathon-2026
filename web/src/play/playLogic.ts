// The player's screen in words and numbers: pure functions, tested on their own.

import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { materialName } from '../ui/materials';
import type { RoomInfo, RoomScore } from '../store/roomTypes';

/** Price steps the slider offers: 20% under the going rate to 30% over, in 5% steps. */
export const PRICE_MIN = -0.2;
export const PRICE_MAX = 0.3;
export const PRICE_STEP = 0.05;

/** "3rd", "1st", "12th", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "3rd of 12" */
export const rankWords = (rank: number, of: number) => `${ordinal(rank)} of ${of}`;

/** What a price setting means, in a sentence. */
export function priceWords(markup: number): string {
  const pct = Math.round(Math.abs(markup) * 100);
  if (pct === 0) return 'At the going rate.';
  return markup > 0
    ? `${pct}% above the going rate: more per tonne, fewer buyers.`
    : `${pct}% below the going rate: less per tonne, more buyers.`;
}

/** "+5%", "−10%", "0%". */
export const pctSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round(Math.abs(v) * 100)}%`;

/** What a rate setting means. */
export function rateWords(share: number, min: number): string {
  const pct = Math.round(share * 100);
  if (pct >= 100) return 'Flat out: everything the plant can make.';
  if (share <= min + 1e-6) return `${pct}%: the lowest it can run without stopping.`;
  return `${pct}% of full rate: less made, less feed bought.`;
}

/** "$1.2 M", "$340 K", "-$12 K". */
export function fmtProfit(usd: number): string {
  const sign = usd < 0 ? '-' : '';
  const v = Math.abs(usd);
  if (v >= 999_500) return `${sign}$${(v / 1e6).toFixed(v >= 99_950_000 ? 0 : 1)} M`;
  if (v >= 1_000) return `${sign}$${Math.round(v / 1e3)} K`;
  return `${sign}$${Math.round(v)}`;
}

/** "12,400 t" */
export const fmtSold = (t: number) => `${Math.round(t).toLocaleString('en-US')} t`;

/** One line on what a site makes: "Makes ethylene, propylene and gasoline." */
export function makesWords(world: WorldSpec, site: number): string {
  const made = [...new Set(world.tanks.filter((t) => t.site === site && (t.role === 'product' || t.role === 'both')).map((t) => materialName(t.material)))];
  if (made.length === 0) return 'Sells what it is supplied.';
  const list = made.length <= 3 ? made : [...made.slice(0, 3), `${made.length - 3} more`];
  return `Makes ${list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`}.`;
}

export interface PlayUnit { index: number; key: string; name: string; trains: number; process: string }

/** A site's units with their global index (the engine's own, or counted in world order where it gives none). */
export function siteUnits(world: WorldSpec, site: number): PlayUnit[] {
  const out: PlayUnit[] = [];
  let counter = 0;
  world.sites.forEach((s, i) => {
    for (const p of s.processes) {
      for (const u of p.units) {
        const index = u.index ?? counter;
        counter += 1;
        if (i === site) out.push({ index, key: u.key, name: u.name, trains: u.trains, process: p.name });
      }
    }
  });
  return out;
}

/** The lowest share of full rate the site can hold: the highest turndown among its processes. */
export function minRate(world: WorldSpec, site: number): number {
  const t = Math.max(0, ...(world.sites[site]?.processes ?? []).map((p) => p.turndown ?? 0));
  return t > 0 && t < 1 ? Math.round(t * 20) / 20 : 0.4;
}

/** A site's state in a few words, from the snapshot. */
export function plantState(snap: Snapshot | null, site: number): { text: string; alarm: boolean } {
  switch (snap?.siteStatus[site] ?? 0) {
    case 3: return { text: 'Shut down', alarm: true };
    case 4: return { text: 'Restarting', alarm: true };
    case 1: return { text: 'Holding at its lowest rate', alarm: false };
    case 5: return { text: 'Running, limited', alarm: false };
    default: return { text: 'Running', alarm: false };
  }
}

/** Who else is in, for the waiting line: "Maya, Omar and 3 more". */
export function othersWords(room: RoomInfo, me: string | null): string {
  const names = room.players.filter((p) => p.id !== me).map((p) => p.name);
  if (names.length === 0) return 'You are the first one in.';
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return `Also in: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`;
}

/** The score row of a site, and how many plants are ranked. */
export function myScore(scores: RoomScore[], site: number | null): { score: RoomScore | null; of: number } {
  return { score: scores.find((s) => s.site === site) ?? null, of: scores.length };
}

/** Engine log types that mean something has gone wrong at a plant. */
const HIT_TYPES = new Set(['unit_failed', 'site_shutdown', 'supply_shock', 'demand_shock', 'process_shutdown', 'stockout']);
export const isHit = (type: string) => HIT_TYPES.has(type);

/** What the page remembers for a room, so a reload rejoins. */
export interface Seat { name: string; playerId: string; token: string }
const seatKey = (code: string) => `petrogrid-seat-${code.toUpperCase()}`;

export function loadSeat(code: string, store: Pick<Storage, 'getItem'> | null = safeStore()): Seat | null {
  try {
    const raw = store?.getItem(seatKey(code)) ?? null;
    if (raw === null) return null;
    const s = JSON.parse(raw) as Partial<Seat>;
    return typeof s.name === 'string' && typeof s.playerId === 'string' && typeof s.token === 'string' ? (s as Seat) : null;
  } catch {
    return null;
  }
}

export function saveSeat(code: string, seat: Seat | null, store: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStore()): void {
  try {
    if (seat === null) store?.removeItem(seatKey(code));
    else store?.setItem(seatKey(code), JSON.stringify(seat));
  } catch {
    // blocked storage: the seat lasts until the page is closed
  }
}

function safeStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The room code from the address: `?room=CODE` or `/play/CODE`. */
export function roomCode(location: Pick<Location, 'search' | 'pathname'>): string | null {
  const q = new URLSearchParams(location.search).get('room');
  const fromPath = /\/play\/([A-Za-z]{4})\/?$/.exec(location.pathname)?.[1];
  const code = (q ?? fromPath ?? '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : null;
}
