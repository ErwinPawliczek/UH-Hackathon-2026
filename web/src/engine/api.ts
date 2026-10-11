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
    etaTick: number;
    priceUsdT: number;
    freightUsd: number;
  } | null;
  /** the site it is standing at, when it is at one */
  at: { site: number | null };
  /** where the leg it is driving now ends */
  legDestination: SiteRef | null;
  /** the rest of its planned route, km points in map coordinates, from where it is */
  path: [number, number][];
  remainingKm: number;
  tripKm: number;
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
