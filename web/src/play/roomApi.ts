// The room API the player's screen talks to (MULTIPLAYER-CONTRACT.md), as an
// interface with two implementations: HttpRoom, the real server, and
// MockRoom, a room that lives in the page (selected with `?mock`), so the
// screens can be built and looked at before the server exists. The mock runs
// the in-page stub world and makes up plausible scores; it is not the game.

import { decode, type Snapshot } from '../engine/snapshot';
import { encodeStub } from '../engine/stub';
import { resolveWorld, stubWorld, type WorldSpec } from '../engine/world';
import type { SimEvent } from '../engine/api';

export type RoomPhase = 'lobby' | 'running' | 'paused' | 'ended';

export interface RoomPlayer { id: string; name: string; site: number | null; connected: boolean }
export interface RoomSite { index: number; key: string; name: string; preset: string; playable: boolean; owner: string | null }
export interface RoomState { code: string; phase: RoomPhase; tick: number; speed: number; players: RoomPlayer[]; sites: RoomSite[] }
export interface Score {
  site: number; name: string; owner: string | null; ownerName: string | null;
  profitUsd: number; revenueUsd: number; feedUsd: number; freightUsd: number; energyUsd: number;
  markup: number; rateShare: number; soldT: number; rank: number;
}
export interface Scores { tick: number; scores: Score[] }
export interface Reply { ok: boolean; error?: string }

export type PlayAction =
  | { action: 'price'; markup: number }
  | { action: 'rate'; share: number }
  | { action: 'unit'; unit_index: number; down: boolean };

export interface RoomApi {
  room(): Promise<RoomState>;
  join(name: string): Promise<{ playerId: string; token: string }>;
  claim(token: string, site: number | null): Promise<Reply>;
  play(token: string, action: PlayAction): Promise<Reply>;
  /** the current snapshot, or null when it has not changed since the last call */
  snapshot(): Promise<Snapshot | null>;
  world(): Promise<WorldSpec>;
  scores(): Promise<Scores>;
  events(since: number): Promise<SimEvent[]>;
}

/** A refused request, with the server's own sentence when it sent one. */
export class RoomError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class HttpRoom implements RoomApi {
  private etag: string | null = null;
  private keys: Map<string, number> | null = null;

  constructor(private readonly code: string, private readonly base = '', private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private path(rest = ''): string {
    return `${this.base}/api/room/${encodeURIComponent(this.code)}${rest}`;
  }

  private async send(rest: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.path(rest), body === undefined
        ? { headers }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    } catch {
      throw new RoomError(0, 'Cannot reach the game. Check your connection.');
    }
    if (!res.ok && res.status !== 304) {
      const text = await res.text().catch(() => '');
      let reason = res.status === 404 ? 'This game no longer exists.' : `The game answered ${res.status}.`;
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (typeof j.error === 'string' && j.error !== '') reason = j.error;
      } catch {
        // not JSON: the plain sentence stands
      }
      throw new RoomError(res.status, reason);
    }
    return res;
  }

  private async json<T>(rest: string, body?: unknown): Promise<T> {
    return (await (await this.send(rest, body)).json()) as T;
  }

  room(): Promise<RoomState> { return this.json(''); }
  join(name: string): Promise<{ playerId: string; token: string }> { return this.json('/join', { name }); }
  claim(token: string, site: number | null): Promise<Reply> { return this.json('/claim', { token, site }); }
  play(token: string, action: PlayAction): Promise<Reply> { return this.json('/play', { token, ...action }); }
  scores(): Promise<Scores> { return this.json('/scores'); }

  async snapshot(): Promise<Snapshot | null> {
    const res = await this.send('/snapshot', undefined, this.etag === null ? {} : { 'If-None-Match': this.etag });
    if (res.status === 304) return null;
    const etag = res.headers.get('ETag');
    if (etag !== null && etag === this.etag) return null;
    this.etag = etag;
    return decode(await res.arrayBuffer());
  }

  async world(): Promise<WorldSpec> {
    const world = resolveWorld(await this.json<unknown>('/world'), 42);
    this.keys = new Map(world.sites.map((s, i) => [s.key ?? '', i]));
    return world;
  }

  async events(since: number): Promise<SimEvent[]> {
    const raw = await this.json<(Omit<SimEvent, 'site'> & { site?: string | number })[]>(`/events?since=${Math.max(0, Math.floor(since))}`);
    // the engine names an event's site by key; the client goes by index
    return raw.map((e) => {
      if (typeof e.site !== 'string') return e as SimEvent;
      const { site, ...rest } = e;
      const index = this.keys?.get(site);
      return index === undefined ? rest : { ...rest, site: index };
    });
  }
}

// ---------------------------------------------------------------------------
// The mock: one room in the page, with a few made-up players already in it.
// ---------------------------------------------------------------------------

const MOCK_KEY = 'petrogrid-mock-room';
const CUSTOMER = /DEPOT|GRID|PACKAGING|CONSTRUCTION|CONSUMER|PAINTS|INDUSTRIES|PORT/;

interface MockSave { players: RoomPlayer[]; tokens: Record<string, string>; phase: RoomPhase; startedAt: number | null; tick: number; price: Record<string, number>; rate: Record<string, number>; down: number[] }

export class MockRoom implements RoomApi {
  private readonly worldSpec = stubWorld(42);
  private s: MockSave;
  private lastTick = -1;

  constructor(private readonly code: string, private readonly now: () => number = () => Date.now()) {
    this.s = this.load();
  }

  private load(): MockSave {
    try {
      const raw = sessionStorage.getItem(`${MOCK_KEY}-${this.code}`);
      if (raw !== null) return JSON.parse(raw) as MockSave;
    } catch {
      // no storage: a fresh room each load
    }
    return {
      players: [
        { id: 'p-maya', name: 'Maya', site: 0, connected: true },
        { id: 'p-omar', name: 'Omar', site: 2, connected: true },
        { id: 'p-lin', name: 'Lin', site: null, connected: true },
      ],
      tokens: {}, phase: 'lobby', startedAt: null, tick: 0, price: {}, rate: {}, down: [],
    };
  }

  private save(): void {
    try {
      sessionStorage.setItem(`${MOCK_KEY}-${this.code}`, JSON.stringify(this.s));
    } catch {
      // nothing to keep
    }
  }

  /** The host's part, for looking at the screens: `?mock=running` starts the clock, `?mock=paused` holds it. */
  host(action: 'start' | 'pause' | 'resume'): void {
    if (action === 'pause') { this.advance(); this.s.phase = 'paused'; this.s.startedAt = null; }
    else { this.s.phase = 'running'; this.s.startedAt = this.now(); }
    this.save();
  }

  private advance(): void {
    if (this.s.phase !== 'running' || this.s.startedAt === null) return;
    const now = this.now();
    this.s.tick += Math.floor(((now - this.s.startedAt) / 1000) * 16); // 4 sim hours a second
    this.s.startedAt = now;
  }

  private player(token: string): RoomPlayer | undefined {
    const id = this.s.tokens[token];
    return this.s.players.find((p) => p.id === id);
  }

  async room(): Promise<RoomState> {
    this.advance();
    return {
      code: this.code, phase: this.s.phase, tick: this.s.tick, speed: 4, players: this.s.players,
      sites: this.worldSpec.sites.map((site, index) => ({
        index, key: site.key ?? site.preset, name: site.name, preset: site.preset,
        playable: !CUSTOMER.test(site.preset),
        owner: this.s.players.find((p) => p.site === index)?.id ?? null,
      })),
    };
  }

  async join(name: string): Promise<{ playerId: string; token: string }> {
    const clean = name.trim().slice(0, 20);
    if (clean === '') throw new RoomError(400, 'Give a name of 1 to 20 characters.');
    const playerId = `p-${this.s.players.length + 1}`;
    const token = `t-${playerId}-${Math.round(this.now() % 1e6)}`;
    this.s.players.push({ id: playerId, name: clean, site: null, connected: true });
    this.s.tokens[token] = playerId;
    this.save();
    return { playerId, token };
  }

  async claim(token: string, site: number | null): Promise<Reply> {
    const me = this.player(token);
    if (me === undefined) return { ok: false, error: 'You are not in this game any more.' };
    if (site !== null && this.s.players.some((p) => p.site === site && p.id !== me.id)) return { ok: false, error: 'Someone has just taken that plant.' };
    me.site = site;
    this.save();
    return { ok: true };
  }

  async play(token: string, action: PlayAction): Promise<Reply> {
    const me = this.player(token);
    if (me === undefined || me.site === null) return { ok: false, error: 'You have no plant.' };
    if (action.action === 'price') this.s.price[me.id] = action.markup;
    if (action.action === 'rate') this.s.rate[me.id] = action.share;
    if (action.action === 'unit') this.s.down = action.down ? [...new Set([...this.s.down, action.unit_index])] : this.s.down.filter((u) => u !== action.unit_index);
    this.save();
    return { ok: true };
  }

  async snapshot(): Promise<Snapshot | null> {
    this.advance();
    if (this.s.tick === this.lastTick) return null;
    this.lastTick = this.s.tick;
    const snap = decode(encodeStub(42, this.s.tick));
    for (const u of this.s.down) if (u < snap.unitTrains.length) snap.unitTrains[u] = 0;
    return snap;
  }

  async world(): Promise<WorldSpec> { return this.worldSpec; }

  async scores(): Promise<Scores> {
    this.advance();
    const days = this.s.tick / 96;
    const scores = this.worldSpec.sites
      .map((site, index) => ({ site, index }))
      .filter(({ site }) => !CUSTOMER.test(site.preset))
      .map(({ site, index }) => {
        const owner = this.s.players.find((p) => p.site === index) ?? null;
        const markup = owner === null ? 0 : this.s.price[owner.id] ?? 0;
        const share = owner === null ? 1 : this.s.rate[owner.id] ?? 1;
        // a made-up market: a higher price earns more per tonne and sells fewer
        const sold = days * 900 * (1 + index * 0.13) * share * Math.max(0.2, 1 - 1.6 * Math.max(0, markup));
        const revenue = sold * 620 * (1 + markup);
        return {
          site: index, name: site.name, owner: owner?.id ?? null, ownerName: owner?.name ?? null,
          profitUsd: revenue * 0.31, revenueUsd: revenue, feedUsd: revenue * 0.5, freightUsd: revenue * 0.07, energyUsd: revenue * 0.12,
          markup, rateShare: share, soldT: sold, rank: 0,
        };
      })
      .sort((a, b) => b.profitUsd - a.profitUsd)
      .map((s, i) => ({ ...s, rank: i + 1 }));
    return { tick: this.s.tick, scores };
  }

  async events(since: number): Promise<SimEvent[]> {
    this.advance();
    const all: SimEvent[] = [];
    if (this.s.tick >= 96) all.push({ seq: 0, tick: 96, type: 'unit_failed', site: this.s.players.find((p) => this.s.tokens && Object.values(this.s.tokens).includes(p.id))?.site ?? 1, text: 'A compressor has tripped (the host set this off)' });
    return all.filter((e) => e.seq >= since);
  }
}
