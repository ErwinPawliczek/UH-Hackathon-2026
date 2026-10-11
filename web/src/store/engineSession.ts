// The sim engine session and step loop, framework-free so the session
// lifecycle is unit-testable without a DOM: openEngineSession creates a
// backend session for the current settings and pushes the first snapshot;
// startStepLoop advances it on a fixed 250 ms cadence while playing and pulls
// incremental events after each step. useSimEngine mounts these on effects.
// A failed session surfaces the store's error state — the UI shows the
// retryable engine-unavailable overlay; it never falls back to another
// backend kind.
//
// Sessions are rented, never leaked: every replacement (retry, settings
// change, new world/preset load — all funnel through the same effect deps)
// and every page unload DELETEs the server-side session, and a session id
// that dies mid-use (404/410 after server-side idle expiry or LRU eviction)
// is replaced transparently instead of surfacing an error.

import { createBackend } from '../engine/api';
import type { BackendKind, SimBackend } from '../engine/api';
import { HttpError } from '../engine/httpBackend';
import { resolveWorld } from '../engine/world';
import { useSim } from './sim';

const STEP_MS = 250;

/** The live backend session; null between sessions and while one is opening. */
let session: { id: string; backend: SimBackend } | null = null;

/** Backend + id of the current session, for the step loop and UI commands. */
export function engineSession(): { id: string; backend: SimBackend } | null {
  return session;
}

export interface SessionOptions {
  kind: BackendKind;
  seed: number;
  scenario: string;
}

/** Live session, as owned by openEngineSession / recovery. */
interface LiveSession {
  id: string;
  backend: SimBackend;
}

/** Fire-and-forget DELETE of the current server-side session, if any. */
function releaseCurrent(): void {
  if (session === null) return;
  const { id, backend } = session;
  session = null;
  void backend.release(id).catch(() => {
    // release() is best-effort by design and never throws; this catch only
    // guards teardown paths from an unexpected rejection.
  });
}

/**
 * Create a backend session for the settings, resolve the world and push the
 * first snapshot. Returns null (and releases the id it created) when
 * `stillRunning()` turns false — the caller's effect was replaced mid-open.
 */
async function openSessionFor(
  { seed, scenario }: SessionOptions,
  backend: SimBackend,
  stillRunning: () => boolean = () => true,
): Promise<LiveSession | null> {
  const { id } = await backend.create({ seed, scenario });
  // The M0 stub engine's /world reply is too sparse to render (§7.3 world
  // lands in M1); reconcile it with the client's deterministic stub world.
  const world = resolveWorld(await backend.world(id), seed);
  if (!stillRunning()) {
    void backend.release(id);
    return null;
  }
  // Expose the session's command channel to the UI (fail-this-unit
  // controls); cleared again on session teardown.
  useSim.setState({
    world,
    events: [],
    lastSeq: -1,
    selected: null,
    prevSnap: null,
    snap: null,
    sendCommand: (cmd) => backend.command(id, cmd),
  });
  const snap = await backend.step(id, 0);
  useSim.getState().pushSnapshot(snap);
  return { id, backend };
}

/**
 * Open a backend session for the given settings, releasing the session it
 * replaces first. Returns a cleanup that cancels a still-opening session and
 * releases the session it owned; the step loop keeps its own lifetime.
 */
export function openEngineSession(
  { kind, seed, scenario }: SessionOptions,
  backend: SimBackend = createBackend(kind),
): () => void {
  let cancelled = false;
  releaseCurrent(); // replacement: the previous session's DELETE
  if (backend.kind === 'http') ensureUnloadInstalled();
  useSim.getState().setError(null);
  void (async () => {
    try {
      const live = await openSessionFor({ kind, seed, scenario }, backend, () => !cancelled);
      if (live === null) return; // replaced mid-open; openSessionFor released the id
      session = live;
    } catch (err) {
      if (!cancelled) useSim.getState().setError(err instanceof Error ? err.message : String(err));
    }
  })();
  return () => {
    cancelled = true;
    releaseCurrent();
    useSim.setState({ sendCommand: null });
  };
}

/**
 * Wire the unload release once: when the page goes away (close, navigate,
 * reload), the live session is released with a keepalive DELETE so the
 * server frees it immediately. sendBeacon cannot send DELETE, and
 * visibilitychange would also fire on mere tab switches — killing a live
 * demo session — so pagehide alone covers the unload cases.
 */
export function installUnloadRelease(target: EventTarget): void {
  target.addEventListener('pagehide', () => {
    releaseCurrent();
  });
}

let unloadInstalled = false;
function ensureUnloadInstalled(): void {
  if (unloadInstalled || typeof window === 'undefined') return;
  unloadInstalled = true;
  installUnloadRelease(window);
}

/** True when the error means the session id is gone server-side: expired
 * past the idle TTL or evicted LRU (404), or a resource-gone 410. */
export function isGoneSession(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 410);
}

let recovering = false;

/**
 * Replace a dead session with a fresh one (same settings, fresh id) and
 * retry the failed step once. Silent: the visitor keeps watching — an error
 * is surfaced only when recovery itself fails.
 */
export async function recoverFromGoneSession(ticks: number): Promise<void> {
  const dead = session;
  if (recovering || dead === null) return;
  recovering = true;
  try {
    const s = useSim.getState();
    session = null;
    // The dead id's own DELETE would only 404 — skip it and go straight to a
    // fresh session; openSessionFor restores the world and first snapshot.
    // (A settings change racing this recovery can orphan one session —
    // bounded by the server's 2-minute idle expiry and LRU eviction.)
    const fresh = await openSessionFor(
      { kind: dead.backend.kind, seed: s.seed, scenario: s.scenario },
      dead.backend,
    );
    if (fresh === null) return;
    session = fresh;
    // The failed request, retried once on the fresh session.
    useSim.getState().pushSnapshot(await dead.backend.step(fresh.id, ticks));
  } catch (err) {
    session = null;
    useSim.getState().setError(err instanceof Error ? err.message : String(err));
  } finally {
    recovering = false;
  }
}

/**
 * Fixed-cadence step loop, created once and kept for the app's lifetime:
 * settings changes replace the session, not the loop. Reads playing state at
 * tick time and skips while a step is in flight (HTTP latency). Returns a
 * cleanup that stops the timer.
 */
export function startStepLoop(): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    const s = useSim.getState();
    if (!s.playing || inFlight) return;
    const current = session;
    if (current === null) return;
    inFlight = true;
    void (async () => {
      try {
        const snap = await current.backend.step(current.id, s.speed);
        useSim.getState().pushSnapshot(snap);
        const { lastSeq } = useSim.getState();
        const events = await current.backend.events(current.id, lastSeq);
        useSim.getState().addEvents(events);
        useSim.getState().setError(null);
      } catch (err) {
        if (isGoneSession(err)) {
          void recoverFromGoneSession(s.speed);
        } else {
          useSim.getState().setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight = false;
      }
    })();
  }, STEP_MS);
  return () => clearInterval(timer);
}
