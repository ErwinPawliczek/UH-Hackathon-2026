// Deterministic stub event log (§7.2 log entries): sequence number, tick,
// type. The timeline panel renders these as markers until the real engine's
// event log arrives over HTTP. Events are a pure function of (seed, scenario,
// upToTick), so incremental queries (events since seq) stay consistent.

import { stubWorld } from './world';

export interface SimEvent {
  seq: number;
  tick: number;
  type: string;
  site?: number;
  unit?: string;
  text: string;
}

/** §7.2 log entry types. */
export const EVENT_TYPES = [
  'order_created', 'order_delivered', 'stockout', 'tank_full', 'process_shutdown',
  'process_restart', 'unit_failed', 'unit_repaired', 'mode_switch', 'reroute',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The scripted event each §9 demo scenario injects at day 2 (tick 192). */
const SCENARIO_EVENT: Record<string, { type: EventType; text: string; site?: number; unit?: string } | undefined> = {
  compressor_trip: { type: 'unit_failed', site: 2, unit: 'SC-CGC', text: 'Cracked-gas compressor tripped (10 d)' },
  chlorine_squeeze: { type: 'process_shutdown', site: 2, text: 'Power curtailed — chlor-alkali at 40%' },
  hurricane_landfall: { type: 'reroute', site: 3, text: 'Storm landfall — port bays and sea lanes closed' },
  low_river: { type: 'reroute', text: 'Low river — barge edges closed (20 d)' },
  gas_shortfall: { type: 'process_shutdown', site: 0, text: 'Gas field output halved (30 d)' },
};

export const SCENARIOS: { key: string; label: string }[] = [
  { key: 'none', label: 'No event' },
  { key: 'compressor_trip', label: 'Compressor trip' },
  { key: 'chlorine_squeeze', label: 'Chlorine squeeze' },
  { key: 'hurricane_landfall', label: 'Hurricane landfall' },
  { key: 'low_river', label: 'Low river' },
  { key: 'gas_shortfall', label: 'Gas shortfall' },
];

/** All stub events with tick <= upToTick, in tick order, seq = position. */
export function stubEvents(seed: number, upToTick: number, scenario: string): SimEvent[] {
  const world = stubWorld(seed);
  const nSites = world.sites.length;
  const candidates: Omit<SimEvent, 'seq'>[] = [];

  const scripted = SCENARIO_EVENT[scenario];
  if (scripted !== undefined && upToTick >= 192) {
    candidates.push({ tick: 192, ...scripted });
  }

  // one ambient event every ~3/4 day with per-seed jitter
  const rand = mulberry32(seed ^ 0xabcd1234);
  for (let k = 0; ; k++) {
    const tick = Math.floor(48 + k * 72 + 48 * rand());
    if (tick > upToTick) break;
    const type = EVENT_TYPES[k % EVENT_TYPES.length];
    const site = nSites > 0 ? k % nSites : undefined;
    const siteName = site !== undefined ? world.sites[site].name : '';
    candidates.push({ tick, type, site, text: `${type.replace(/_/g, ' ')} — ${siteName}` });
  }

  candidates.sort((a, b) => a.tick - b.tick);
  return candidates.map((e, seq) => ({ seq, ...e }));
}
