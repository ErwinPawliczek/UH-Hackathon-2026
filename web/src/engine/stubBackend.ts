// In-page stub backend (default): wraps the stub snapshot producer in the
// SimBackend interface. Session ids carry the seed and scenario so every
// method can regenerate the same deterministic state; step advances the tick
// the way crx_step would.

import { decode, type Snapshot } from './snapshot';
import { encodeStub, type StubOutage } from './stub';
import { stubEvents } from './events';
import { stubWorld, type WorldSpec } from './world';
import type { SimBackend, SimConfig, SimEvent } from './api';

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
}
