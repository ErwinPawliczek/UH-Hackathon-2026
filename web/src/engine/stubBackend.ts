// In-page stub backend (default): wraps the stub snapshot producer in the
// SimBackend interface. Session ids carry the seed and scenario so every
// method can regenerate the same deterministic state; step advances the tick
// the way crx_step would.

import { decode, type Snapshot } from './snapshot';
import { encodeStub, stubVehicleState, type StubOutage } from './stub';
import { stubEvents } from './events';
import { VEHICLE_CLASSES, routeLength, stubWorld, type WorldSpec } from './world';
import type { EconomyReply, ForecastReply, SimBackend, SimConfig, SimEvent, SiteRef, VehicleDetail } from './api';

/** Ticks per hour: 96 ticks/day (§9) — outage durations arrive in hours. */
const TICKS_PER_HOUR = 4;

interface StubSession {
  seed: number;
  scenario: string;
  tick: number;
  outages: StubOutage[];
}

export class StubBackend implements SimBackend {
  readonly kind = 'stub' as const;
  private readonly sessions = new Map<string, StubSession>();
  private forkCounter = 0;

  private static encodeId(s: StubSession): string {
    return `stub:${s.seed}:${s.scenario}`;
  }

  private session(id: string): StubSession {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`no such stub session: ${id}`);
    return s;
  }

  async create(config: SimConfig): Promise<{ id: string }> {
    const session: StubSession = { seed: config.seed, scenario: config.scenario, tick: 0, outages: [] };
    const id = StubBackend.encodeId(session);
    this.sessions.set(id, session);
    return { id };
  }

  async world(id: string): Promise<WorldSpec> {
    return stubWorld(this.session(id).seed);
  }

  async step(id: string, ticks: number): Promise<Snapshot> {
    const s = this.session(id);
    s.tick += ticks;
    return decode(encodeStub(s.seed, s.tick, s.outages));
  }

  async command(id: string, cmd: Record<string, unknown>): Promise<unknown> {
    const s = this.session(id);
    if (cmd.type === 'unit_outage') {
      const err = this.queueOutage(s, cmd);
      if (err !== null) return { ok: false, error: err };
      return { ok: true };
    }
    // other §7.2 commands are accepted and echoed (no state change yet)
    return { ok: true, echo: cmd };
  }

  /**
   * Mirror of the hosted engine's unit_outage event (engine/src/sim/events.cpp):
   * { type, site, unit (type key), trains, duration_h }. Resolves the unit's
   * flat snapshot slot within the site and queues the outage starting at the
   * session's current tick.
   */
  private queueOutage(s: StubSession, cmd: Record<string, unknown>): string | null {
    const site = cmd.site;
    const unitKey = cmd.unit;
    const trains = cmd.trains;
    if (typeof site !== 'number' || !Number.isInteger(site)) return "unit_outage: need 'site' (index)";
    if (typeof unitKey !== 'string' || unitKey === '') return "unit_outage: need 'unit' (key)";
    if (typeof trains !== 'number' || !Number.isInteger(trains) || trains < 1)
      return "unit_outage: need 'trains' >= 1";
    const durationH = typeof cmd.duration_h === 'number' && cmd.duration_h > 0 ? cmd.duration_h : 24;

    const world = stubWorld(s.seed);
    const siteSpec = world.sites[site];
    if (siteSpec === undefined) return `unit_outage: no such site ${site}`;

    // Flat snapshot indices are site-major: all units of sites < site, then
    // this site's processes in order; a unit's slot is its index within its
    // process.
    let procIdx = 0;
    let unitIdx = 0;
    for (const other of world.sites.slice(0, site)) {
      for (const proc of other.processes) {
        procIdx += 1;
        unitIdx += proc.units.length;
      }
    }
    for (const proc of siteSpec.processes) {
      const within = proc.units.findIndex((u) => u.key === unitKey);
      if (within >= 0) {
        s.outages.push({
          siteIdx: site,
          unitIdx: unitIdx + within,
          // procIdx already counts every earlier process (site-major), so at
          // the match it IS the flat snapshot index
          procIdx,
          unitKey,
          trains,
          startTick: s.tick,
          endTick: s.tick + Math.round(durationH * TICKS_PER_HOUR),
        });
        return null;
      }
      procIdx += 1;
      unitIdx += proc.units.length;
    }
    return `unit_outage: no unit '${unitKey}' at site ${site}`;
  }

  async fork(id: string): Promise<{ id: string }> {
    const s = this.session(id);
    const fork: StubSession = { ...s };
    const forkId = `${StubBackend.encodeId(s)}:f${this.forkCounter++}`;
    this.sessions.set(forkId, fork);
    return { id: forkId };
  }

  async events(id: string, sinceSeq: number): Promise<SimEvent[]> {
    const s = this.session(id);
    // Merged log: synthetic events and operator outages re-ranked by tick into
    // one append-only stream (outages command at the current tick, so they
    // always sort at the frontier and never reshuffle earlier entries). This
    // keeps `seq` comparable with the UI's lastSeq across both event sources.
    const synthetic = stubEvents(s.seed, s.tick, s.scenario);
    const outageEvents: Omit<SimEvent, 'seq'>[] = s.outages
      .filter((o) => o.startTick <= s.tick)
      .map((o) => ({
        tick: o.startTick,
        type: 'unit_failed',
        site: o.siteIdx,
        unit: o.unitKey,
        text: `Operator: ${o.unitKey} — ${o.trains} train(s) down (${Math.round((o.endTick - o.startTick) / TICKS_PER_HOUR)} h)`,
      }));
    const merged: SimEvent[] = [
      ...synthetic.map(({ seq: _seq, ...rest }) => rest),
      ...outageEvents,
    ]
      .sort((a, b) => a.tick - b.tick)
      .map((e, seq) => ({ ...e, seq }));
    return merged.filter((e) => e.seq > sinceSeq);
  }

  async kpis(id: string): Promise<number[]> {
    this.session(id);
    return [];
  }

  async series(id: string, kind: number, refId: number): Promise<number[]> {
    this.session(id);
    void kind;
    void refId;
    return [];
  }

  /**
   * The stub's vehicles shuttle one route each: the trip is that route, the
   * cargo is the vehicle's declared one on the outbound leg.
   */
  async vehicle(id: string, index: number): Promise<VehicleDetail> {
    const s = this.session(id);
    const world = stubWorld(s.seed);
    const spec = world.vehicles[index];
    if (spec === undefined || spec.route === undefined) throw new Error(`no such stub vehicle: ${index}`);
    const st = stubVehicleState(world, s.tick, index);
    const route = world.routes[spec.route];
    const capacityT = VEHICLE_CLASSES[spec.cls].capacityT;
    const tripKm = routeLength(route.points);
    const end = (k: 0 | 1): SiteRef => {
      const site = route.sites[k];
      return { site: site ?? -1, key: route.ends[k].toUpperCase().replace(/\W+/g, '_'), name: route.ends[k] };
    };
    const from = end(st.outbound ? 0 : 1);
    const to = end(st.outbound ? 1 : 0);
    const status = ['idle', 'to_pickup', 'queue_load', 'loading', 'to_dropoff', 'queue_unload', 'unloading'][st.status] ?? 'idle';
    const points = st.outbound ? route.points : [...route.points].reverse();
    return {
      index,
      cls: spec.cls,
      capacityT,
      status,
      cargo: st.outbound ? { material: spec.cargo, tonnes: st.fill * capacityT } : null,
      order: {
        id: st.orderId,
        material: spec.cargo,
        tonnes: capacityT,
        from: st.outbound ? from : to,
        to: st.outbound ? to : from,
        createdTick: Math.max(0, s.tick - 8),
        etaTick: st.etaTick,
        priceUsdT: 0,
        freightUsd: 0,
      },
      at: { site: null },
      legDestination: to,
      path: [[st.x, st.y], ...points.slice(1)],
      remainingKm: (1 - st.legProgress) * tripKm,
      tripKm,
    };
  }

  /** The stub keeps no books and cannot look ahead: the economy views need the hosted engine. */
  async forecast(id: string, days: number): Promise<ForecastReply> {
    this.session(id);
    void days;
    throw new Error('forecast needs the hosted engine');
  }

  async economy(id: string, bucketH: number): Promise<EconomyReply> {
    this.session(id);
    void bucketH;
    throw new Error('economy needs the hosted engine');
  }

  /**
   * The stub's state is a pure function of (seed, tick, outages), so going
   * back is setting the tick and forgetting outages commanded at it or later.
   */
  async rewind(id: string, tick: number): Promise<{ tick: number }> {
    const s = this.session(id);
    if (!Number.isInteger(tick) || tick < 0) throw new Error('rewind: tick must be a non-negative integer');
    if (tick > s.tick) throw new Error('rewind: tick is ahead of the run');
    s.tick = tick;
    s.outages = s.outages.filter((o) => o.startTick < tick);
    return { tick };
  }

  /** Stub sessions live in-page; releasing just drops the deterministic state. */
  async release(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
