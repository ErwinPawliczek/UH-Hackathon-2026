import { describe, expect, it } from 'vitest';
import { stubWorld } from '../engine/world';
import {
  fmtProfit, loadSeat, makesWords, minRate, ordinal, othersWords, pctSigned, priceWords, rankWords, rateWords, roomCode, saveSeat, siteUnits,
} from './playLogic';

describe('the player screen in words', () => {
  it("writes ranks, prices and rates plainly", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
    expect(rankWords(3, 12)).toBe('3rd of 12');
    expect(priceWords(0.05)).toBe('5% above the going rate: more per tonne, fewer buyers.');
    expect(priceWords(-0.2)).toBe('20% below the going rate: less per tonne, more buyers.');
    expect(priceWords(0)).toBe('At the going rate.');
    expect([0.3, -0.05, 0].map(pctSigned)).toEqual(['+30%', '−5%', '0%']);
    expect(rateWords(1, 0.4)).toMatch(/^Flat out/);
    expect(rateWords(0.4, 0.4)).toMatch(/lowest it can run/);
    expect(fmtProfit(1_234_000)).toBe('$1.2 M');
    expect(fmtProfit(-12_400)).toBe('-$12 K');
  });

  it("describes a plant from the world: what it makes, its units and its lowest rate", () => {
    const world = stubWorld(42);
    expect(makesWords(world, 0)).toMatch(/^(Makes |Sells )/);
    const units = siteUnits(world, 1);
    expect(units.length).toBeGreaterThan(0);
    // global indices: no two units of the world share one
    const all = world.sites.flatMap((_, i) => siteUnits(world, i).map((u) => u.index));
    expect(new Set(all).size).toBe(all.length);
    expect(minRate(world, 1)).toBeGreaterThan(0);
    expect(minRate(world, 1)).toBeLessThan(1);
  });

  it("says who else is in", () => {
    const room = { code: 'ABCD', phase: 'lobby' as const, tick: 0, speed: 1, sites: [], players: ['Maya', 'Omar', 'Lin', 'Ada', 'Me'].map((name, i) => ({ id: `p${i}`, name, site: null, connected: true })) };
    expect(othersWords(room, 'p4')).toBe('Also in: Maya, Omar, Lin and 1 more.');
    expect(othersWords({ ...room, players: room.players.slice(4) }, 'p4')).toBe('You are the first one in.');
  });

  it("reads the room code from the address and keeps a seat per room", () => {
    expect(roomCode({ search: '?room=abcd', pathname: '/play/' })).toBe('ABCD');
    expect(roomCode({ search: '', pathname: '/play/WXYZ' })).toBe('WXYZ');
    expect(roomCode({ search: '?room=12', pathname: '/play/' })).toBeNull();
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    saveSeat('abcd', { name: 'Maya', playerId: 'p1', token: 't1' }, store);
    expect(loadSeat('ABCD', store)).toEqual({ name: 'Maya', playerId: 'p1', token: 't1' });
    expect(loadSeat('WXYZ', store)).toBeNull();
    saveSeat('ABCD', null, store);
    expect(loadSeat('ABCD', store)).toBeNull();
  });
});
