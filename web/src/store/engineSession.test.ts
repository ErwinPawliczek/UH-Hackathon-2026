// Session lifecycle (framework-free): the store releases the server-side
// session it replaces, on effect teardown, and on pagehide; a session id
// that dies mid-use (404/410 — idle expiry or LRU eviction server-side) is
// recreated silently with the failed step retried once.

import { describe, expect, it, vi } from 'vitest';
import {
  engineSession,
  installUnloadRelease,
  isGoneSession,
  openEngineSession,
  startStepLoop,
} from './engineSession';
import { HttpBackend, HttpError } from '../engine/httpBackend';
import { decode } from '../engine/snapshot';
import { encodeStub } from '../engine/stub';
import { stubWorld } from '../engine/world';
import { useSim } from './sim';
import type { SimConfig, SimEvent, VehicleDetail } from '../engine/api';

/** A SimBackend whose every method is a mock; ids increment per create. */
function fakeBackend() {
  let created = 0;
  return {
    kind: 'http' as const,
    create: vi.fn(async (_config: SimConfig) => ({ id: `sim-${++created}` })),
    world: vi.fn(async () => stubWorld(42)),
    step: vi.fn(async (_id: string, ticks: number) => decode(encodeStub(42, ticks))),
    command: vi.fn(async () => ({})),
    fork: vi.fn(async () => ({ id: 'fork-1' })),
    events: vi.fn(async () => [] as SimEvent[]),
    kpis: vi.fn(async () => [] as number[]),
    series: vi.fn(async () => [] as number[]),
    rewind: vi.fn(async (_id: string, tick: number) => ({ tick })),
    vehicle: vi.fn(async (_id: string, index: number) => ({
      index, cls: 'TRUCK_BULK', capacityT: 25, status: 'idle', cargo: null, order: null,
      at: { site: 0 }, legDestination: null, path: [], remainingKm: 0, tripKm: 0,
    }) as VehicleDetail),
    release: vi.fn(async (_id: string) => undefined),
  };
}

/** An HttpBackend over a scripted fetch, so keepalive DELETEs are observable. */
function mockHttpFetch() {
  const calls: { url: string; method: string; init: RequestInit | undefined }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, init });
    if (method === 'POST' && new URL(url).pathname === '/api/sim')
      return new Response(JSON.stringify({ id: 'sim-1' }), { status: 200 });
    if (method === 'GET' && url.endsWith('/world'))
      return new Response(JSON.stringify(stubWorld(42)), { status: 200 });
    if (method === 'POST' && url.endsWith('/step'))
      return new Response(encodeStub(42, 0), { status: 200 });
    return new Response(JSON.stringify({ released: true }), { status: 200 });
  };
  return { calls, impl };
}

/** A fetch that fails the way an offline/refused connection fails. */
const unreachableFetch: typeof fetch = async () => {
  throw new TypeError('Failed to fetch');
};

/** A stand-in EventTarget capturing listeners (vitest env is node: no window). */
function captureTarget() {
  const listeners = new Map<string, () => void>();
  return {
    target: {
      addEventListener: (type: string, fn: () => void) => {
        listeners.set(type, fn);
      },
    } as unknown as EventTarget,
    fire: (type: string) => listeners.get(type)?.(),
  };
}

/** Drain pending microtasks (session opens and recoveries are async chains). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; ++i) await Promise.resolve();
}

describe('session lifecycle', () => {
  it('reports an unreachable hosted engine and never falls back to the stub', async () => {
    useSim.setState({ playing: false, backendKind: 'http', error: null });
    const cleanup = openEngineSession(
      { kind: 'http', seed: 42, scenario: 'none' },
      new HttpBackend('http://engine.test', unreachableFetch),
    );
    try {
      await vi.waitFor(() => expect(useSim.getState().error).not.toBeNull());
      expect(useSim.getState().error).toContain('Cannot reach the hosted engine');
      // No silent fallback: the kind is unchanged and no stub world rendered.
      expect(useSim.getState().backendKind).toBe('http');
      expect(useSim.getState().world).toBeNull();
      expect(useSim.getState().sendCommand).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('opens a working stub session when explicitly selected', async () => {
    useSim.setState({ playing: false, backendKind: 'stub', error: null });
    const cleanup = openEngineSession({ kind: 'stub', seed: 42, scenario: 'none' });
    try {
      await vi.waitFor(() => expect(useSim.getState().world).not.toBeNull());
      expect(useSim.getState().error).toBeNull();
      expect(useSim.getState().sendCommand).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('cancels an in-flight session without surfacing its error', async () => {
    useSim.setState({ playing: false, error: null });
    const cleanup = openEngineSession(
      { kind: 'http', seed: 42, scenario: 'none' },
      new HttpBackend('http://engine.test', unreachableFetch),
    );
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useSim.getState().error).toBeNull();
    expect(useSim.getState().sendCommand).toBeNull();
  });

  it('releases the replaced session when a new one opens (retry / settings change)', async () => {
    const backend = fakeBackend();
    const cleanup1 = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(engineSession()?.id).toBe('sim-1'));

    // React runs the old effect's cleanup before the replacement effect body.
    cleanup1();
    const cleanup2 = openEngineSession({ kind: 'http', seed: 7, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(engineSession()?.id).toBe('sim-2'));

    expect(backend.release).toHaveBeenCalledWith('sim-1');
    cleanup2();
    expect(backend.release).toHaveBeenCalledWith('sim-2');
    expect(engineSession()).toBeNull();
  });

  it('releases the created id when the opening session is cancelled mid-flight', async () => {
    const backend = fakeBackend();
    let resolveCreate: (value: { id: string }) => void = () => {};
    backend.create.mockImplementation(
      () => new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; }),
    );

    const cleanup = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    cleanup(); // the effect is replaced while create is still pending
    resolveCreate({ id: 'sim-late' });
    await vi.waitFor(() => expect(backend.release).toHaveBeenCalledWith('sim-late'));
    expect(engineSession()).toBeNull();
  });

  it('pagehide fires the keepalive DELETE for the live session (mocked fetch)', async () => {
    const { calls, impl } = mockHttpFetch();
    const backend = new HttpBackend('http://x', impl);
    const { target, fire } = captureTarget();
    installUnloadRelease(target);

    const cleanup = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(engineSession()?.id).toBe('sim-1'));

    fire('pagehide');
    await flush();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe('http://x/api/sim/sim-1');
    // sendBeacon cannot send DELETE; keepalive survives page teardown.
    expect(deletes[0].init?.keepalive).toBe(true);
    expect(engineSession()).toBeNull();
    cleanup();
  });

  it('paces steps by speed: one tick per 500 ms at 0.5, fractions carried at 1.5, no burst on a change', async () => {
    const backend = fakeBackend();
    const cleanupOpen = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(engineSession()?.id).toBe('sim-1'));
    backend.step.mockClear(); // drop the opening step(0)
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const ticksSent = () => backend.step.mock.calls.map((c) => c[1]);

    useSim.getState().setSpeed(0.5);
    useSim.setState({ playing: true, error: null });
    const stopLoop = startStepLoop();
    await wait(1350);
    // 1350 ms at one step per 500 ms: three steps (at 0, 500, 1000) — never the 5 or 6 of a 250 ms cadence
    expect(ticksSent().length).toBeGreaterThanOrEqual(2);
    expect(ticksSent().length).toBeLessThanOrEqual(3);
    expect(ticksSent().every((ticks) => ticks === 1)).toBe(true);

    // faster mid-run: the shorter interval applies at once, with no catch-up burst
    backend.step.mockClear();
    useSim.getState().setSpeed(1.5);
    await wait(1100);
    const fast = ticksSent();
    expect(fast.length).toBeGreaterThanOrEqual(3);
    expect(fast.length).toBeLessThanOrEqual(5);
    expect(fast.every((ticks) => ticks === 1 || ticks === 2)).toBe(true); // 1.5 = 1, 2, 1, 2 …
    const total = fast.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1.5 * fast.length)).toBeLessThanOrEqual(0.5);

    // pausing stops it dead; resuming does not replay the pause
    useSim.setState({ playing: false });
    await flush();
    backend.step.mockClear();
    await wait(700);
    expect(backend.step).not.toHaveBeenCalled();
    useSim.setState({ playing: true });
    await wait(120);
    expect(ticksSent().length).toBe(1);

    stopLoop();
    cleanupOpen();
    useSim.setState({ playing: false });
    useSim.getState().setSpeed(1);
  });

  it('going back in time reloads the run and forgets what came after', async () => {
    const backend = fakeBackend();
    backend.step.mockImplementation(async (_id: string, _ticks: number) => decode(encodeStub(42, 288)));
    backend.events.mockImplementation(async () => [
      { seq: 0, tick: 40, type: 'process_shutdown', text: 'early' },
      { seq: 1, tick: 250, type: 'unit_repaired', text: 'kept' },
    ] as SimEvent[]);
    const cleanup = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(useSim.getState().rewindTo).not.toBeNull());

    // a run that went on to tick 900 with two scenarios triggered on the way
    useSim.setState({
      playing: true,
      started: true,
      lastSeq: 57,
      triggered: ['early_one', 'late_one'],
      triggeredAt: { early_one: 100, late_one: 288 },
      events: [
        { seq: -1, tick: 100, type: 'scenario', text: 'Early one' },
        { seq: -2, tick: 288, type: 'scenario', text: 'Late one' },
        { seq: 57, tick: 880, type: 'process_shutdown', text: 'from the abandoned future' },
      ],
    });

    const epoch = useSim.getState().runEpoch;
    await useSim.getState().rewindTo!(288);
    expect(useSim.getState().runEpoch).toBe(epoch + 1); // buffered state must be dropped

    expect(backend.rewind).toHaveBeenCalledWith('sim-1', 288);
    const s = useSim.getState();
    expect(s.playing).toBe(false); // waits there, Resume showing
    expect(s.started).toBe(true);
    expect(Number(s.snap?.tick)).toBe(288);
    expect(s.prevSnap).toBeNull(); // nothing to interpolate from
    // triggered before 288 is kept; triggered AT 288 is forgotten by the engine and available again
    expect(s.triggered).toEqual(['early_one']);
    expect(s.triggeredAt).toEqual({ early_one: 100 });
    // the visitor's notes from before that moment are kept, and going back leaves one of its own
    expect(s.events.map((e) => e.text)).toEqual(['early', 'Early one', 'kept', 'You went back to Day 4, 00:00']);
    expect(s.events[s.events.length - 1]).toMatchObject({ type: 'rewind', tick: 288 });
    expect(s.events[s.events.length - 1].seq).toBeLessThan(0);
    expect(s.lastSeq).toBe(1); // the engine's log restarts its numbering
    cleanup();
  });

  it('notes an accepted command in the log as the visitor\'s action, and a refused one not at all', async () => {
    const backend = fakeBackend();
    const cleanup = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(useSim.getState().sendCommand).not.toBeNull());
    const send = useSim.getState().sendCommand!;
    backend.command.mockImplementation(async () => ({ ok: true }));
    await send({ type: 'unit_outage', site: 0, unit: 'RF-CDU', trains: 1, duration_h: 24 });
    let notes = useSim.getState().events.filter((e) => e.seq < 0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'user_outage', site: 0 });
    expect(notes[0].text).toContain('RF-CDU');
    // the caller writes its own note (a scenario): none is added here
    await send({ type: 'unit_outage', site: 0, unit: 'RF-CDU', trains: 1, duration_h: 24 }, { note: false });
    expect(useSim.getState().events.filter((e) => e.seq < 0)).toHaveLength(1);
    // the engine refused: nothing happened, so nothing is noted
    backend.command.mockImplementation(async () => ({ ok: false, error: 'place_order: seller has no stock' }));
    const reply = await send({ type: 'place_order', site: 0, material: 'SALT', seller: 1, cls: 'TRUCK_BULK', tonnes: 25 });
    expect(reply).toMatchObject({ ok: false });
    notes = useSim.getState().events.filter((e) => e.seq < 0);
    expect(notes).toHaveLength(1);
    cleanup();
  });

  it('a refused rewind rejects with the server\'s reason and leaves the run as it was', async () => {
    const backend = fakeBackend();
    backend.rewind.mockImplementation(async () => {
      throw new HttpError(400, 'POST /rewind -> 400', '{"error":"tick is ahead of the run"}');
    });
    const cleanup = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(useSim.getState().rewindTo).not.toBeNull());
    useSim.setState({ triggered: ['x'], triggeredAt: { x: 5 } });
    await expect(useSim.getState().rewindTo!(999)).rejects.toThrow('tick is ahead of the run');
    expect(useSim.getState().triggered).toEqual(['x']);
    cleanup();
  });

  it("a gone session (404) mid-use ends the run and says so, without starting another behind the visitor's back", async () => {
    const backend = fakeBackend();
    let created = 0;
    backend.create.mockImplementation(async () => ({ id: `sim-${++created}` }));
    backend.step.mockImplementation(async (id: string, ticks: number) => {
      if (id === 'sim-1' && ticks > 0) throw new HttpError(404, 'POST /api/sim/sim-1/step -> 404: unknown session');
      return decode(encodeStub(42, ticks));
    });
    useSim.setState({ playing: true, speed: 16, error: null, ended: false });

    const cleanupOpen = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(engineSession()?.id).toBe('sim-1'));

    const stopLoop = startStepLoop();
    await vi.waitFor(() => expect(useSim.getState().ended).toBe(true));
    await flush();

    expect(useSim.getState().playing).toBe(false);
    expect(useSim.getState().error).toBeNull(); // one plain message, not a raw error as well
    expect(engineSession()).toBeNull();
    expect(backend.create).toHaveBeenCalledTimes(1); // nothing recreated silently

    stopLoop();
    cleanupOpen();
    useSim.setState({ ended: false });
  });

  it('isGoneSession matches only the gone-id statuses', () => {
    expect(isGoneSession(new HttpError(404, 'gone'))).toBe(true);
    expect(isGoneSession(new HttpError(410, 'gone'))).toBe(true);
    expect(isGoneSession(new HttpError(500, 'boom'))).toBe(false);
    expect(isGoneSession(new Error('plain'))).toBe(false);
    expect(isGoneSession(null)).toBe(false);
  });
});
