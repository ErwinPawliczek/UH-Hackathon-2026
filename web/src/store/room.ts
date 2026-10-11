// Room mode: the app shows a shared multiplayer room instead of a private
// run. The SERVER runs the room's clock; this client only watches. It polls
// the room's snapshot four times a second (a poll that finds the same tick
// changes nothing), the room itself once a second, and never calls step.
//
// Everything the scene and the panels read stays where it always was: the
// world, snapshots, events and the read-only fetches land in the same store
// fields a private run fills, so SceneCanvas and the windows draw a room
// with no changes. What a room adds is `room` (who is in it, who owns what)
// and `mySite` (the plant this player runs).
//
// Entry points:
//   openRoom(code)          start watching; returns a function that stops
//   useRoom(code)           the same as a React hook (store/useRoom.ts)
//   roomSource(code)        the room's HTTP calls, for the host and player screens
//   useSim.getState().setMySite(index | null)

import { decode, type Snapshot } from '../engine/snapshot';
import { HttpBackend, HttpError } from '../engine/httpBackend';
import type { SimBackend } from '../engine/api';
import { resolveWorld, type WorldSpec } from '../engine/world';
import { adoptSession } from './engineSession';
import { useSim } from './sim';
import type { HostAction, PlayerAction, RoomInfo, RoomReply, RoomScores } from './roomTypes';

/** Real milliseconds between snapshot polls, and between polls of the room itself. */
export const SNAPSHOT_POLL_MS = 250;
export const ROOM_POLL_MS = 1000;
/** Bounds on the snapshot-to-snapshot time the scene spreads a move over. */
const MIN_STEP_MS = 200;
const MAX_STEP_MS = 3000;

/** Where a room's data comes from: the server, or a stand-in for building against. */
export interface RoomSource {
  readonly code: string;
  info(): Promise<RoomInfo>;
  world(): Promise<unknown>;
  /** the room's snapshot now, or null when its tick is still `lastTick` */
  snapshot(lastTick: number | null): Promise<Snapshot | null>;
  scores(): Promise<RoomScores>;
  host(hostToken: string, action: HostAction): Promise<{ ok?: boolean; error?: string }>;
  /** the player's side: come in under a name, take (or free) a plant, and run it */
  join(name: string): Promise<{ playerId: string; token: string; name?: string }>;
  /** poll the room as this player from now on, so the room shows them as connected; null stops that */
  identify(token: string | null): void;
  claim(token: string, site: number | null): Promise<RoomReply>;
  play(token: string, action: PlayerAction): Promise<RoomReply>;
  /** the read-only views (events, series, vehicle, economy, sourcing) as a session the panels can use */
  reads(): { id: string; backend: SimBackend };
  close(): void;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`Cannot reach the game server (${err instanceof Error ? err.message : String(err)})`);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${init?.method ?? 'GET'} ${url} -> ${res.status}`, text);
  return JSON.parse(text) as T;
}

/** The room code in the page's address (`?room=CODE`), upper-cased; null when there is none. */
export function roomFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const code = (new URLSearchParams(window.location.search).get('room') ?? '').trim().toUpperCase();
  return code === '' ? null : code;
}

/** POST /api/room: a new room on the default world, paused at tick 0. */
export function createRoom(hostName?: string): Promise<{ code: string; hostToken: string }> {
  return json('/api/room', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(hostName ? { hostName } : {}) });
}

/** The room's HTTP calls. Its read-only views live under /api/room/{code}/… in the shapes of /api/sim/{id}/…. */
export function roomSource(code: string): RoomSource {
  const base = `/api/room/${encodeURIComponent(code)}`;
  // the panels ask a session for /api/sim/{id}/…: answer from the room's copy of the same routes
  const backend = new HttpBackend('', (input, init) => fetch(String(input).replace('/api/sim/', '/api/room/'), init));
  let etag: string | null = null;
  let who: string | null = null;
  return {
    code,
    info: () => json<RoomInfo>(who === null ? base : `${base}?token=${encodeURIComponent(who)}`),
    identify: (token) => { who = token; },
    world: () => json<unknown>(`${base}/world`),
    async snapshot(lastTick) {
      const res = await fetch(`${base}/snapshot`, etag !== null && lastTick !== null ? { headers: { 'If-None-Match': etag } } : undefined);
      if (res.status === 304) return null;
      if (!res.ok) throw new HttpError(res.status, `GET ${base}/snapshot -> ${res.status}`, await res.text().catch(() => ''));
      etag = res.headers.get('ETag');
      const snap = decode(await res.arrayBuffer());
      return lastTick !== null && Number(snap.tick) === lastTick ? null : snap;
    },
    scores: () => json<RoomScores>(`${base}/scores`),
    host: (hostToken, action) => json(`${base}/host`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ hostToken, ...action }) }),
    join: (name) => json(`${base}/join`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name }) }),
    claim: (token, site) => json(`${base}/claim`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token, site }) }),
    play: (token, action) => json(`${base}/play`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token, ...action }) }),
    reads: () => ({ id: code, backend }),
    close: () => undefined,
  };
}

/**
 * Start showing room `code`. Returns a function that stops and clears the
 * room from the store. `source` is the server unless one is passed (the mock
 * in store/roomMock.ts, or a test double).
 */
export function openRoom(code: string, source: RoomSource = roomSource(code)): () => void {
  let stopped = false;
  let lastTick: number | null = null;
  let lastAt = 0;
  let stepMs = SNAPSHOT_POLL_MS;
  let snapBusy = false;
  let roomBusy = false;
  const timers: ReturnType<typeof setInterval>[] = [];

  useSim.getState().setError(null);
  useSim.setState({
    room: null, playing: false, started: false, ended: false, customMap: false,
    sendCommand: null, rewindTo: null, selected: null, selectedVehicleDetail: null,
    events: [], triggered: [], triggeredAt: {}, lastSeq: -1, snap: null, prevSnap: null,
  });

  const takeRoom = (room: RoomInfo) => {
    useSim.setState({
      room,
      // "playing" is what the scene eases by: true only while the server's clock runs
      playing: room.phase === 'running',
      started: room.phase !== 'lobby',
      ended: room.phase === 'ended',
      speed: room.speed > 0 ? room.speed : useSim.getState().speed,
    });
  };

  const pollSnapshot = async () => {
    if (stopped || snapBusy) return;
    snapBusy = true;
    try {
      const snap = await source.snapshot(lastTick);
      if (stopped || snap === null) return;
      const tick = Number(snap.tick);
      const now = performance.now();
      if (lastTick !== null && tick < lastTick) {
        // the room went back (restarted): nothing buffered across snapshots holds any more
        useSim.setState((s) => ({ runEpoch: s.runEpoch + 1, prevSnap: null, events: [], lastSeq: -1 }));
        stepMs = SNAPSHOT_POLL_MS;
      } else if (lastTick !== null) {
        // The scene spreads each move over the time snapshots really arrive
        // apart, which a poll makes uneven: follow it, smoothed.
        const gap = Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, now - lastAt));
        stepMs = stepMs * 0.6 + gap * 0.4;
      }
      lastTick = tick;
      lastAt = now;
      useSim.setState({ stepIntervalMs: stepMs });
      useSim.getState().pushSnapshot(snap);
      useSim.getState().setError(null);
    } catch (err) {
      if (!stopped) useSim.getState().setError(err instanceof HttpError && (err.status === 404 || err.status === 410) ? 'This game has ended.' : err instanceof Error ? err.message : String(err));
    } finally {
      snapBusy = false;
    }
  };

  const pollRoom = async () => {
    if (stopped || roomBusy) return;
    roomBusy = true;
    try {
      takeRoom(await source.info());
      const { id, backend } = source.reads();
      const events = await backend.events(id, useSim.getState().lastSeq);
      if (!stopped) useSim.getState().addEvents(events);
    } catch {
      // the snapshot poll reports a server that is gone; a missed room poll is retried in a second
    } finally {
      roomBusy = false;
    }
  };

  void (async () => {
    try {
      const [room, rawWorld] = await Promise.all([source.info(), source.world()]);
      if (stopped) return;
      const world: WorldSpec = resolveWorld(rawWorld, 0);
      const reads = source.reads();
      adoptSession(reads);
      useSim.setState((s) => ({
        world,
        runEpoch: s.runEpoch + 1,
        fetchVehicle: (index) => reads.backend.vehicle(reads.id, index),
        fetchSeries: (kind, refId) => reads.backend.series(reads.id, kind, refId),
      }));
      takeRoom(room);
      await pollSnapshot();
      timers.push(setInterval(() => void pollSnapshot(), SNAPSHOT_POLL_MS));
      timers.push(setInterval(() => void pollRoom(), ROOM_POLL_MS));
    } catch (err) {
      if (!stopped) useSim.getState().setError(err instanceof HttpError && err.status === 404 ? `There is no game with the code ${code}.` : err instanceof Error ? err.message : String(err));
    }
  })();

  return () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
    source.close();
    adoptSession(null);
    useSim.setState({ room: null, mySite: null, fetchVehicle: null, fetchSeries: null, playing: false });
  };
}
