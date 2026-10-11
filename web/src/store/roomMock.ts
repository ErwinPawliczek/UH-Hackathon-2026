// A stand-in room for building the multiplayer screens before the server's
// room endpoints exist: one private engine session that this page steps on
// a timer, as the room's own thread would, with a few made-up players. The
// tick advances by an uneven amount per poll on purpose, as a real room's
// does. Used when the page has `?mockroom` in its address; never otherwise.

import { HttpBackend } from '../engine/httpBackend';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import type { RoomSource } from './room';
import type { HostAction, RoomInfo, RoomPhase, RoomScores } from './roomTypes';

const PLAYABLE = new Set(['source', 'none']);
const NAMES = ['Ada', 'Bo', 'Chen', 'Dee', 'Eli'];

export function mockRoomWanted(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mockroom');
}

export function mockRoom(code = 'MOCK'): RoomSource {
  const backend = new HttpBackend('');
  let id: string | null = null;
  let world: WorldSpec | null = null;
  let snap: Snapshot | null = null;
  // `?mockroom=run` starts it running at once; `&mockspeed=8` sets its speed
  const q = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  let phase: RoomPhase = q.get('mockroom') === 'run' ? 'running' : 'lobby';
  let speed = Math.min(64, Math.max(0.1, Number(q.get('mockspeed')) || 1));
  let carry = 0;
  let busy = false;
  let last = performance.now();
  const ready = (async () => {
    id = (await backend.create({ seed: 42, scenario: 'none', world: 'erwin-world-v1' })).id;
    world = await backend.world(id);
    snap = await backend.step(id, 0);
  })();
  // the "room thread": every 180 to 420 ms, however many ticks that much real time is worth
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = () => {
    timer = setTimeout(async () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      if (phase === 'running' && id !== null && !busy) {
        carry += speed * 4 * dt;
        const ticks = Math.floor(carry);
        carry -= ticks;
        if (ticks > 0) {
          busy = true;
          try { snap = await backend.step(id, ticks); } catch { /* the next turn tries again */ } finally { busy = false; }
        }
      }
      loop();
    }, 180 + Math.random() * 240);
  };
  loop();
  const sites = () => (world?.sites ?? []).map((s, index) => {
    const boundary = (s.processes?.[0] as { boundary?: string } | undefined)?.boundary ?? 'none';
    return { index, key: s.key ?? `S${index}`, name: s.name, preset: s.preset, playable: PLAYABLE.has(boundary) && s.preset !== 'GAS_GRID' && s.preset !== 'PORT_TERMINAL' };
  });
  // players who came in through join(), and what each has set: kept for the tab, so a reload rejoins
  const KEY = `petrogrid-mockroom-${code}`;
  type Joined = { id: string; name: string; token: string; site: number | null; markup: number; share: number };
  let joined: Joined[] = [];
  try { joined = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as Joined[]; } catch { joined = []; }
  const keep = () => { try { sessionStorage.setItem(KEY, JSON.stringify(joined)); } catch { /* nothing to keep */ } };
  const players = () => {
    const open = sites().filter((s) => s.playable);
    const made = NAMES.map((name, i) => ({ id: `p${i}`, name, site: i < 4 && open[i * 3 + 1] !== undefined ? open[i * 3 + 1].index : null, connected: i !== 3 }));
    return [...made, ...joined.map((j) => ({ id: j.id, name: j.name, site: j.site, connected: true }))];
  };
  return {
    code,
    async info(): Promise<RoomInfo> {
      await ready;
      const ps = players();
      return { code, phase, tick: Number(snap?.tick ?? 0), speed, players: ps, sites: sites().map((s) => ({ ...s, owner: ps.find((p) => p.site === s.index)?.id ?? null })) };
    },
    async world() { await ready; return world; },
    async snapshot(lastTick) { await ready; return snap !== null && Number(snap.tick) !== lastTick ? snap : null; },
    async scores(): Promise<RoomScores> {
      await ready;
      const ps = players();
      const tick = Number(snap?.tick ?? 0);
      const rows = sites().filter((s) => s.playable).map((s, i) => {
        const owner = ps.find((p) => p.site === s.index) ?? null;
        const set = joined.find((j) => j.site === s.index);
        const markup = set?.markup ?? 0;
        const rateShare = set?.share ?? 1;
        // a made-up market: a higher price earns more per tonne and sells less
        const sells = rateShare * Math.max(0.2, 1 - 1.6 * Math.max(0, markup)) * (1 + 0.8 * Math.max(0, -markup));
        const profitUsd = Math.round((tick / 96) * (900000 - i * 61000) * (1 + 0.2 * Math.sin(i * 2.1)) * sells * (1 + 3 * markup));
        return { site: s.index, name: s.name, owner: owner?.id ?? null, ownerName: owner?.name ?? null, profitUsd, revenueUsd: profitUsd * 3, feedUsd: profitUsd * 1.6, freightUsd: profitUsd * 0.1, energyUsd: profitUsd * 0.3, markup, rateShare, soldT: Math.round(tick * (40 - i) * sells), rank: 0 };
      }).sort((a, b) => b.profitUsd - a.profitUsd);
      rows.forEach((r, i) => { r.rank = i + 1; });
      return { tick, scores: rows };
    },
    async host(_token, a: HostAction) {
      await ready;
      if (a.action === 'start' || a.action === 'resume') { phase = 'running'; last = performance.now(); }
      else if (a.action === 'pause') phase = 'paused';
      else if (a.action === 'end') phase = 'ended';
      else if (a.action === 'speed') speed = Math.min(64, Math.max(0.1, a.speed));
      else if (a.action === 'scenario' && id !== null) return (await backend.command(id, a.command)) as { ok?: boolean; error?: string };
      return { ok: true };
    },
    identify: () => undefined,
    async join(name) {
      await ready;
      const clean = name.trim().slice(0, 20);
      if (clean === '') throw new Error('Give a name of 1 to 20 characters.');
      const j: Joined = { id: `j${joined.length}-${Date.now() % 100000}`, name: clean, token: `t${Math.random().toString(36).slice(2)}`, site: null, markup: 0, share: 1 };
      joined.push(j);
      keep();
      return { playerId: j.id, token: j.token };
    },
    async claim(token, site) {
      await ready;
      const me = joined.find((j) => j.token === token);
      if (me === undefined) return { ok: false, error: 'You are not in this game any more.' };
      if (site !== null && players().some((p) => p.site === site && p.id !== me.id)) return { ok: false, error: 'Someone has just taken that plant.' };
      me.site = site;
      keep();
      return { ok: true };
    },
    partners: async () => ({ buyers: [], suppliers: [] }),
    async play(token, action) {
      await ready;
      const me = joined.find((j) => j.token === token);
      if (me === undefined || me.site === null) return { ok: false, error: 'You have no plant.' };
      if (action.action === 'price') me.markup = action.markup;
      else if (action.action === 'rate') me.share = action.share;
      else if (action.action === 'block') return { ok: true };
      else if (id !== null && action.down) return (await backend.command(id, { type: 'unit_outage', unit_index: action.unit_index, unit: 'x', trains: 99, duration_h: 24 })) as { ok?: boolean; error?: string };
      else if (!action.down) return { ok: false, error: 'The stand-in game cannot bring a unit back: it returns by itself after a day.' };
      keep();
      return { ok: true };
    },
    reads: () => ({ id: id ?? '', backend }),
    close() { if (timer !== null) clearTimeout(timer); if (id !== null) void backend.release(id); },
  };
}
