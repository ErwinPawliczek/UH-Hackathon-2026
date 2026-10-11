// The player's side of a room: who they are in it, what the room and the
// scores last said, and the polling that keeps both fresh. The 3D scene is
// the app's own SceneCanvas, which draws from the sim store: the snapshots
// polled here are pushed into that store, and nothing here ever steps the
// engine (the server runs the clock).

import { create } from 'zustand';
import type { SimEvent } from '../engine/api';
import { useSim } from '../store/sim';
import { loadSeat, saveSeat, type Seat } from './playLogic';
import { HttpRoom, MockRoom, RoomError, type PlayAction, type RoomApi, type RoomState, type Score } from './roomApi';

/** Real milliseconds between polls (contract: snapshot 4 times a second, room once a second). */
export const SNAPSHOT_MS = 250;
export const ROOM_MS = 1000;
/** Control changes go out at most twice a second. */
export const SEND_MS = 500;

export interface PlayState {
  code: string | null;
  api: RoomApi | null;
  seat: Seat | null;
  room: RoomState | null;
  scores: Score[];
  events: SimEvent[];
  /** my profit at each scores poll, for the small trend */
  profitTrend: number[];
  /** why the last request failed, in a sentence */
  error: string | null;
  /** the game is gone (the room expired or never existed) */
  gone: boolean;
  /** what the player has set and is still on its way to the server */
  pending: Partial<{ markup: number; share: number }>;
  /** when the server last confirmed a control change (performance.now clock), or null */
  confirmedAt: number | null;
  sending: boolean;
  open: (code: string, mock: string | null) => void;
  join: (name: string) => Promise<void>;
  claim: (site: number | null) => Promise<void>;
  leave: () => void;
  setPrice: (markup: number) => void;
  setRate: (share: number) => void;
  setUnit: (unitIndex: number, down: boolean) => Promise<void>;
}

const say = (err: unknown) => (err instanceof Error ? err.message : String(err));
let sendTimer: ReturnType<typeof setTimeout> | null = null;

export const usePlay = create<PlayState>()((set, get) => {
  /** Send what is pending, then again if more arrived meanwhile; never more often than SEND_MS. */
  const flush = async () => {
    sendTimer = null;
    const { api, seat, pending } = get();
    if (api === null || seat === null) return;
    const actions: PlayAction[] = [];
    if (pending.markup !== undefined) actions.push({ action: 'price', markup: pending.markup });
    if (pending.share !== undefined) actions.push({ action: 'rate', share: pending.share });
    if (actions.length === 0) return;
    set({ pending: {}, sending: true });
    try {
      for (const a of actions) {
        const r = await api.play(seat.token, a);
        if (!r.ok) throw new Error(r.error ?? 'The game did not accept that.');
      }
      set({ confirmedAt: performance.now(), error: null });
    } catch (err) {
      set({ error: say(err) });
    } finally {
      set({ sending: false });
      if (Object.keys(get().pending).length > 0 && sendTimer === null) sendTimer = setTimeout(() => void flush(), SEND_MS);
    }
  };
  const queue = (change: Partial<{ markup: number; share: number }>) => {
    set((s) => ({ pending: { ...s.pending, ...change } }));
    if (sendTimer === null) sendTimer = setTimeout(() => void flush(), SEND_MS);
  };

  return {
    code: null, api: null, seat: null, room: null, scores: [], events: [], profitTrend: [], error: null, gone: false,
    pending: {}, confirmedAt: null, sending: false,

    open: (code, mock) => {
      const api: RoomApi = mock !== null ? new MockRoom(code) : new HttpRoom(code);
      if (api instanceof MockRoom && (mock === 'running' || mock === 'paused')) api.host(mock === 'running' ? 'start' : 'pause');
      set({ code, api, seat: loadSeat(code), room: null, scores: [], events: [], profitTrend: [], error: null, gone: false });
    },

    join: async (name) => {
      const { api, code } = get();
      if (api === null || code === null) return;
      try {
        const { playerId, token } = await api.join(name.trim());
        const seat = { name: name.trim(), playerId, token };
        saveSeat(code, seat);
        set({ seat, error: null });
      } catch (err) {
        set({ error: say(err) });
      }
    },

    claim: async (site) => {
      const { api, seat } = get();
      if (api === null || seat === null) return;
      try {
        const r = await api.claim(seat.token, site);
        set({ error: r.ok ? null : r.error ?? 'That plant could not be taken.' });
        set({ room: await api.room() });
      } catch (err) {
        set({ error: say(err) });
      }
    },

    leave: () => {
      const { api, seat, code } = get();
      if (api !== null && seat !== null) void api.claim(seat.token, null).catch(() => undefined);
      if (code !== null) saveSeat(code, null);
      set({ seat: null, pending: {}, confirmedAt: null, error: null });
    },

    setPrice: (markup) => queue({ markup }),
    setRate: (share) => queue({ share }),
    setUnit: async (unitIndex, down) => {
      const { api, seat } = get();
      if (api === null || seat === null) return;
      set({ sending: true });
      try {
        const r = await api.play(seat.token, { action: 'unit', unit_index: unitIndex, down });
        set(r.ok ? { confirmedAt: performance.now(), error: null } : { error: r.error ?? 'The game did not accept that.' });
      } catch (err) {
        set({ error: say(err) });
      } finally {
        set({ sending: false });
      }
    },
  };
});

/** My player in the room, when the room still knows me. */
export function mePlayer(s: Pick<PlayState, 'room' | 'seat'>) {
  return s.room?.players.find((p) => p.id === s.seat?.playerId) ?? null;
}

/**
 * Start polling the room; returns the stop function. The world is fetched
 * once and handed to the sim store, snapshots follow four times a second,
 * and the room, the scores and the log once a second.
 */
export function startRoomLoop(): () => void {
  let stopped = false;
  let busySnap = false;
  let busyRoom = false;
  let lastSeq = 0;
  const api = () => usePlay.getState().api;

  const fail = (err: unknown) => {
    if (err instanceof RoomError && err.status === 404) usePlay.setState({ gone: true, error: null });
    else usePlay.setState({ error: say(err) });
  };

  void (async () => {
    const a = api();
    if (a === null) return;
    try {
      const world = await a.world();
      if (stopped) return;
      useSim.setState({ world, snap: null, prevSnap: null, started: true, stepIntervalMs: SNAPSHOT_MS, selected: null, runEpoch: useSim.getState().runEpoch + 1 });
    } catch (err) {
      fail(err);
    }
  })();

  const snapTimer = setInterval(() => {
    const a = api();
    if (a === null || busySnap || useSim.getState().world === null) return;
    busySnap = true;
    a.snapshot()
      .then((snap) => { if (!stopped && snap !== null) useSim.getState().pushSnapshot(snap); })
      .catch(fail)
      .finally(() => { busySnap = false; });
  }, SNAPSHOT_MS);

  const pollRoom = () => {
    const a = api();
    if (a === null || busyRoom) return;
    busyRoom = true;
    Promise.all([a.room(), a.scores().catch(() => null), a.events(lastSeq).catch(() => [])])
      .then(([room, scores, events]) => {
        if (stopped) return;
        if (events.length > 0) lastSeq = events[events.length - 1].seq + 1;
        usePlay.setState((s) => {
          const mine = room.players.find((p) => p.id === s.seat?.playerId)?.site ?? null;
          const profit = scores?.scores.find((x) => x.site === mine)?.profitUsd;
          return {
            room, gone: false,
            scores: scores?.scores ?? s.scores,
            events: events.length > 0 ? [...s.events, ...events].slice(-200) : s.events,
            profitTrend: profit === undefined || room.phase !== 'running' ? s.profitTrend : [...s.profitTrend, profit].slice(-120),
            error: s.error !== null && s.error.startsWith('Cannot reach') ? null : s.error,
          };
        });
        // the scene eases vehicles only while the clock runs
        useSim.setState({ playing: room.phase === 'running' });
      })
      .catch(fail)
      .finally(() => { busyRoom = false; });
  };
  pollRoom();
  const roomTimer = setInterval(pollRoom, ROOM_MS);

  return () => {
    stopped = true;
    clearInterval(snapTimer);
    clearInterval(roomTimer);
  };
}
