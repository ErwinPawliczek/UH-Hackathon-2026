// HTTP client for the §7.4 crx-server routes. One origin, no CORS; fetch with
// binary snapshot handling (the step reply is the §7.3 snapshot, decoded into
// typed-array views with no copy). Inject the fetch implementation for tests.

import { decode, type Snapshot } from './snapshot';
import type { WorldSpec } from './world';
import type { SimBackend, SimConfig, SimEvent } from './api';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** Non-2xx reply. Status is typed so callers can branch — e.g. a 404/410 means
 * the session id is gone server-side (idle expiry or LRU eviction) and the
 * client recreates instead of erroring. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HttpBackend implements SimBackend {
  readonly kind = 'http' as const;

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
      );
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.send(path, init);
    return (await res.json()) as T;
  }

  async create(config: SimConfig): Promise<{ id: string }> {
    // The engine's create contract is {seed, adaptation?} (§7.1); the UI's
    // scenario list is a stub-era demo feature until the demo maps scenarios
    // onto queued engine events (M4+). Passing scenario through gets the
    // config rejected — the engine refuses unknown keys on purpose.
    return this.json('/api/sim', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ seed: config.seed }),
    });
  }

  async world(id: string): Promise<WorldSpec> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/world`);
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
    return this.json(`/api/sim/${encodeURIComponent(id)}/events?since=${since}`);
  }

  async kpis(id: string): Promise<number[]> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/kpis`);
  }

  async series(id: string, kind: number, refId: number): Promise<number[]> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/series?kind=${kind}&id=${refId}`);
  }

  /**
   * DELETE /api/sim/{id} — release the session server-side now. Best-effort
   * by design: it fires on replacement and at page unload, where the session
   * is being abandoned either way. keepalive:true lets the DELETE survive
   * page teardown (sendBeacon cannot send DELETE); a 404 just means the
   * session was already released, expired or evicted — nothing to surface.
   */
  async release(id: string): Promise<void> {
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
