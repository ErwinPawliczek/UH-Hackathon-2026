// The player's side of a room. Watching the room is the app's own room mode
// (store/room.ts): the world, snapshots, the room itself and the log land in
// the sim store, and SceneCanvas draws them. What is kept here is the
// player's seat (name and token, remembered per room), the scores, and the
// three things a player does: join, take a plant, and run it.

import { create } from 'zustand';
import { useSim } from '../store/sim';
import type { RoomSource } from '../store/room';
import type { PlayerAction, RoomInfo, RoomScore } from '../store/roomTypes';
import { loadSeat, saveSeat, type Seat } from './playLogic';

/** Real milliseconds between polls of the scores. */
export const SCORES_MS = 1000;
/** Control changes go out at most twice a second. */
export const SEND_MS = 500;

export interface PlayState {
  code: string | null;
  source: RoomSource | null;
  seat: Seat | null;
  scores: RoomScore[];
  /** my profit at each scores poll, for the small trend */
  profitTrend: number[];
  /** why the last request failed, in a sentence */
  error: string | null;
  /** what the player has set and is still on its way to the server */
  pending: Partial<{ markup: number; share: number }>;
  /** when the server last confirmed a control change (performance.now clock), or null */
  confirmedAt: number | null;
  sending: boolean;
  /** units the player took down themselves: their going down is not news to them */
  ownDown: number[];
  open: (code: string, source: RoomSource) => void;
  join: (name: string) => Promise<void>;
  claim: (site: number | null) => Promise<void>;
  leave: () => void;
  setPrice: (markup: number) => void;
  setRate: (share: number) => void;
  setUnit: (unitIndex: number, down: boolean) => Promise<void>;
}

const say = (err: unknown) => {
  const body = (err as { body?: unknown } | null)?.body;
  if (typeof body === 'string') {
    try {
      const j = JSON.parse(body) as { error?: unknown };
      if (typeof j.error === 'string' && j.error !== '') return j.error;
    } catch {
      // not JSON: the message stands
    }
  }
  return err instanceof Error ? err.message : String(err);
};
let sendTimer: ReturnType<typeof setTimeout> | null = null;

export const usePlay = create<PlayState>()((set, get) => {
  /** Send what is pending, then again if more arrived meanwhile; never more often than SEND_MS. */
  const flush = async () => {
    sendTimer = null;
    const { source, seat, pending } = get();
    if (source === null || seat === null) return;
    const actions: PlayerAction[] = [];
    if (pending.markup !== undefined) actions.push({ action: 'price', markup: pending.markup });
    if (pending.share !== undefined) actions.push({ action: 'rate', share: pending.share });
    if (actions.length === 0) return;
    set({ pending: {}, sending: true });
    try {
      for (const a of actions) {
        const r = await source.play(seat.token, a);
        if (r.ok === false) throw new Error(r.error ?? 'The game did not accept that.');
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
    code: null, source: null, seat: null, scores: [], profitTrend: [], error: null, pending: {}, confirmedAt: null, sending: false, ownDown: [],

    open: (code, source) => {
      const seat = loadSeat(code);
      source.identify(seat?.token ?? null);
      set({ code, source, seat, scores: [], profitTrend: [], error: null });
    },

    join: async (name) => {
      const { source, code } = get();
      if (source === null || code === null) return;
      try {
        const reply = await source.join(name.trim());
        if ((reply as { ok?: boolean; error?: string }).ok === false) throw new Error((reply as { error?: string }).error ?? 'You could not join.');
        // the server may have changed the name to keep it unique
        const seat = { name: reply.name ?? name.trim(), playerId: reply.playerId, token: reply.token };
        saveSeat(code, seat);
        source.identify(seat.token);
        // the room as it is now, with me in it, before the seat is shown as taken
        useSim.setState({ room: await source.info() });
        set({ seat, error: null });
      } catch (err) {
        set({ error: say(err) });
      }
    },

    claim: async (site) => {
      const { source, seat } = get();
      if (source === null || seat === null) return;
      try {
        const r = await source.claim(seat.token, site);
        set({ error: r.ok === false ? r.error ?? 'That plant could not be taken.' : null });
        useSim.setState({ room: await source.info() }); // show it at once, not at the next poll
      } catch (err) {
        set({ error: say(err) });
      }
    },

    leave: () => {
      const { source, seat, code } = get();
      if (source !== null && seat !== null) void source.claim(seat.token, null).catch(() => undefined);
      if (code !== null) saveSeat(code, null);
      source?.identify(null);
      useSim.getState().setMySite(null);
      set({ seat: null, pending: {}, confirmedAt: null, error: null });
    },

    setPrice: (markup) => queue({ markup }),
    setRate: (share) => queue({ share }),
    setUnit: async (unitIndex, down) => {
      const { source, seat } = get();
      if (source === null || seat === null) return;
      set({ sending: true });
      try {
        const r = await source.play(seat.token, { action: 'unit', unit_index: unitIndex, down });
        if (r.ok === false) set({ error: r.error ?? 'The game did not accept that.' });
        else set((s) => ({ confirmedAt: performance.now(), error: null, ownDown: down ? [...new Set([...s.ownDown, unitIndex])] : s.ownDown.filter((u) => u !== unitIndex) }));
      } catch (err) {
        set({ error: say(err) });
      } finally {
        set({ sending: false });
      }
    },
  };
});

/** My player in the room, when the room still knows me. */
export function mePlayer(room: RoomInfo | null, seat: Seat | null) {
  return room?.players.find((p) => p.id === seat?.playerId) ?? null;
}

/** Poll the scores once a second while the screen is up; returns the stop function. */
export function startScoresLoop(): () => void {
  let busy = false;
  let stopped = false;
  const poll = () => {
    const { source, seat } = usePlay.getState();
    if (source === null || busy) return;
    busy = true;
    source.scores()
      .then((reply) => {
        if (stopped) return;
        const room = useSim.getState().room;
        const mine = mePlayer(room, seat)?.site ?? null;
        const profit = reply.scores.find((x) => x.site === mine)?.profitUsd;
        usePlay.setState((s) => ({
          scores: reply.scores,
          profitTrend: profit === undefined || room?.phase !== 'running' ? s.profitTrend : [...s.profitTrend, profit].slice(-120),
        }));
      })
      .catch(() => undefined) // a missed poll is retried in a second
      .finally(() => { busy = false; });
  };
  poll();
  const timer = setInterval(poll, SCORES_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
