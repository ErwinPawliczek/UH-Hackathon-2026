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
import { scenarioSite, type EngineScenario } from '../engine/scenarios';
import { DEFAULT_WORLD, STORAGE_KEY, dropLegacyPersistedState, backendOverride, worldFromParams } from './bootstrap';

export type Selection = { kind: 'site' | 'vehicle'; index: number } | null;

/**
 * Ticks advanced per step (every 250 ms while playing). One tick is 15
 * simulated minutes, so 1× runs one simulated hour per real second, 4× four
 * hours, 16× sixteen hours and 64× 2⅔ days.
 */
export const SPEEDS = [1, 4, 16, 64] as const;
/** The speed a visitor starts at: slow enough to follow one truck. */
export const DEFAULT_SPEED = 1;
/** Persisted-settings schema version; bump when a saved value must be reset. */
const SETTINGS_VERSION = 1;
export const TICKS_PER_DAY = 96;

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
  /**
   * False until the visitor starts the run: every session opens paused at
   * day 0 behind a "Start simulation" button. True from the first start on,
   * when the same control becomes Pause / Resume.
   */
  started: boolean;
  playing: boolean;
  world: WorldSpec | null;
  snap: Snapshot | null;
  prevSnap: Snapshot | null;
  /** performance.now() of the last snapshot, for frame interpolation */
  snapAt: number;
  /**
   * Changes whenever the run's timeline is replaced rather than advanced: a
   * new session, or going back in time. Anything that buffers state across
   * snapshots (frame interpolation, trails, cached series) must drop it when
   * this number changes.
   */
  runEpoch: number;
  events: SimEvent[];
  lastSeq: number;
  selected: Selection;
  error: string | null;
  /** Live backend command dispatcher, wired by useSimEngine; null between sessions. */
  sendCommand: ((cmd: Record<string, unknown>) => Promise<unknown>) | null;
  /** Keys of the engine scenarios already triggered in this session (each runs once). */
  triggered: string[];
  /** Tick the run was at when each scenario was triggered — going back to that tick or earlier undoes it. */
  triggeredAt: Record<string, number>;
  /**
   * Take the live session back to `tick` and reload everything derived from
   * the run; wired by the engine session, null between sessions. Rejects
   * with the server's reason when the session cannot go back there.
   */
  rewindTo: ((tick: number) => Promise<void>) | null;

  setSeed: (seed: number) => void;
  setScenario: (scenario: string) => void;
  setSpeed: (speed: number) => void;
  togglePlay: () => void;
  select: (sel: Selection) => void;
  setWorld: (world: WorldSpec) => void;
  pushSnapshot: (snap: Snapshot) => void;
  addEvents: (events: SimEvent[]) => void;
  setError: (error: string | null) => void;
  /**
   * Send an engine scenario's command to the live session. On success it is
   * marked triggered and noted on the timeline; a rejection surfaces as the
   * error banner and leaves the scenario available.
   */
  triggerScenario: (scenario: EngineScenario) => Promise<void>;
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
    (set, get) => ({
      seed: 42,
      scenario: 'none',
      speed: DEFAULT_SPEED,

      backendKind: 'http',
      worldName: DEFAULT_WORLD,
      started: false,
      playing: false,
      world: null,
      snap: null,
      prevSnap: null,
      snapAt: 0,
      runEpoch: 0,
      events: [],
      lastSeq: -1,
      selected: null,
      error: null,
      sendCommand: null,
      triggered: [],
      triggeredAt: {},
      rewindTo: null,
      retryNonce: 0,

      setSeed: (seed) => set({ seed: Math.max(0, Math.floor(seed)) }),
      setScenario: (scenario) => set({ scenario }),
      setSpeed: (speed) => set({ speed }),
      togglePlay: () => set((s) => ({ playing: !s.playing, started: true })),
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
      triggerScenario: async (scenario) => {
        const { sendCommand, triggered } = get();
        if (sendCommand === null || triggered.includes(scenario.key)) return;
        let reply: unknown;
        try {
          reply = await sendCommand(scenario.command);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const r = (typeof reply === 'object' && reply !== null ? reply : {}) as Record<string, unknown>;
        if (r.ok === false) {
          set({ error: `Scenario rejected: ${typeof r.error === 'string' ? r.error : 'unknown reason'}` });
          return;
        }
        // Note it on the timeline at the current tick. Local entries take
        // negative seqs so they never collide with the engine's log, and
        // lastSeq (the engine cursor) is left alone.
        // (The session serialises commands with steps, so the snapshot in the
        // store is the tick the engine was at when it took the command.)
        set((s) => ({
          triggered: [...s.triggered, scenario.key],
          triggeredAt: { ...s.triggeredAt, [scenario.key]: Number(s.snap?.tick ?? 0) },
          events: [
            ...s.events,
            {
              seq: -1 - s.triggered.length,
              tick: Number(s.snap?.tick ?? 0),
              type: 'scenario',
              site: s.world === null ? undefined : scenarioSite(s.world, scenario),
              text: scenario.label,
            },
          ],
        }));
      },
      retry: () => set((s) => ({ retryNonce: s.retryNonce + 1 })),
    }),
    {
      name: STORAGE_KEY,
      version: SETTINGS_VERSION,
      // Version 0 was saved when 16× was the default; a visitor who never
      // chose a speed must land on the new 1× default, so the saved speed is
      // dropped once and everything else is kept.
      migrate: (persisted, version) => {
        const saved = (typeof persisted === 'object' && persisted !== null ? persisted : {}) as Record<string, unknown>;
        return version < 1 ? { ...saved, speed: DEFAULT_SPEED } : saved;
      },
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
