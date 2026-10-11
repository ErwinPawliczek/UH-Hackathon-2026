// The sim engine loop as a React hook: opens the backend session for the
// current settings and runs the fixed-cadence step loop. Mounted once in App.
// The engine itself lives in engineSession.ts (framework-free, unit-tested).

import { useEffect } from 'react';
import { useSim } from './sim';
import { openEngineSession, startStepLoop } from './engineSession';

/** `enabled` false leaves the private run alone: the app is showing a multiplayer room instead (store/useRoom.ts). */
export function useSimEngine(enabled = true): void {
  const backendKind = useSim((s) => s.backendKind);
  const seed = useSim((s) => s.seed);
  const scenario = useSim((s) => s.scenario);
  const worldName = useSim((s) => s.worldName);
  const retryNonce = useSim((s) => s.retryNonce);

  // session lifecycle: reopen when any session-defining setting changes.
  // Every new run opens paused at day 0 and waits for "Start simulation".
  useEffect(() => {
    if (!enabled) return;
    useSim.setState({ playing: false, started: false, ended: false });
    return openEngineSession({ kind: backendKind, seed, scenario, world: worldName });
  }, [enabled, backendKind, seed, scenario, worldName, retryNonce]);

  // step loop: fixed cadence, created once — playing state is read at tick time
  useEffect(() => startStepLoop(), []);
}
