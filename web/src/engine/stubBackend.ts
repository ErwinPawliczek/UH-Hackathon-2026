// In-page stub backend (default): wraps the stub snapshot producer in the
// SimBackend interface. Session ids carry the seed and scenario so every
// method can regenerate the same deterministic state; step advances the tick
// the way crx_step would.

import { decode, type Snapshot } from './snapshot';
import { encodeStub } from './stub';
import { stubEvents } from './events';
import { stubWorld, type WorldSpec } from './world';
import type { SimBackend, SimConfig, SimEvent } from './api';

interface StubSession {
  seed: number;
  scenario: string;
  tick: number;
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
    const session: StubSession = { seed: config.seed, scenario: config.scenario, tick: 0 };
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
    return decode(encodeStub(s.seed, s.tick));
  }

  async command(id: string, cmd: Record<string, unknown>): Promise<unknown> {
    this.session(id);
    // the stub accepts every §7.2 command and echoes it (no state change yet)
    return { ok: true, echo: cmd };
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
    return stubEvents(s.seed, s.tick, s.scenario).filter((e) => e.seq > sinceSeq);
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
