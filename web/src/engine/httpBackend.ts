// HTTP client for the §7.4 crx-server routes. One origin, no CORS; fetch with
// binary snapshot handling (the step reply is the §7.3 snapshot, decoded into
// typed-array views with no copy). Inject the fetch implementation for tests.

import { decode, type Snapshot } from './snapshot';
import type { WorldSpec } from './world';
import type { SimBackend, SimConfig, SimEvent } from './api';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export class HttpBackend implements SimBackend {
  readonly kind = 'http' as const;

  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.base + path, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  }

  async create(config: SimConfig): Promise<{ id: string }> {
    return this.json('/api/sim', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(config) });
  }

  async world(id: string): Promise<WorldSpec> {
    return this.json(`/api/sim/${encodeURIComponent(id)}/world`);
  }

  async step(id: string, ticks: number): Promise<Snapshot> {
    const path = `/api/sim/${encodeURIComponent(id)}/step`;
    const res = await this.fetchImpl(this.base + path, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ticks }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`POST ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
    }
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
}
