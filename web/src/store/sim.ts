// Client state: zustand store with the sim runtime (world, snapshots, events,
// selection) and the settings the user can change (backend, seed, scenario,
// speed). Settings persist to localStorage via the persist middleware; runtime
// state does not. The engine loop lives in a hook that feeds this store.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Snapshot } from '../engine/snapshot';
import type { SimEvent, BackendKind } from '../engine/api';
import type { WorldSpec } from '../engine/world';

export type Selection = { kind: 'site' | 'vehicle'; index: number } | null;

/** Ticks advanced per step (every 250 ms while playing). */
export const SPEEDS = [4, 16, 64] as const;
export const TICKS_PER_DAY = 96;
/** Simulation horizon in days (§9). */
export const HORIZON_DAYS = 60;

interface SimState {
  // settings — persisted
  backendKind: BackendKind;
  baseUrl: string;
  seed: number;
  scenario: string;
  speed: number;

  // runtime
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

  setBackendKind: (kind: BackendKind) => void;
  setBaseUrl: (url: string) => void;
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

export const useSim = create<SimState>()(
  persist(
    (set) => ({
      backendKind: 'stub',
      baseUrl: '',
      seed: 42,
      scenario: 'none',
      speed: 16,

      playing: true,
      world: null,
      snap: null,
      prevSnap: null,
      snapAt: 0,
      events: [],
      lastSeq: -1,
      selected: null,
      error: null,
      retryNonce: 0,

      setBackendKind: (backendKind) => set({ backendKind }),
      setBaseUrl: (baseUrl) => set({ baseUrl }),
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
      name: 'chain-reaction-v1',
      partialize: (s) => ({
        backendKind: s.backendKind,
        baseUrl: s.baseUrl,
        seed: s.seed,
        scenario: s.scenario,
        speed: s.speed,
      }),
    },
  ),
);

/** Persisted settings keys — changing any of them restarts the session. */
export const SETTING_KEYS = ['backendKind', 'baseUrl', 'seed', 'scenario', 'speed'] as const;
