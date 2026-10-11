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
import type { SimConfig, SimEvent } from '../engine/api';

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

  it('a gone session (404) mid-use recreates silently and retries the step once', async () => {
    const backend = fakeBackend();
    let created = 0;
    backend.create.mockImplementation(async () => ({ id: `sim-${++created}` }));
    backend.step.mockImplementation(async (id: string, ticks: number) => {
      // Opening a session steps tick 0 and must succeed; only a live step on
      // the first session discovers it is gone server-side.
      if (id === 'sim-1' && ticks > 0) throw new HttpError(404, 'POST /api/sim/sim-1/step -> 404: unknown session');
      return decode(encodeStub(42, ticks));
    });
    useSim.setState({ playing: true, speed: 16, error: null });

    const cleanupOpen = openEngineSession({ kind: 'http', seed: 42, scenario: 'none' }, backend);
    await vi.waitFor(() => expect(engineSession()?.id).toBe('sim-1'));

    const stopLoop = startStepLoop();
    await vi.waitFor(() => {
      // the loop stepped the dead session and recovery replaced it
      expect(engineSession()?.id).toBe('sim-2');
    });
    await flush();

    expect(backend.create).toHaveBeenCalledTimes(2);
    // the failed request was retried once on the fresh session
    expect(backend.step).toHaveBeenCalledWith('sim-2', 16);
    expect(useSim.getState().error).toBeNull(); // silent: no error surfaced
    expect(useSim.getState().snap).not.toBeNull();

    stopLoop();
    cleanupOpen();
  });

  it('isGoneSession matches only the gone-id statuses', () => {
    expect(isGoneSession(new HttpError(404, 'gone'))).toBe(true);
    expect(isGoneSession(new HttpError(410, 'gone'))).toBe(true);
    expect(isGoneSession(new HttpError(500, 'boom'))).toBe(false);
    expect(isGoneSession(new Error('plain'))).toBe(false);
    expect(isGoneSession(null)).toBe(false);
  });
});
