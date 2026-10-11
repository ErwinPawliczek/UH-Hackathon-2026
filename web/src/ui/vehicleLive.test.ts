// VehicleLive view model: route/ETA come from the snapshot's v2 arrays, never
// from a producer-side schedule.

import { describe, expect, it } from 'vitest';
import { decode, NO_ETA, NO_ROUTE } from '../engine/snapshot';
import { encodeStub } from '../engine/stub';
import { stubWorld } from '../engine/world';
import { standingAt, vehicleLive } from './vehicleLive';

const world = stubWorld(42);

/** Snapshot from the stub producer with one vehicle's v2 fields overridden. */
function snapWith(v: number, route: number, progress: number, eta: number) {
  const s = decode(encodeStub(7, 40));
  s.vehRoute![v] = route;
  s.vehProgress![v] = progress;
  s.vehEta![v] = eta;
  return s;
}

describe('vehicleLive', () => {
  it('reads the assigned route and ETA from the snapshot', () => {
    const s = snapWith(0, 2, 0.5, 1000);
    const live = vehicleLive(world, s, 0);
    // route 2's ends, ordered by the vehicle's heading
    const ends = world.routes[2].ends;
    expect([live.from, live.to]).toEqual(expect.arrayContaining(ends));
    expect(live.from).not.toBe(live.to);
    expect(live.etaTick).toBe(1000);
  });

  it('degrades to unknown route/ETA on the NO_ROUTE sentinel', () => {
    const s = snapWith(0, NO_ROUTE, 0, 55);
    const live = vehicleLive(world, s, 0);
    expect(live.from).toBe('—');
    expect(live.to).toBe('—');
    expect(live.etaTick).toBe(55); // ETA is independent of the route row
  });

  it('shows no ETA while the engine reports none derivable', () => {
    const s = snapWith(0, 2, 0.5, NO_ETA);
    expect(vehicleLive(world, s, 0).etaTick).toBeNull();
  });

  it('degrades gracefully on a v1 payload without movement arrays', () => {
    const v2 = encodeStub(7, 40);
    const copy = v2.slice(0);
    const view = new DataView(copy);
    view.setUint32(16, 12, true);
    view.setUint32(4, 1, true);
    const s = decode(copy);
    const live = vehicleLive(world, s, 0);
    expect(live.from).toBe('—');
    expect(live.to).toBe('—');
    expect(live.etaTick).toBeNull();
  });

  it('treats an out-of-range route id as unknown, not a crash', () => {
    const s = snapWith(0, 999, 0.5, 70);
    const live = vehicleLive(world, s, 0);
    expect(live.from).toBe('—');
    expect(live.to).toBe('—');
  });
});

describe('standingAt', () => {
  it('names the site an idle vehicle is parked at, and nothing when it is far from any', () => {
    const site = world.sites[1];
    expect(standingAt(world, { x: site.x, y: site.y })).toBe(site.name);
    expect(standingAt(world, { x: site.x + 6, y: site.y - 4 })).toBe(site.name);
    expect(standingAt(world, { x: -500, y: -500 })).toBeNull();
  });
});
