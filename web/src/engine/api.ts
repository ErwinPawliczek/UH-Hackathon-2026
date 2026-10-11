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
