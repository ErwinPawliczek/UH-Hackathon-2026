// The sim API client interface. Two backends implement it: HttpBackend (the
// §7.4 crx-server routes — the default for visitors) and StubBackend (the
// in-page stub producer, for tests and local development, selected via the
// ?engine= URL parameter). The app only ever talks to this interface.

import type { Snapshot } from './snapshot';
import type { WorldSpec } from './world';
import { StubBackend } from './stubBackend';
import { HttpBackend } from './httpBackend';

export type BackendKind = 'stub' | 'http';

/** Session-create body: §9 scenario plus seed (config JSON for crx_create). */
export interface SimConfig {
  seed: number;
  scenario: string;
  /**
   * Named world to load (engine/data/worlds/<name>.json). Absent or
   * 'sixsite' asks for the engine's built-in six-site world.
   */
  world?: string;
}

/** §7.2 log entry. */
export interface SimEvent {
  seq: number;
  tick: number;
  type: string;
  site?: number;
  unit?: string;
  text: string;
}

/** One end of an order, or where a vehicle is heading: a site by index, key and name. */
export interface SiteRef {
  site: number;
  key: string;
  name: string;
}

/** GET /api/sim/{id}/vehicle?index=N — what one vehicle is doing right now. */
export interface VehicleDetail {
  index: number;
  cls: string;
  capacityT: number;
  /** idle | to_pickup | queue_load | loading | to_dropoff | queue_unload | unloading */
  status: string;
  /** what is on board, null when empty */
  cargo: { material: string; tonnes: number } | null;
  /** the order it is working on, null when idle */
  order: {
    id: number;
    material: string;
    tonnes: number;
    from: SiteRef;
    to: SiteRef;
    createdTick: number;
    /** the arrival estimate made when the order was booked, not a live one */
    etaTick: number;
    priceUsdT: number;
    freightUsd: number;
  } | null;
  /** the site it is standing at, when it is at one */
  at: { site: number | null };
  /** where it is, in map km */
  position?: [number, number];
  /** where the leg it is driving now ends */
  legDestination: SiteRef | null;
  /**
   * the rest of its planned route, km points in map coordinates, starting at
   * `position`; empty unless it is driving (to_pickup or to_dropoff)
   */
  path: [number, number][];
  remainingKm: number;
  tripKm: number;
}

/** One branch of a forecast: the run carried forward with, or without, what is broken now. */
export interface ForecastBranch {
  from_tick: number;
  to_tick: number;
  totals: {
    demand_t: number; unmet_t: number; unmet_usd: number; freight_usd: number; energy_usd: number;
    inventory_usd: number; inventory_change_usd: number; service: number; shutdown_h: number;
  };
  customers: {
    site: string; site_index: number; name: string; process: string; process_name: string; material: string;
    demand_t: number; served_t: number; service: number; dry_at_start: boolean; first_dry_tick: number | null;
  }[];
  plants: {
    site: string; site_index: number; name: string; process: string; process_name: string;
    down_h: number; down_at_start: boolean; first_down_tick: number | null;
  }[];
}

/** POST /api/sim/{id}/forecast — what the disruptions active now cost over the coming days. */
export interface ForecastReply {
  tick: number;
  to_tick: number;
  days: number;
  /** how many disruptions are active at `tick`; 0 means nothing is broken */
  disruptions: number;
  with: ForecastBranch;
  without: ForecastBranch;
  /** with minus without; cost_usd = unmet_usd - inventory_usd + energy_usd + freight_usd */
  delta: {
    cost_usd: number; unmet_usd: number; freight_usd: number; energy_usd: number; inventory_usd: number;
    unmet_t: number; service: number; shutdown_h: number;
  };
  /** what stops next, soonest first */
  countdown: {
    site: string; site_index: number; name: string; kind: 'shuts_down' | 'runs_dry' | string; what: string;
    tick: number; hours_from_now: number; already: boolean;
  }[];
}

/** GET /api/sim/{id}/economy?bucket_h= — the run so far in buckets: one value per bucket in every array. */
export interface EconomyReply {
  tick: number;
  bucketH: number;
  buckets: number;
  materials: {
    key: string; name: string; basePriceUsdT: number;
    orderedT: number[]; lots: number[]; spendUsd: number[]; freightUsd: number[]; deliveredT: number[];
    priceIndex?: number[];
  }[];
  byClass: { cls: string; tonnes: number[]; tonneKm: number[]; freightUsd: number[] }[];
  totals: {
    spendUsd: number[]; freightUsd: number[]; energyUsd: number[]; unmetUsd: number[]; unmetT: number[];
    demandT: number[]; service: number[]; shutdownH: number[];
  };
  plants: {
    site: string; site_index: number; name: string; process: string; process_name: string; index: number;
    designRateTph: number; rateMin: number[]; rateMean: number[]; rateMax: number[];
    /** lowest rate the process can hold, as a share of design, when the engine reports it */
    turndown?: number;
  }[];
}

/** How a plant that sells a material is doing, as the sourcing calls report it. */
export type SupplierState = 'running' | 'held' | 'restarting' | 'shut_down' | 'no_producer';

/** One buying tank in GET /api/sim/{id}/sourcing: how long its stock lasts and who usually fills it. */
export interface SourcingTank {
  site: string;
  site_index: number;
  name: string;
  material: string;
  material_name: string;
  fill: number;
  /** hours of stock at the design draw; null when nothing draws from it */
  cover_h: number | null;
  draw_t_h: number;
  inbound_t: number;
  /** how many ways there are to supply it */
  options: number;
  /** site key of the seller that has delivered most so far */
  usual: string | null;
  usual_state: SupplierState | null;
}

export interface SourcingList {
  tick: number;
  tanks: SourcingTank[];
}

/** One way to supply a tank: a seller and a vehicle type, with what it would take and cost. */
export interface SourcingOption {
  seller: string;
  seller_index: number;
  seller_name: string;
  seller_state: SupplierState;
  stock_t: number;
  /** stock not already promised to someone else */
  free_t: number;
  seller_fill: number;
  cls: string;
  mode: string;
  vehicles: number;
  idle_now: number;
  km: number;
  travel_h: number;
  handling_h: number;
  /** hours for the nearest free vehicle to reach the seller; null when none can */
  pickup_h: number | null;
  door_to_door_h: number;
  lot_t: number;
  ask_usd_t: number;
  freight_usd_t: number;
  time_usd_t: number;
  switch_usd_t: number;
  /** what the engine compares: ask + freight + time + switching */
  landed_usd_t: number;
  price_usd_t: number;
  feasible_now: boolean;
  blocked: null | 'no_vehicles' | 'seller_short' | 'unreachable' | 'export_fill' | string;
  arrives_before_dry: boolean;
  /** the next hourly ordering pass will book this one */
  chosen: boolean;
  /** this seller has delivered most so far */
  usual: boolean;
}

/** GET /api/sim/{id}/sourcing?site=&material= — one buying tank and every way to supply it, cheapest first. */
export interface SourcingDetail {
  tick: number;
  tank: {
    site: string; site_index: number; name: string; material: string; material_name: string;
    buys: boolean; piped_in: boolean; level_t: number; capacity_t: number; fill: number; target_t: number;
    draw_t_h: number; cover_h: number | null; inbound_t: number; lead_time_h: number; urgency: number;
    want_t: number; quoted_for_t: number;
  };
  next_pass: { tick: number; lots: { seller: string; cls: string; tonnes: number }[]; tonnes: number } | null;
  usual: { site: string; site_index: number; name: string; delivered_t: number; state: SupplierState } | null;
  options: SourcingOption[];
}

export interface SimBackend {
  readonly kind: BackendKind;
  /** POST /api/sim — create a session from config; reply { id }. */
  create(config: SimConfig): Promise<{ id: string }>;
  /** GET /api/sim/{id}/world — static world description, read once. */
  world(id: string): Promise<WorldSpec>;
  /** POST /api/sim/{id}/step — advance N ticks; reply is the snapshot binary. */
  step(id: string, ticks: number): Promise<Snapshot>;
  /** POST /api/sim/{id}/command — a §7.2 command; reply is the engine's JSON. */
  command(id: string, cmd: Record<string, unknown>): Promise<unknown>;
  /** POST /api/sim/{id}/fork — baseline twin; reply { id }. */
  fork(id: string): Promise<{ id: string }>;
  /** GET /api/sim/{id}/events?since= — incremental log. */
  events(id: string, sinceSeq: number): Promise<SimEvent[]>;
  /** GET /api/sim/{id}/kpis — KPI vector. */
  kpis(id: string): Promise<number[]>;
  /** GET /api/sim/{id}/series?kind=&id= — hourly history. */
  series(id: string, kind: number, refId: number): Promise<number[]>;
  /** GET /api/sim/{id}/vehicle?index= — one vehicle's cargo, order and route. */
  vehicle(id: string, index: number): Promise<VehicleDetail>;
  /** POST /api/sim/{id}/forecast — the next `days` with and without the disruptions active now. (Optional: test doubles may leave it out.) */
  forecast?(id: string, days: number): Promise<ForecastReply>;
  /** GET /api/sim/{id}/economy?bucket_h= — orders, spend, freight and plant rates of the run so far, per bucket. (Optional, as above.) */
  economy?(id: string, bucketH: number): Promise<EconomyReply>;
  /** GET /api/sim/{id}/sourcing — every buying tank, or with `tank` one tank and its supply options. (Optional, as above.) */
  sourcing?(id: string): Promise<SourcingList>;
  sourcingTank?(id: string, site: string, material: string): Promise<SourcingDetail>;
  /**
   * POST /api/sim/{id}/rewind — make the session exactly what it was at
   * `tick` (commands issued at that tick or later are forgotten). Afterwards
   * events, series and KPIs reflect only ticks up to it, with event sequence
   * numbers as a fresh run would have them. Rejects when the tick is ahead of
   * the run or the session is unknown.
   */
  rewind(id: string, tick: number): Promise<{ tick: number }>;
  /**
   * DELETE /api/sim/{id} — release the session now: the client calls it
   * whenever it replaces a session (retry, settings change, new world/preset
   * load) and on page unload. Best-effort: never throws.
   */
  release(id: string): Promise<void>;
}

export function createBackend(kind: BackendKind, baseUrl = ''): SimBackend {
  if (kind === 'stub') return new StubBackend();
  return new HttpBackend(baseUrl);
}
