// The sim engine loop as a React hook: owns the backend session for the
// current settings, steps it on a fixed 250 ms cadence while playing, and
// pulls incremental events after each step. Mounted once in App.

import { useEffect, useRef } from 'react';
import { createBackend } from '../engine/api';
import { resolveWorld } from '../engine/world';
import { useSim } from './sim';

const STEP_MS = 250;

export function useSimEngine(): void {
  const backendKind = useSim((s) => s.backendKind);
  const baseUrl = useSim((s) => s.baseUrl);
  const seed = useSim((s) => s.seed);
  const scenario = useSim((s) => s.scenario);
  const retryNonce = useSim((s) => s.retryNonce);
  const playing = useSim((s) => s.playing);
  const speed = useSim((s) => s.speed);

  const session = useRef<{ id: string; backend: ReturnType<typeof createBackend> } | null>(null);

  // session lifecycle: recreate when any session-defining setting changes
  useEffect(() => {
    let cancelled = false;
    const backend = createBackend(backendKind, { baseUrl });
    const st = useSim.getState();
    st.setError(null);
    (async () => {
      try {
        const { id } = await backend.create({ seed, scenario });
        if (cancelled) return;
        // The M0 stub engine's /world reply is too sparse to render (§7.3 world
        // lands in M1); reconcile it with the client's deterministic stub world.
        const world = resolveWorld(await backend.world(id), seed);
        if (cancelled) return;
        session.current = { id, backend };
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
      session.current = null;
      useSim.setState({ sendCommand: null });
    };
  }, [backendKind, baseUrl, seed, scenario, retryNonce]);

  // step loop: fixed cadence, skips while a step is in flight (HTTP latency)
  useEffect(() => {
    if (!playing) return;
    let inFlight = false;
    const timer = setInterval(() => {
      const s = session.current;
      if (s === null || inFlight) return;
      inFlight = true;
      (async () => {
        try {
          const snap = await s.backend.step(s.id, speed);
          useSim.getState().pushSnapshot(snap);
          const { lastSeq } = useSim.getState();
          const events = await s.backend.events(s.id, lastSeq);
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
  }, [playing, speed]);
}
