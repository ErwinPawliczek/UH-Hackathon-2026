// Client state: zustand store with the sim runtime (world, snapshots, events,
// selection) and the settings the user can change (scenario, speed).
// Settings persist to localStorage under STORAGE_KEY via the persist
// middleware; runtime state does not. The engine backend is not a setting:
// the hosted (HTTP) engine is the default, and only the ?engine= URL
// parameter — for tests and local development — can pick the in-page stub.
// The engine loop lives in a hook that feeds this store.

import type { RoomInfo } from './roomTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Snapshot } from '../engine/snapshot';
import type { SimEvent, BackendKind, VehicleDetail } from '../engine/api';
import type { WorldSpec } from '../engine/world';
import { scenarioSite, type EngineScenario, scenarioTicks } from '../engine/scenarios';
import { userSeq } from './userNotes';
import {
  DEFAULT_SEED, DEFAULT_WORLD, STORAGE_KEY, dropLegacyPersistedState, backendOverride, seedFromParams,
  worldFromParams,
} from './bootstrap';

export type Selection = { kind: 'site' | 'vehicle'; index: number } | null;

/**
 * Speed is a number the visitor types: simulated hours per real second.
 * One tick is 15 simulated minutes, so 1 is four ticks a second. At 1 and
 * above the engine is stepped every 250 ms and the ticks per step follow the
 * speed, fractions carried from step to step (1.5 alternates one tick and
 * two). Below 1 a step stays one tick and the interval stretches instead
 * (0.5 is one tick every 500 ms, 0.1 one every 2.5 s).
 */
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 64;
/** Real milliseconds between steps at speed 1 and above. */
export const BASE_STEP_MS = 250;

/**
 * A speed the loop can run: within MIN_SPEED..MAX_SPEED, to one decimal
 * place. Null when the value is not a number at all.
 */
export function clampSpeed(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, value)) * 10) / 10;
}

/** Real milliseconds from one step to the next at this speed: 250, stretched below 1. */
export function stepIntervalFor(speed: number): number {
  return speed > 0 && speed < 1 ? Math.round(BASE_STEP_MS / speed) : BASE_STEP_MS;
}

/**
 * Ticks the next step advances, and the fraction to carry into the step
 * after it. Below 1 every step is exactly one tick (the interval does the
 * slowing). From 1 up the speed is added to the carry and the whole part is
 * taken, so over many steps the average is the speed itself, a step is never
 * empty, and no step ever takes more than one tick above the speed.
 */
export function nextStep(speed: number, carry: number): { ticks: number; carry: number } {
  if (speed < 1) return { ticks: 1, carry: 0 };
  const total = Math.min(1, Math.max(0, carry)) + speed;
  const ticks = Math.floor(total + 1e-9);
  return { ticks, carry: Math.max(0, total - ticks) };
}

/** The speed a visitor starts at: one simulated hour per second. */
export const DEFAULT_SPEED = 1;
/** Persisted-settings schema version; bump when a saved value must be reset. */
const SETTINGS_VERSION = 1;
export const TICKS_PER_DAY = 96;

export interface SimState {
  // settings — persisted (scenario, speed); the seed is fixed (42) unless the
  // ?seed= URL parameter overrides it, and backendKind is runtime-only:
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
   * Real milliseconds between the snapshot now shown and the next one
   * expected while the run is playing: 250 at speed 1 and above, 250 / speed
   * below it (500 at 0.5, 2500 at 0.1). Follows the speed setting at once,
   * so it is right mid-run too. Frame interpolation spreads one
   * snapshot-to-snapshot move over this long.
   */
  stepIntervalMs: number;
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
  /** the server no longer has this run (it restarted, or the run sat idle too long): only a new run can follow */
  ended: boolean;
  /** this run is on a map drawn in the map builder, not the default world */
  customMap: boolean;
  /** the multiplayer room this app is showing, as last polled; null in a private run (see store/room.ts) */
  room: RoomInfo | null;
  /** the site this player owns in the room: ringed and badged "yours" on the map; null for the host or a watcher */
  mySite: number | null;
  /** the damage view of a room's summary: only these sites and pipelines stand out on the map; null normally */
  damageView: { sites: number[]; pipelines: number[] } | null;
  setMySite: (site: number | null) => void;
  /**
   * Live backend command dispatcher, wired by the engine session; null
   * between sessions. A command the engine accepts leaves a note in the log
   * saying what the visitor did (see userNotes.ts); pass `{ note: false }`
   * when the caller writes its own.
   */
  sendCommand: ((cmd: Record<string, unknown>, opts?: { note?: boolean }) => Promise<unknown>) | null;
  /**
   * Fetch what one vehicle is doing (cargo, order, route) from the live
   * session; wired by the engine session, null between sessions.
   */
  fetchVehicle: ((index: number) => Promise<VehicleDetail>) | null;
  /**
   * Fetch one hourly history from the live session: kind 0 is a tank's fill
   * (level / capacity) by tank index, kind 1 a process's rate / design by
   * process index; one value per simulated hour, oldest first, the last one
   * taken at the latest whole hour. Wired by the engine session.
   */
  fetchSeries: ((kind: number, id: number) => Promise<number[]>) | null;
  /**
   * The selected vehicle's trip as last fetched — cargo, order, where from
   * and to, and `path`, the rest of its planned route in map km — or null
   * when no vehicle is selected or nothing has arrived yet. Kept fresh by
   * the vehicle window; the map reads `path` to highlight the route.
   */
  selectedVehicleDetail: VehicleDetail | null;
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
  /** Set the speed; clamped to MIN_SPEED..MAX_SPEED, ignored when not a number. */
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
      seed: DEFAULT_SEED,
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
      stepIntervalMs: stepIntervalFor(DEFAULT_SPEED),
      runEpoch: 0,
      events: [],
      lastSeq: -1,
      selected: null,
      error: null,
      ended: false,
      customMap: false,
      room: null,
      mySite: null,
      damageView: null,
      setMySite: (mySite) => set({ mySite }),
      sendCommand: null,
      fetchVehicle: null,
      fetchSeries: null,
      selectedVehicleDetail: null,
      triggered: [],
      triggeredAt: {},
      rewindTo: null,
      retryNonce: 0,

      setSeed: (seed) => set({ seed: Math.max(0, Math.floor(seed)) }),
      setScenario: (scenario) => set({ scenario }),
      setSpeed: (value) => {
        const speed = clampSpeed(value);
        if (speed !== null) set({ speed, stepIntervalMs: stepIntervalFor(speed) });
      },
      togglePlay: () => set((s) => ({ playing: !s.playing, started: true })),
      // a new selection never shows the previous vehicle's trip
      select: (selected) => set({ selected, selectedVehicleDetail: null }),
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
        const { sendCommand, triggered, triggeredAt, snap } = get();
        // once at a time: it can be run again when its duration has passed
        const running = triggered.includes(scenario.key)
          && Number(snap?.tick ?? 0) < (triggeredAt[scenario.key] ?? 0) + scenarioTicks(scenario);
        if (sendCommand === null || running) return;
        let reply: unknown;
        try {
          reply = await sendCommand(scenario.command, { note: false }); // the scenario's own note follows
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
          triggered: [...s.triggered.filter((k) => k !== scenario.key), scenario.key],
          triggeredAt: { ...s.triggeredAt, [scenario.key]: Number(s.snap?.tick ?? 0) },
          events: [
            ...s.events,
            {
              seq: userSeq(),
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
      // The step interval is derived from the speed, so a saved speed brings
      // its interval with it.
      // A saved speed outside the range (or not a number) resets to the default.
      merge: (persisted, current) => {
        // The seed is never restored: a run opens on the default seed (or the
        // ?seed= one), whatever an older build saved in this browser.
        const merged = { ...current, ...(persisted as Partial<SimState>), seed: current.seed };
        const saved = typeof merged.speed === 'number' ? merged.speed : NaN;
        const speed = saved >= MIN_SPEED && saved <= MAX_SPEED ? clampSpeed(saved) ?? DEFAULT_SPEED : DEFAULT_SPEED;
        return { ...merged, speed, stepIntervalMs: stepIntervalFor(speed) };
      },
      partialize: (s) => ({
        scenario: s.scenario,
        speed: s.speed,
      }),
    },
  ),
);

// Apply the ?engine= override on top of the hosted default (tests and local
// development select the in-page stub this way; no UI exists for it), and
// the ?world= choice of map and the ?seed= testing override.
if (typeof location !== 'undefined') {
  const params = new URLSearchParams(location.search);
  const override = backendOverride(params);
  if (override !== null) useSim.setState({ backendKind: override });
  useSim.setState({ worldName: worldFromParams(params), seed: seedFromParams(params) });
}
