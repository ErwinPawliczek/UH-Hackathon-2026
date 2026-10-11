// The sim engine session and step loop, framework-free so the session
// lifecycle is unit-testable without a DOM: openEngineSession creates a
// backend session for the current settings and pushes the first snapshot;
// startStepLoop advances it at the chosen speed while playing and pulls
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

import { customLayout } from './customMap';
import { createBackend } from '../engine/api';
import type { BackendKind, SimBackend } from '../engine/api';
import { HttpError } from '../engine/httpBackend';
import { resolveWorld } from '../engine/world';
import { nextStep, useSim } from './sim';
import { describeCommand, isUserEvent, momentWords, userSeq } from './userNotes';

/** How often the loop checks whether a step is due — the pacing error of any one step. */
const POLL_MS = 25;

/** The live backend session; null between sessions and while one is opening. */
let session: { id: string; backend: SimBackend } | null = null;

/** False while the live session is a shared room: the server runs its clock, and the client never steps or releases it. */
let clientSteps = true;

/**
 * Stand a session in that someone else owns and advances (a multiplayer
 * room): the panels' reads go through it like any session, but the step loop
 * leaves it alone and it is never released from here. Null takes it away.
 */
export function adoptSession(live: { id: string; backend: SimBackend } | null): void {
  session = live;
  clientSteps = live === null;
}

/** Backend + id of the current session, for the step loop and UI commands. */
export function engineSession(): { id: string; backend: SimBackend } | null {
  return session;
}

export interface SessionOptions {
  kind: BackendKind;
  seed: number;
  scenario: string;
  /** Named world to ask the engine for; absent = the engine's built-in world. */
  world?: string;
}

/** Live session, as owned by openEngineSession / recovery. */
interface LiveSession {
  id: string;
  backend: SimBackend;
}

/**
 * Requests to one session run one at a time, in the order they were made: a
 * command or a rewind never overtakes a step still in flight. That makes the
 * store's snapshot the tick the engine was at when it took a command, and
 * keeps a late step reply from overwriting the state a rewind just loaded.
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Run one read against the live session through the same queue as steps and
 * commands (so it sees the run at a settled tick). Null when no session is
 * open. For panels that fetch their own data: the economy and forecast views.
 */
export function sessionRequest<T>(fn: (backend: SimBackend, id: string) => Promise<T>): Promise<T> | null {
  const live = session;
  return live === null ? null : serial(() => fn(live.backend, live.id));
}

/**
 * Take the session back to `tick` and reload what the client derived from
 * the run: the snapshot (dropping the interpolation partner), the engine's
 * event log from its first entry, and the scenario notes and ticks — a
 * scenario triggered at that tick or later is forgotten by the engine and
 * becomes available again. The run stays paused. Rejects with the server's
 * reason when it refuses.
 */
async function rewindSession({ id, backend }: LiveSession, tick: number): Promise<void> {
  useSim.setState({ playing: false });
  await serial(async () => {
    try {
      await backend.rewind(id, tick);
    } catch (err) {
      throw new Error(err instanceof HttpError ? err.reason : err instanceof Error ? err.message : String(err));
    }
    const snap = await backend.step(id, 0);
    const log = await backend.events(id, -1);
    useSim.setState((s) => {
      const kept = s.triggered.filter((key) => (s.triggeredAt[key] ?? 0) < tick);
      // what the visitor did before that moment still happened; going back is itself something they did
      const notes = [
        ...s.events.filter((e) => isUserEvent(e) && e.tick < tick),
        { seq: userSeq(), tick, type: 'rewind', text: `You went back to ${momentWords(tick)}` },
      ];
      return {
        snap,
        prevSnap: null,
        snapAt: performance.now(),
        runEpoch: s.runEpoch + 1,
        events: [...log, ...notes].sort((a, b) => a.tick - b.tick),
        lastSeq: log.length > 0 ? log[log.length - 1].seq : -1,
        triggered: kept,
        triggeredAt: Object.fromEntries(kept.map((key) => [key, s.triggeredAt[key]])),
        selectedVehicleDetail: null, // refetched for the moment gone back to
        playing: false,
        error: null,
      };
    });
  });
}

/** Fire-and-forget DELETE of the current server-side session, if any. */
function releaseCurrent(): void {
  if (session === null) return;
  if (!clientSteps) {
    // a room is the server's: just let go of it
    session = null;
    clientSteps = true;
    return;
  }
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
  { seed, scenario, world: worldName }: SessionOptions,
  backend: SimBackend,
  stillRunning: () => boolean = () => true,
): Promise<LiveSession | null> {
  // a map drawn in the builder and sent here to be run, if there is one
  const layout = backend.kind === 'http' ? customLayout() : null;
  useSim.setState({ customMap: layout !== null });
  const { id } = await backend.create({ seed, scenario, world: worldName, ...(layout !== null ? { layout } : {}) });
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
    runEpoch: useSim.getState().runEpoch + 1,
    events: [],
    triggered: [],
    triggeredAt: {},
    lastSeq: -1,
    selected: null,
    prevSnap: null,
    snap: null,
    // a command the engine accepts is something the visitor did: note it in the log
    sendCommand: async (cmd, opts) => {
      const reply = await serial(() => backend.command(id, cmd));
      const refused = typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === false;
      const note = opts?.note === false || refused ? null : describeCommand(useSim.getState().world, cmd);
      if (note !== null) {
        useSim.setState((s) => ({
          events: [...s.events, { seq: userSeq(), tick: Number(s.snap?.tick ?? 0), ...note }],
        }));
      }
      return reply;
    },
    fetchVehicle: (index) => serial(() => backend.vehicle(id, index)),
    fetchSeries: (kind, refId) => serial(() => backend.series(id, kind, refId)),
    selectedVehicleDetail: null,
    rewindTo: (tick) => rewindSession({ id, backend }, tick),
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
  { kind, seed, scenario, world }: SessionOptions,
  backend: SimBackend = createBackend(kind),
): () => void {
  let cancelled = false;
  releaseCurrent(); // replacement: the previous session's DELETE
  if (backend.kind === 'http') ensureUnloadInstalled();
  useSim.getState().setError(null);
  void (async () => {
    try {
      const live = await openSessionFor({ kind, seed, scenario, world }, backend, () => !cancelled);
      if (live === null) return; // replaced mid-open; openSessionFor released the id
      session = live;
    } catch (err) {
      // a refused request carries the server's own reason ("Refinery needs a river lane within 12 km")
      if (!cancelled) useSim.getState().setError(err instanceof HttpError ? err.reason : err instanceof Error ? err.message : String(err));
    }
  })();
  return () => {
    cancelled = true;
    releaseCurrent();
    useSim.setState({
      sendCommand: null, rewindTo: null, fetchVehicle: null, fetchSeries: null, selectedVehicleDetail: null,
    });
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

/**
 * The session is gone on the server (it restarted, or dropped a run left
 * idle): this run cannot continue. Stop, and say so — the visitor starts a
 * new one. Nothing is recreated behind their back: a fresh run would stand
 * at day 0 with everything they did gone, which must not happen silently.
 */
export function endRun(): void {
  session = null;
  useSim.setState({ ended: true, playing: false, error: null });
}

/**
 * The step loop, created once and kept for the app's lifetime: settings
 * changes replace the session, not the loop. It checks every 25 ms whether a
 * step is due — the store's step interval after the previous one was due —
 * and then advances `nextStep(speed, carry)` ticks: one tick on a stretched
 * interval below speed 1, the speed's worth of ticks every 250 ms from 1 up,
 * fractions carried so 1.5 really averages 1.5.
 *
 * Speed and playing state are read when a step is due, so a change mid-run
 * takes effect on the next step: nothing is skipped or doubled, and a pause,
 * a slow reply or a jump from a long interval to a short one never causes a
 * burst of catch-up steps (the schedule restarts from now instead). A step
 * still in flight is never overlapped. Returns a cleanup that stops it.
 */
export function startStepLoop(): () => void {
  let inFlight = false;
  let lastAt = -Infinity; // when the previous step was due (performance.now clock)
  let carry = 0; // fraction of a tick owed to the next step
  const timer = setInterval(() => {
    const s = useSim.getState();
    if (!s.playing || inFlight || !clientSteps) return;
    const current = session;
    if (current === null) return;
    const now = performance.now();
    // Due one interval after the previous step was due, at the speed set
    // NOW: a shorter interval applies at once, a longer one waits it out.
    const late = now - (lastAt + s.stepIntervalMs);
    if (late < 0) return; // not due yet
    // On schedule: count from when this step was due, so the cadence does
    // not drift by the polling error. Behind schedule (paused, slow reply,
    // or the interval just got shorter): restart from now — no catch-up.
    lastAt = late < s.stepIntervalMs ? lastAt + s.stepIntervalMs : now;
    const step = nextStep(s.speed, carry);
    carry = step.carry;
    const ticks = step.ticks;
    inFlight = true;
    void (async () => {
      try {
        const snap = await serial(() => current.backend.step(current.id, ticks));
        useSim.getState().pushSnapshot(snap);
        const { lastSeq } = useSim.getState();
        const events = await current.backend.events(current.id, lastSeq);
        useSim.getState().addEvents(events);
        useSim.getState().setError(null);
      } catch (err) {
        if (isGoneSession(err)) {
          endRun();
        } else {
          useSim.getState().setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_MS);
  return () => clearInterval(timer);
}
