// Client state: zustand store with the sim runtime (world, snapshots, events,
// selection) and the settings the user can change (seed, scenario, speed).
// Settings persist to localStorage under STORAGE_KEY via the persist
// middleware; runtime state does not. The engine backend is not a setting:
// the hosted (HTTP) engine is the default, and only the ?engine= URL
// parameter — for tests and local development — can pick the in-page stub.
// The engine loop lives in a hook that feeds this store.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Snapshot } from '../engine/snapshot';
import type { SimEvent, BackendKind } from '../engine/api';
import type { WorldSpec } from '../engine/world';
import { DEFAULT_WORLD, STORAGE_KEY, dropLegacyPersistedState, backendOverride, worldFromParams } from './bootstrap';

export type Selection = { kind: 'site' | 'vehicle'; index: number } | null;

/** Ticks advanced per step (every 250 ms while playing). */
export const SPEEDS = [4, 16, 64] as const;
export const TICKS_PER_DAY = 96;
/** Simulation horizon in days (§9). */
export const HORIZON_DAYS = 60;

export interface SimState {
  // settings — persisted (seed, scenario, speed); backendKind is runtime-only:
  // hosted by default, ?engine= at bootstrap, no UI
  seed: number;
  scenario: string;
  speed: number;

  // runtime
  backendKind: BackendKind;
  /** Named world the session asks the engine for; ?world= at bootstrap, no UI. */
  worldName: string;
  playing: boolean;
  world: WorldSpec | null;
  snap: Snapshot | null;
  prevSnap: Snapshot | null;
  /** performance.now() of the last snapshot, for frame interpolation */
  snapAt: number;
  events: SimEvent[];
  lastSeq: number;
  selected: Selection;
  error: string | null;
  /** Live backend command dispatcher, wired by useSimEngine; null between sessions. */
  sendCommand: ((cmd: Record<string, unknown>) => Promise<unknown>) | null;

  setSeed: (seed: number) => void;
  setScenario: (scenario: string) => void;
  setSpeed: (speed: number) => void;
  togglePlay: () => void;
  select: (sel: Selection) => void;
  setWorld: (world: WorldSpec) => void;
  pushSnapshot: (snap: Snapshot) => void;
  addEvents: (events: SimEvent[]) => void;
  setError: (error: string | null) => void;
  /** Bump to force a fresh backend session without changing settings. */
  retry: () => void;
  retryNonce: number;
}

// Discard the abandoned chain-reaction-* namespace BEFORE the persist
// middleware hydrates: a visitor saved there last saw the stub default, and
// that value must not stick now that the hosted engine is the default.
if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
  dropLegacyPersistedState(window.localStorage);
}

export const useSim = create<SimState>()(
  persist(
    (set) => ({
      seed: 42,
      scenario: 'none',
      speed: 16,

      backendKind: 'http',
      worldName: DEFAULT_WORLD,
      playing: true,
      world: null,
      snap: null,
      prevSnap: null,
      snapAt: 0,
      events: [],
      lastSeq: -1,
      selected: null,
      error: null,
      sendCommand: null,
      retryNonce: 0,

      setSeed: (seed) => set({ seed: Math.max(0, Math.floor(seed)) }),
      setScenario: (scenario) => set({ scenario }),
      setSpeed: (speed) => set({ speed }),
      togglePlay: () => set((s) => ({ playing: !s.playing })),
      select: (selected) => set({ selected }),
      setWorld: (world) => set({ world }),
      pushSnapshot: (snap) =>
        set((s) => ({ prevSnap: s.snap, snap, snapAt: performance.now() })),
      addEvents: (events) =>
        set((s) => {
          if (events.length === 0) return s;
          const lastSeq = events[events.length - 1].seq;
          return { events: [...s.events, ...events], lastSeq };
        }),
      setError: (error) => set({ error }),
      retry: () => set((s) => ({ retryNonce: s.retryNonce + 1 })),
    }),
    {
      name: STORAGE_KEY,
      partialize: (s) => ({
        seed: s.seed,
        scenario: s.scenario,
        speed: s.speed,
      }),
    },
  ),
);

// Apply the ?engine= override on top of the hosted default (tests and local
// development select the in-page stub this way; no UI exists for it), and
// the ?world= choice of map.
if (typeof location !== 'undefined') {
  const params = new URLSearchParams(location.search);
  const override = backendOverride(params);
  if (override !== null) useSim.setState({ backendKind: override });
  useSim.setState({ worldName: worldFromParams(params) });
}
