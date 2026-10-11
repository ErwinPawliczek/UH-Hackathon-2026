import { describe, expect, it } from 'vitest';
import { HttpBackend, HttpError, resolveEventSites, siteKeyIndex } from './httpBackend';
import { StubBackend } from './stubBackend';
import { createBackend, type SimBackend } from './api';
import { encodeStub } from './stub';
import { decode } from './snapshot';
import { MATERIALS } from './world';

/** Records calls and replies from a scripted route table (matched on pathname, ignoring the query). */
function fakeFetch(routes: Record<string, (url: string, body: string) => unknown>) {
  const calls: { url: string; method: string; body: string }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });
    for (const [pattern, handler] of Object.entries(routes)) {
      const [methodPattern, pathPattern] = pattern.split(' ');
      if (methodPattern !== method) continue;
      const match = pathPattern.startsWith('re:')
        ? new RegExp(pathPattern.slice(3)).test(path)
        : path.endsWith(pathPattern);
      if (match) {
        const payload = handler(url, body);
        return new Response(
          payload instanceof ArrayBuffer ? payload : JSON.stringify(payload),
          { status: 200, headers: { 'Content-Type': payload instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json' } },
        );
      }
    }
    return new Response(`no route for ${url}`, { status: 404 });
  };
  return { calls, impl };
}

describe('HttpBackend request mapping', () => {
  it('creates a session via POST /api/sim and parses the id', async () => {
    const { calls, impl } = fakeFetch({ 'POST /api/sim': () => ({ id: 'sim-7' }) });
    const b = new HttpBackend('http://x', impl);
    const { id } = await b.create({ seed: 42, scenario: 'compressor_trip' });
    expect(id).toBe('sim-7');
    expect(calls[0].url).toBe('http://x/api/sim');
    // The hosted engine's create contract is {seed, adaptation?}: the UI's
    // scenario concept stops at the stub boundary and must not reach the wire.
    expect(JSON.parse(calls[0].body)).toEqual({ seed: 42 });
  });

  it('asks for a named world and leaves the key out for the built-in one', async () => {
    const { calls, impl } = fakeFetch({ 'POST /api/sim': () => ({ id: 'sim-8' }) });
    const b = new HttpBackend('http://x', impl);
    await b.create({ seed: 42, scenario: 'none', world: 'erwin-world-v1' });
    await b.create({ seed: 42, scenario: 'none', world: 'sixsite' });
    expect(JSON.parse(calls[0].body)).toEqual({ seed: 42, world: 'erwin-world-v1' });
    expect(JSON.parse(calls[1].body)).toEqual({ seed: 42 });
  });

  it('falls back to the built-in world when the server rejects the named one', async () => {
    const bodies: unknown[] = [];
    const impl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return 'world' in body
        ? new Response('{"error":"engine rejected the config JSON"}', { status: 400 })
        : new Response(JSON.stringify({ id: 'sim-9' }), { status: 200 });
    };
    const b = new HttpBackend('http://x', impl);
    const { id } = await b.create({ seed: 7, scenario: 'none', world: 'erwin-world-v1' });
    expect(id).toBe('sim-9');
    expect(bodies).toEqual([{ seed: 7, world: 'erwin-world-v1' }, { seed: 7 }]);
  });

  it("sends a drawn layout with its world, and passes a refusal on with the server's reason instead of falling back", async () => {
    const layout = { version: 2, sites: [] };
    const ok = fakeFetch({ 'POST /api/sim': () => ({ id: 'sim-9' }) });
    await new HttpBackend('http://x', ok.impl).create({ seed: 42, scenario: 'none', world: 'erwin-world-v1', layout });
    expect(JSON.parse(ok.calls[0].body)).toEqual({ seed: 42, world: 'erwin-world-v1', layout });

    const calls: string[] = [];
    const refuse: typeof fetch = async (_input, init) => {
      calls.push(String(init?.body));
      return new Response(JSON.stringify({ error: 'Refinery needs a river lane within 12 km' }), { status: 400 });
    };
    const b = new HttpBackend('http://x', refuse);
    const err = await b.create({ seed: 42, scenario: 'none', world: 'erwin-world-v1', layout }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).reason).toBe('Refinery needs a river lane within 12 km');
    expect(calls).toHaveLength(2); // the create, then the checker asked why: no second create on the built-in world
    expect(calls.filter((c) => c.includes('"seed"'))).toHaveLength(1);
  });

  it("asks the checker why a layout was refused and carries its sentences as the reason", async () => {
    const seen: string[] = [];
    const impl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      seen.push(`${init?.method} ${path}`);
      if (path === '/api/worlds/check') {
        return new Response(JSON.stringify({ ok: false, errors: [{ site: 6, mode: 'river', text: 'Refinery needs a river lane within 12 km' }, { site: null, mode: null, text: 'Two sites share a spot' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'engine rejected the config JSON' }), { status: 400 });
    };
    const err = await new HttpBackend('http://x', impl).create({ seed: 42, scenario: 'none', world: 'erwin-world-v1', layout: { version: 2 } }).catch((e: unknown) => e);
    expect((err as HttpError).reason).toBe('Refinery needs a river lane within 12 km\nTwo sites share a spot');
    expect(seen).toEqual(['POST /api/sim', 'POST /api/worlds/check']);
  });

  it('does not retry a named-world create on errors other than a 400', async () => {
    let n = 0;
    const impl: typeof fetch = async () => {
      n += 1;
      return new Response('busy', { status: 503 });
    };
    const b = new HttpBackend('http://x', impl);
    await expect(b.create({ seed: 7, scenario: 'none', world: 'erwin-world-v1' })).rejects.toThrow(/503/);
    expect(n).toBe(1);
  });

  it('steps by posting {"ticks":N} and decodes the binary snapshot reply', async () => {
    const snapshotBytes = encodeStub(9, 480);
    const { calls, impl } = fakeFetch({ 'POST /api/sim/sim-7/step': () => snapshotBytes });
    const b = new HttpBackend('http://x', impl);
    const snap = await b.step('sim-7', 96);
    expect(calls[0].url).toBe('http://x/api/sim/sim-7/step');
    expect(JSON.parse(calls[0].body)).toEqual({ ticks: 96 });
    const expected = decode(snapshotBytes);
    expect(snap.tick).toBe(expected.tick);
    expect(snap.nSites).toBe(expected.nSites);
    expect(Array.from(snap.tanks)).toEqual(Array.from(expected.tanks));
  });

  it('sends commands as §7.2 JSON and returns the engine reply', async () => {
    const reply = { ok: true, applied: 1 };
    const { calls, impl } = fakeFetch({ 'POST /api/sim/sim-7/command': () => reply });
    const b = new HttpBackend('http://x', impl);
    const out = await b.command('sim-7', { cmd: 'event', type: 'unit_outage', site: 12 });
    expect(out).toEqual(reply);
    expect(JSON.parse(calls[0].body)).toEqual({ cmd: 'event', type: 'unit_outage', site: 12 });
  });

  it('forks a session', async () => {
    const { calls, impl } = fakeFetch({ 'POST /api/sim/sim-7/fork': () => ({ id: 'twin-1' }) });
    const b = new HttpBackend('http://x', impl);
    const { id } = await b.fork('sim-7');
    expect(id).toBe('twin-1');
    expect(calls[0].url).toBe('http://x/api/sim/sim-7/fork');
  });

  it('fetches the world once per session', async () => {
    const { calls, impl } = fakeFetch({ 'GET /api/sim/sim-7/world': () => ({ seed: 42, wKm: 600 }) });
    const b = new HttpBackend('http://x', impl);
    const world = (await b.world('sim-7')) as unknown as Record<string, number>;
    expect(world.wKm).toBe(600);
    expect(calls[0].url).toBe('http://x/api/sim/sim-7/world');
  });

  it('queries events with the since parameter', async () => {
    const { calls, impl } = fakeFetch({ 'GET /api/sim/sim-7/events': () => [{ seq: 3, tick: 96, type: 'stockout' }] });
    const b = new HttpBackend('http://x', impl);
    const events = await b.events('sim-7', 2);
    expect(events).toHaveLength(1);
    expect(calls[0].url).toBe('http://x/api/sim/sim-7/events?since=2');
  });

  it("turns an event's site key into the site's index, using the session's world", async () => {
    const world = { sites: [{ key: 'OIL_FIELD' }, { key: 'CRACKER_ETHANE' }, { key: 'FUEL_DEPOT' }] };
    const { calls, impl } = fakeFetch({
      'GET /api/sim/sim-7/world': () => world,
      'GET /api/sim/sim-7/events': () => [
        { seq: 0, tick: 96, type: 'unit_failed', site: 'CRACKER_ETHANE', text: 'a' },
        { seq: 1, tick: 97, type: 'route_break', text: 'b' },
        { seq: 2, tick: 98, type: 'stockout', site: 'NOWHERE', text: 'c' },
        { seq: 3, tick: 99, type: 'stockout', site: 2, text: 'd' },
      ],
    });
    const b = new HttpBackend('http://x', impl);
    await b.world('sim-7');
    const events = await b.events('sim-7', 0);
    expect(events.map((e) => e.site)).toEqual([1, undefined, undefined, 2]);
    expect('site' in events[2]).toBe(false); // an unknown key is no site, never the wrong site
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/sim/sim-7/world', '/api/sim/sim-7/events']);

    // a session whose world was never asked for: fetched once, when a key first needs resolving
    const fresh = fakeFetch({
      'GET /api/sim/sim-9/world': () => world,
      'GET /api/sim/sim-9/events': () => [{ seq: 0, tick: 4, type: 'stockout', site: 'FUEL_DEPOT', text: 'e' }],
    });
    const c = new HttpBackend('http://x', fresh.impl);
    expect((await c.events('sim-9', 0))[0].site).toBe(2);
    expect((await c.events('sim-9', 0))[0].site).toBe(2);
    expect(fresh.calls.filter((x) => x.url.endsWith('/world'))).toHaveLength(1);
  });

  it("maps site keys on their own: by key, leaving indices and site-less events alone", () => {
    const keys = siteKeyIndex({ sites: [{ key: 'A' }, { name: 'no key' }, { key: 'C' }] } as never);
    expect([...keys]).toEqual([['A', 0], ['C', 2]]);
    expect(siteKeyIndex(undefined).size).toBe(0);
    expect(resolveEventSites([
      { seq: 0, tick: 1, type: 't', text: '', site: 'C' },
      { seq: 1, tick: 1, type: 't', text: '', site: 0 },
      { seq: 2, tick: 1, type: 't', text: '' },
    ], keys).map((e) => e.site)).toEqual([2, 0, undefined]);
  });

  it('floors the events since sentinel at the wire minimum', async () => {
    // The store's -1 ("nothing fetched yet") is not representable in §7.4,
    // where since is unsigned — the server answers 400 to since=-1.
    const { calls, impl } = fakeFetch({ 'GET /api/sim/sim-7/events': () => [] });
    const b = new HttpBackend('http://x', impl);
    await b.events('sim-7', -1);
    expect(calls[0].url).toBe('http://x/api/sim/sim-7/events?since=0');
  });

  it('queries kpis and series with kind and id parameters', async () => {
    const { calls, impl } = fakeFetch({
      'GET /api/sim/sim-7/kpis': () => [0.98, 1200],
      'GET /api/sim/sim-7/series': () => [1, 2, 3],
    });
    const b = new HttpBackend('http://x', impl);
    expect(await b.kpis('sim-7')).toEqual([0.98, 1200]);
    expect(await b.series('sim-7', 2, 31)).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe('http://x/api/sim/sim-7/kpis');
    expect(calls[1].url).toBe('http://x/api/sim/sim-7/series?kind=2&id=31');
  });

  it('rewinds by posting {"tick":N} and returns the tick the server went back to', async () => {
    const { calls, impl } = fakeFetch({ 'POST /api/sim/sim-7/rewind': () => ({ ok: true, tick: 288 }) });
    const b = new HttpBackend('http://x', impl);
    expect(await b.rewind('sim-7', 288)).toEqual({ tick: 288 });
    expect(calls[0].url).toBe('http://x/api/sim/sim-7/rewind');
    expect(JSON.parse(calls[0].body)).toEqual({ tick: 288 });
  });

  it('carries the server\'s reason when a rewind is refused', async () => {
    const impl: typeof fetch = async () =>
      new Response('{"error":"tick is ahead of the run"}', { status: 400 });
    const b = new HttpBackend('http://x', impl);
    const err = await b.rewind('sim-7', 9999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).reason).toBe('tick is ahead of the run');
  });

  it('reads the hourly series as the raw float32 array the engine sends', async () => {
    const impl: typeof fetch = async () =>
      new Response(new Float32Array([1, 0.5, 0.25]).buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    const b = new HttpBackend('http://x', impl);
    expect(await b.series('sim-7', 1, 5)).toEqual([1, 0.5, 0.25]);
    // nothing recorded yet: an empty body is an empty series
    const empty: typeof fetch = async () =>
      new Response(new ArrayBuffer(0), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    expect(await new HttpBackend('http://x', empty).series('sim-7', 0, 9)).toEqual([]);
  });

  it('throws with the status on a failed request', async () => {
    const impl: typeof fetch = async () => new Response('gone', { status: 410 });
    const b = new HttpBackend('http://x', impl);
    await expect(b.create({ seed: 1, scenario: 'none' })).rejects.toThrow(/410/);
  });

  it('releases a session with a keepalive DELETE', async () => {
    const calls: { url: string; method: string; init: RequestInit | undefined }[] = [];
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', init });
      return new Response(JSON.stringify({ released: true }), { status: 200 });
    };
    const b = new HttpBackend('http://x', impl);
    await b.release('sim-7');
    expect(calls[0].url).toBe('http://x/api/sim/sim-7');
    expect(calls[0].method).toBe('DELETE');
    // sendBeacon cannot send DELETE; keepalive lets the fetch survive page teardown.
    expect(calls[0].init?.keepalive).toBe(true);
  });

  it('release swallows a 404 (already released, expired or evicted)', async () => {
    const impl: typeof fetch = async () => new Response('unknown session', { status: 404 });
    const b = new HttpBackend('http://x', impl);
    await expect(b.release('sim-7')).resolves.toBeUndefined();
  });

  it('release swallows network failures (page is going away)', async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const b = new HttpBackend('http://x', impl);
    await expect(b.release('sim-7')).resolves.toBeUndefined();
  });
});

describe('StubBackend', () => {
  const b: SimBackend = new StubBackend();

  it('advances the tick across steps and decodes snapshots', async () => {
    const { id } = await b.create({ seed: 42, scenario: 'none' });
    const s1 = await b.step(id, 96);
    expect(s1.tick).toBe(96n);
    const s2 = await b.step(id, 24);
    expect(s2.tick).toBe(120n);
  });

  it('serves a world consistent with the snapshot entity counts', async () => {
    const { id } = await b.create({ seed: 7, scenario: 'none' });
    const world = await b.world(id);
    const snap = await b.step(id, 0);
    expect(world.sites.length).toBe(snap.nSites);
    expect(world.tanks.length).toBe(snap.nTanks);
    expect(world.vehicles.length).toBe(snap.nVeh);
    expect(world.pipelines.length).toBe(snap.nPipes);
    expect(world.routes.length).toBe(snap.nEdges);
    expect(MATERIALS.length).toBe(snap.nMats);
  });

  it('serves incremental events and honours since', async () => {
    const { id } = await b.create({ seed: 7, scenario: 'compressor_trip' });
    await b.step(id, 96 * 10); // ten days: scripted + ambient events
    const all = await b.events(id, -1);
    expect(all.length).toBeGreaterThan(4);
    expect(all[0].seq).toBe(0);
    expect(all.map((e) => e.seq)).toEqual([...Array(all.length).keys()]);
    const later = await b.events(id, 3);
    expect(later.every((e) => e.seq > 3)).toBe(true);
    expect(all.map((e) => e.tick)).toEqual([...all.map((e) => e.tick)].sort((a, z) => a - z));
    const scripted = all.filter((e) => e.type === 'unit_failed');
    expect(scripted.length).toBeGreaterThanOrEqual(1);
    expect(scripted.some((e) => e.unit === 'SC-CGC')).toBe(true);
  });

  it('forks a session that continues from the parent tick', async () => {
    const { id } = await b.create({ seed: 7, scenario: 'none' });
    await b.step(id, 96);
    const { id: twinId } = await b.fork(id);
    const twin = await b.step(twinId, 96);
    expect(twin.tick).toBe(192n);
    const parent = await b.step(id, 0);
    expect(parent.tick).toBe(96n);
  });

  it('goes back in time: the tick resets and later outages are forgotten', async () => {
    const { id } = await b.create({ seed: 7, scenario: 'none' });
    await b.step(id, 100);
    const world = await b.world(id);
    const unit = world.sites[0].processes[0].units[0].key;
    await b.command(id, { type: 'unit_outage', site: 0, unit, trains: 1, duration_h: 48 });
    await b.step(id, 100);
    expect((await b.events(id, -1)).some((e) => e.type === 'unit_failed' && e.tick === 100)).toBe(true);

    expect(await b.rewind(id, 100)).toEqual({ tick: 100 }); // the outage was commanded AT 100: forgotten
    expect((await b.step(id, 0)).tick).toBe(100n);
    await b.step(id, 50);
    expect((await b.events(id, -1)).some((e) => e.type === 'unit_failed' && e.tick === 100)).toBe(false);

    await expect(b.rewind(id, 9999)).rejects.toThrow(/ahead of the run/);
  });

  it('echoes commands and throws on unknown sessions', async () => {
    const { id } = await b.create({ seed: 7, scenario: 'none' });
    await expect(b.command(id, { cmd: 'set', key: 'adaptive', value: false })).resolves.toEqual({
      ok: true,
      echo: { cmd: 'set', key: 'adaptive', value: false },
    });
    await expect(b.step('stub:1:none', 1)).rejects.toThrow(/no such stub session/);
  });
});

describe('createBackend', () => {
  it('builds the right backend kind', () => {
    expect(createBackend('stub').kind).toBe('stub');
    expect(createBackend('http').kind).toBe('http');
  });
});
