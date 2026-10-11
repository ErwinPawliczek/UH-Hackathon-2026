// HTTP client for the §7.4 crx-server routes. One origin, no CORS; fetch with
// binary snapshot handling (the step reply is the §7.3 snapshot, decoded into
// typed-array views with no copy). Inject the fetch implementation for tests.

import { decode, type Snapshot } from './snapshot';
import type { WorldSpec } from './world';
import type {
  EconomyReply, ForecastReply, SimBackend, SimConfig, SimEvent, SourcingDetail, SourcingList, VehicleDetail,
} from './api';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** The engine's built-in world: requested by sending no `world` key at all. */
export const BUILTIN_WORLD = 'sixsite';

/** Non-2xx reply. Status is typed so callers can branch — e.g. a 404/410 means
 * the session id is gone server-side (idle expiry or LRU eviction) and the
 * client recreates instead of erroring. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** the reply body as sent (often {"error": "..."}) */
    readonly body: string = '',
  ) {
    super(message);
  }

  /** The server's own explanation when the body carries one, else the message. */
  get reason(): string {
    try {
      const parsed = JSON.parse(this.body) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error;
    } catch {
      // not JSON: fall through to the plain message
    }
    return this.message;
  }
}

/** An event as the engine sends it: `site` is the site's key ("CRACKER_ETHANE"), not its index. */
type WireEvent = Omit<SimEvent, 'site'> & { site?: string | number };

/** Site key → index in the world's site list. */
export function siteKeyIndex(world: Pick<WorldSpec, 'sites'> | undefined): Map<string, number> {
  const keys = new Map<string, number>();
  (world?.sites ?? []).forEach((site, i) => {
    if (typeof site.key === 'string') keys.set(site.key, i);
  });
  return keys;
}

/**
 * Events with `site` as the client uses it everywhere: an index into the
 * world's sites. A key the world does not have leaves the event without a
 * site rather than pointing it at the wrong one.
 */
export function resolveEventSites(events: WireEvent[], keys: ReadonlyMap<string, number>): SimEvent[] {
  return events.map((e) => {
    if (typeof e.site !== 'string') return e as SimEvent;
    const { site, ...rest } = e;
    const index = keys.get(site);
    return index === undefined ? rest : { ...rest, site: index };
  });
}

export class HttpBackend implements SimBackend {
  readonly kind = 'http' as const;

  /** per session: its world's site keys, for turning an event's site key into an index */
  private readonly siteKeys = new Map<string, Map<string, number>>();

  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async send(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, init);
    } catch (err) {
      // Network-level failure (refused, DNS, offline): the engine is
      // unreachable — say so plainly instead of leaking fetch internals.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot reach the hosted engine (${reason})`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(
        res.status,
        `${init?.method ?? 'GET'} ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`,
        detail,
      );
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.send(path, init);
    return (await res.json()) as T;
  }

  async create(config: SimConfig): Promise<{ id: string }> {
    // The engine's create contract is {seed, world?, adaptation?} (§7.1); the
    // UI's scenario list is a stub-era demo feature until the demo maps
    // scenarios onto queued engine events (M4+). Passing scenario through
    // gets the config rejected — the engine refuses unknown keys on purpose.
    const post = (body: Record<string, unknown>) =>
      this.json<{ id: string }>('/api/sim', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    const named = config.world !== undefined && config.world !== BUILTIN_WORLD;
    if (!named) return post({ seed: config.seed });
    try {
      return await post({ seed: config.seed, world: config.world });
    } catch (err) {
      // A 400 here means this server cannot build the named world (an older
      // build that refuses the `world` key, or a world file it does not
      // ship). Fall back to its built-in world so the visitor still gets a
      // running simulation instead of an error screen.
      if (err instanceof HttpError && err.status === 400) return post({ seed: config.seed });
      throw err;
    }
  }

  async world(id: string): Promise<WorldSpec> {
    const world = await this.json<WorldSpec>(`/api/sim/${encodeURIComponent(id)}/world`);
    this.siteKeys.set(id, siteKeyIndex(world));
    return world;
  }

  async step(id: string, ticks: number): Promise<Snapshot> {
    const path = `/api/sim/${encodeURIComponent(id)}/step`;
    const res = await this.send(path, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ticks }),
    });
    return decode(await res.arrayBuffer());
  }

  async command(id: string, cmd: Record<string, unknown>): Promise<unknown> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/command`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(cmd),
    });
  }

  async fork(id: string): Promise<{ id: string }> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/fork`, { method: 'POST' });
  }

  async events(id: string, sinceSeq: number): Promise<SimEvent[]> {
    // §7.4 `since` is an unsigned seq. The store's "nothing fetched yet"
    // sentinel (-1, which lets the 0-based stub log include seq 0) must not
    // reach the wire — floor it at 0.
    const since = Math.max(0, Math.floor(sinceSeq));
    const events = await this.json<WireEvent[]>(`/api/sim/${encodeURIComponent(id)}/events?since=${since}`);
    // The engine names an event's site by key; the client selects sites by index.
    if (!events.some((e) => typeof e.site === 'string')) return events as SimEvent[];
    if (!this.siteKeys.has(id)) await this.world(id); // a session whose world was never asked for (a fork)
    return resolveEventSites(events, this.siteKeys.get(id) ?? new Map());
  }

  async kpis(id: string): Promise<number[]> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/kpis`);
  }

  /**
   * Hourly history: one value per simulated hour, oldest first (the engine
   * keeps the last 60 days). The reply is a raw little-endian float32 array,
   * not JSON; an empty body means no hour has been recorded yet.
   */
  async series(id: string, kind: number, refId: number): Promise<number[]> {
    const res = await this.send(`/api/sim/${encodeURIComponent(id)}/series?kind=${kind}&id=${refId}`);
    const type = res.headers.get('Content-Type') ?? '';
    if (type.includes('json')) return (await res.json()) as number[]; // tolerated: a JSON-speaking host
    const buf = await res.arrayBuffer();
    return Array.from(new Float32Array(buf, 0, Math.floor(buf.byteLength / 4)));
  }

  async vehicle(id: string, index: number): Promise<VehicleDetail> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/vehicle?index=${Math.max(0, Math.floor(index))}`);
  }

  async forecast(id: string, days: number): Promise<ForecastReply> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/forecast`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ days }),
    });
  }

  async economy(id: string, bucketH: number): Promise<EconomyReply> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/economy?bucket_h=${Math.max(1, Math.floor(bucketH))}`);
  }

  async sourcing(id: string): Promise<SourcingList> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/sourcing`);
  }

  async sourcingTank(id: string, site: string, material: string): Promise<SourcingDetail> {
    return this.json(
      `/api/sim/${encodeURIComponent(id)}/sourcing?site=${encodeURIComponent(site)}&material=${encodeURIComponent(material)}`,
    );
  }

  async rewind(id: string, tick: number): Promise<{ tick: number }> {
    const reply = await this.json<{ ok?: boolean; tick?: number }>(
      `/api/sim/${encodeURIComponent(id)}/rewind`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ tick }) },
    );
    return { tick: typeof reply.tick === 'number' ? reply.tick : tick };
  }

  /**
   * DELETE /api/sim/{id} — release the session server-side now. Best-effort
   * by design: it fires on replacement and at page unload, where the session
   * is being abandoned either way. keepalive:true lets the DELETE survive
   * page teardown (sendBeacon cannot send DELETE); a 404 just means the
   * session was already released, expired or evicted — nothing to surface.
   */
  async release(id: string): Promise<void> {
    this.siteKeys.delete(id);
    try {
      await this.send(`/api/sim/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        keepalive: true,
      });
    } catch {
      // Already gone, or the page is going away and the network failed —
      // the server's idle expiry and LRU eviction bound the leak either way.
    }
  }
}
