import { describe, expect, it } from 'vitest';
import { HttpBackend } from './httpBackend';
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

  it('throws with the status on a failed request', async () => {
    const impl: typeof fetch = async () => new Response('gone', { status: 410 });
    const b = new HttpBackend('http://x', impl);
    await expect(b.create({ seed: 1, scenario: 'none' })).rejects.toThrow(/410/);
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
