import { describe, expect, it, vi } from 'vitest';
import { siteOwners } from './roomTypes';

describe('room', () => {
  it('names the owner of each site from the room, falling back to a player\'s own claim', () => {
    const room = {
      players: [{ id: 'a', name: 'Ada', site: 5, connected: true }, { id: 'b', name: 'Bo', site: 2, connected: true }],
      sites: [{ index: 5, key: 'REFINERY', name: 'Refinery', preset: 'REFINERY', playable: true, owner: 'a' }],
    };
    expect(siteOwners(room, 7)).toEqual([null, null, 'Bo', null, null, 'Ada', null]);
    expect(siteOwners(null, 2)).toEqual([null, null]);
  });

  it('watches a room without ever stepping it, and skips a poll whose tick has not moved', async () => {
    vi.useFakeTimers();
    const { openRoom } = await import('./room');
    const { useSim } = await import('./sim');
    let tick = 0;
    const calls: string[] = [];
    const snap = (t: number) => ({ tick: BigInt(t), siteStatus: new Uint8Array(1), vehStatus: new Uint8Array(0), vehPos: new Float32Array(0) } as never);
    const backend = { kind: 'http', events: async () => [], step: async () => { calls.push('step'); return snap(0); } } as never;
    const stop = openRoom('ABCD', {
      code: 'ABCD',
      info: async () => ({ code: 'ABCD', phase: 'running', tick, speed: 4, players: [], sites: [] }),
      world: async () => ({ sites: [], tanks: [], routes: [], pipelines: [], vehicles: [] }),
      snapshot: async (last) => { calls.push('snapshot'); return last === tick ? null : snap(tick); },
      scores: async () => ({ tick, scores: [] }),
      host: async () => ({ ok: true }),
      reads: () => ({ id: 'ABCD', backend }),
      close: () => calls.push('close'),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(Number(useSim.getState().snap?.tick)).toBe(0);
    expect(useSim.getState().room?.code).toBe('ABCD');
    expect(useSim.getState().playing).toBe(true);
    const epoch = useSim.getState().runEpoch;
    await vi.advanceTimersByTimeAsync(600); // two polls, same tick: nothing new
    expect(Number(useSim.getState().snap?.tick)).toBe(0);
    tick = 7;
    await vi.advanceTimersByTimeAsync(300);
    expect(Number(useSim.getState().snap?.tick)).toBe(7);
    expect(useSim.getState().runEpoch).toBe(epoch);
    tick = 2; // the room went back: buffered state is dropped
    await vi.advanceTimersByTimeAsync(300);
    expect(useSim.getState().runEpoch).toBe(epoch + 1);
    expect(calls).not.toContain('step');
    stop();
    expect(calls).toContain('close');
    expect(useSim.getState().room).toBeNull();
    vi.useRealTimers();
  });
});
