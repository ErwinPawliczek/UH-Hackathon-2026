// The sim engine session and step loop, framework-free so the session
// lifecycle is unit-testable without a DOM: openEngineSession creates a
// backend session for the current settings and pushes the first snapshot;
// startStepLoop advances it on a fixed 250 ms cadence while playing and pulls
// incremental events after each step. useSimEngine mounts these on effects.
// A failed session surfaces the store's error state — the UI shows the
// retryable engine-unavailable overlay; it never falls back to another
// backend kind.

import { createBackend } from '../engine/api';
import type { BackendKind, SimBackend } from '../engine/api';
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

/**
 * Open a backend session for the given settings: create it, resolve the
 * world, push the first snapshot. Returns a cleanup that cancels a
 * still-opening session; the step loop keeps its own lifetime.
 */
export function openEngineSession(
  { kind, seed, scenario }: SessionOptions,
  backend: SimBackend = createBackend(kind),
): () => void {
  let cancelled = false;
  session = null;
  useSim.getState().setError(null);
  void (async () => {
    try {
      const { id } = await backend.create({ seed, scenario });
      if (cancelled) return;
      // The M0 stub engine's /world reply is too sparse to render (§7.3 world
      // lands in M1); reconcile it with the client's deterministic stub world.
      const world = resolveWorld(await backend.world(id), seed);
      if (cancelled) return;
      session = { id, backend };
      // Expose the session's command channel to the UI (fail-this-unit
      // controls); cleared again on session teardown below.
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
      if (cancelled) return;
      useSim.getState().pushSnapshot(snap);
    } catch (err) {
      if (!cancelled) useSim.getState().setError(err instanceof Error ? err.message : String(err));
    }
  })();
  return () => {
    cancelled = true;
    session = null;
    useSim.setState({ sendCommand: null });
  };
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
        useSim.getState().setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    })();
  }, STEP_MS);
  return () => clearInterval(timer);
}
